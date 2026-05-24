package com.potemkin.specmatic.reliability

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Unit tests for [HealthMonitor].
 *
 * Uses [MockWebServer] to simulate the engine's `/_engine/health` endpoint.
 * Tests call [HealthMonitor.runProbe] directly rather than relying on the
 * coroutine timer, keeping tests fast and deterministic.
 */
class HealthMonitorTest {

    private lateinit var server: MockWebServer
    private lateinit var monitor: HealthMonitor

    @BeforeEach
    fun setUp() {
        server = MockWebServer()
        server.start()
        monitor = HealthMonitor(
            backendUrl = "http://${server.hostName}:${server.port}",
            config = HealthProbeConfig(initialMs = 250L, stableMs = 30_000L),
        )
    }

    @AfterEach
    fun tearDown() {
        server.shutdown()
    }

    // ---- transition tests ---------------------------------------------------------------

    @Test
    fun `initial state is UP`() {
        assertEquals(HealthState.Up, monitor.currentState())
    }

    @Test
    fun `UP to DEGRADED on first failure`() {
        server.enqueue(MockResponse().setResponseCode(500))
        monitor.runProbe()
        assertEquals(HealthState.Degraded, monitor.currentState())
    }

    @Test
    fun `DEGRADED to DOWN after 3 consecutive failures`() {
        // First failure: UP → DEGRADED
        server.enqueue(MockResponse().setResponseCode(500))
        monitor.runProbe()
        assertEquals(HealthState.Degraded, monitor.currentState())

        // Second failure: stays DEGRADED (only 2 total)
        server.enqueue(MockResponse().setResponseCode(500))
        monitor.runProbe()
        assertEquals(HealthState.Degraded, monitor.currentState())

        // Third failure: DEGRADED → DOWN
        server.enqueue(MockResponse().setResponseCode(500))
        monitor.runProbe()
        assertEquals(HealthState.Down, monitor.currentState())
    }

    @Test
    fun `DEGRADED to UP on single success`() {
        // Go to DEGRADED
        server.enqueue(MockResponse().setResponseCode(500))
        monitor.runProbe()
        assertEquals(HealthState.Degraded, monitor.currentState())

        // One success recovers from DEGRADED
        server.enqueue(MockResponse().setResponseCode(200))
        monitor.runProbe()
        assertEquals(HealthState.Up, monitor.currentState())
    }

    @Test
    fun `DOWN to UP requires 2 consecutive successes (debounce)`() {
        // Go to DOWN
        repeat(3) {
            server.enqueue(MockResponse().setResponseCode(500))
            monitor.runProbe()
        }
        assertEquals(HealthState.Down, monitor.currentState())

        // One success: not yet UP
        server.enqueue(MockResponse().setResponseCode(200))
        monitor.runProbe()
        assertEquals(HealthState.Down, monitor.currentState(), "1 success from DOWN should not transition to UP")

        // Second success: transitions to UP
        server.enqueue(MockResponse().setResponseCode(200))
        monitor.runProbe()
        assertEquals(HealthState.Up, monitor.currentState())
    }

    @Test
    fun `single success does not transition DOWN to UP`() {
        // Drive to DOWN
        repeat(3) {
            server.enqueue(MockResponse().setResponseCode(500))
            monitor.runProbe()
        }
        assertEquals(HealthState.Down, monitor.currentState())

        // 1 success — should stay DOWN
        server.enqueue(MockResponse().setResponseCode(200))
        monitor.runProbe()
        assertEquals(HealthState.Down, monitor.currentState())
    }

    // ---- listener tests -----------------------------------------------------------------

    @Test
    fun `listener is notified on transitions`() {
        val transitions = mutableListOf<Pair<HealthState, HealthState>>()
        monitor.addListener(object : HealthStateListener {
            override fun onTransition(from: HealthState, to: HealthState) {
                transitions.add(from to to)
            }
        })

        server.enqueue(MockResponse().setResponseCode(500))
        monitor.runProbe()

        assertEquals(1, transitions.size)
        assertEquals(HealthState.Up to HealthState.Degraded, transitions[0])
    }

    @Test
    fun `listener not called when state unchanged`() {
        val transitions = mutableListOf<Pair<HealthState, HealthState>>()
        monitor.addListener(object : HealthStateListener {
            override fun onTransition(from: HealthState, to: HealthState) {
                transitions.add(from to to)
            }
        })

        // Two successes when already UP — no transition expected
        server.enqueue(MockResponse().setResponseCode(200))
        monitor.runProbe()
        server.enqueue(MockResponse().setResponseCode(200))
        monitor.runProbe()

        assertEquals(0, transitions.size)
    }

    // ---- external signal tests ----------------------------------------------------------

    @Test
    fun `markDownExternal transitions to DOWN immediately`() {
        assertEquals(HealthState.Up, monitor.currentState())
        monitor.markDownExternal()
        assertEquals(HealthState.Down, monitor.currentState())
    }

    @Test
    fun `markUpExternal transitions to UP immediately`() {
        monitor.markDownExternal()
        assertEquals(HealthState.Down, monitor.currentState())
        monitor.markUpExternal()
        assertEquals(HealthState.Up, monitor.currentState())
    }

    @Test
    fun `markDownExternal notifies listeners`() {
        val transitions = mutableListOf<Pair<HealthState, HealthState>>()
        monitor.addListener(object : HealthStateListener {
            override fun onTransition(from: HealthState, to: HealthState) {
                transitions.add(from to to)
            }
        })
        monitor.markDownExternal()
        assertEquals(1, transitions.size)
        assertEquals(HealthState.Up to HealthState.Down, transitions[0])
    }

    @Test
    fun `markUpExternal notifies listeners`() {
        monitor.markDownExternal()
        val transitions = mutableListOf<Pair<HealthState, HealthState>>()
        monitor.addListener(object : HealthStateListener {
            override fun onTransition(from: HealthState, to: HealthState) {
                transitions.add(from to to)
            }
        })
        monitor.markUpExternal()
        assertEquals(1, transitions.size)
        assertEquals(HealthState.Down to HealthState.Up, transitions[0])
    }

    // ---- adaptive interval tests --------------------------------------------------------

    @Test
    fun `probe interval is short when DOWN`() {
        monitor.markDownExternal()
        val interval = monitor.probeIntervalMs()
        assertEquals(250L, interval, "DOWN probe interval should equal healthProbeInitialMs (250 ms)")
    }

    @Test
    fun `probe interval is 1000ms when DEGRADED`() {
        server.enqueue(MockResponse().setResponseCode(500))
        monitor.runProbe()
        assertEquals(HealthState.Degraded, monitor.currentState())
        val interval = monitor.probeIntervalMs()
        assertEquals(1_000L, interval)
    }

    @Test
    fun `probe interval is 2000ms when UP and recently stabilised`() {
        // UP, upSince just set — should be 2 s
        val interval = monitor.probeIntervalMs()
        assertEquals(2_000L, interval)
    }

    // ---- upSince tests ------------------------------------------------------------------

    @Test
    fun `upSince is set when UP`() {
        assertNotNull(monitor.upSince())
    }

    @Test
    fun `upSince is null when DOWN`() {
        monitor.markDownExternal()
        assertNull(monitor.upSince())
    }

    @Test
    fun `upSince is reset when recovering from DOWN to UP`() {
        monitor.markDownExternal()
        assertNull(monitor.upSince())
        monitor.markUpExternal()
        assertNotNull(monitor.upSince())
    }

    // ---- connection failure tests -------------------------------------------------------

    @Test
    fun `connection refused counts as probe failure`() {
        // Shut the server down so the probe gets a connection refused.
        server.shutdown()
        monitor.runProbe()
        assertEquals(HealthState.Degraded, monitor.currentState())
    }
}
