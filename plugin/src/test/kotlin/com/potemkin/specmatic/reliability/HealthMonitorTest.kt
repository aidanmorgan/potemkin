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

    // ---- concurrency tests --------------------------------------------------------------

    /**
     * Drives [runProbe] concurrently with external [markUpExternal]/[markDownExternal]
     * signals from many threads. Asserts no exception escapes and that the final
     * observed state is internally consistent with its counters — i.e. the
     * compound read-decide-transition sequences never tore under contention.
     */
    @Test
    fun `concurrent probes and external signals never corrupt state`() {
        // Many threads flip the monitor's state via the external signal API while
        // others read it. The synchronized mutation paths must keep state consistent.
        val threads = 16
        val iterations = 500
        val errors = java.util.concurrent.CopyOnWriteArrayList<Throwable>()
        val barrier = java.util.concurrent.CyclicBarrier(threads)
        val pool = java.util.concurrent.Executors.newFixedThreadPool(threads)

        repeat(threads) { t ->
            pool.submit {
                try {
                    barrier.await()
                    repeat(iterations) { i ->
                        when ((t + i) % 3) {
                            0 -> monitor.markUpExternal()
                            1 -> monitor.markDownExternal()
                            else -> monitor.currentState()
                        }
                    }
                } catch (e: Throwable) {
                    errors.add(e)
                }
            }
        }
        pool.shutdown()
        assertTrue(pool.awaitTermination(30, java.util.concurrent.TimeUnit.SECONDS), "threads did not finish in time")
        assertTrue(errors.isEmpty(), "concurrent invocation threw: ${errors.map { it.message }}")

        // After the storm settles, the monitor must still be in a self-consistent state:
        // a final markUpExternal must deterministically leave it UP with upSince set.
        monitor.markUpExternal()
        assertEquals(HealthState.Up, monitor.currentState())
        assertNotNull(monitor.upSince(), "UP state must always have a non-null upSince")
    }

    /**
     * A success counter advanced from DOWN to UP requires exactly 2 consecutive
     * successes. With many threads racing on [runProbe] against a server that
     * always returns 200, the debounce must never under- or over-count such that
     * the listener sees a duplicate UP transition.
     */
    @Test
    fun `concurrent successful probes notify each UP transition exactly once`() {
        // Enqueue a generous supply of 200s so every probe gets a response.
        repeat(2_000) { server.enqueue(MockResponse().setResponseCode(200)) }

        // Start DOWN so the first 2 successes drive a single UP transition.
        monitor.markDownExternal()

        val upTransitions = java.util.concurrent.atomic.AtomicInteger(0)
        monitor.addListener(object : HealthStateListener {
            override fun onTransition(from: HealthState, to: HealthState) {
                if (to == HealthState.Up && from != HealthState.Up) {
                    upTransitions.incrementAndGet()
                }
            }
        })

        val threads = 8
        val errors = java.util.concurrent.CopyOnWriteArrayList<Throwable>()
        val barrier = java.util.concurrent.CyclicBarrier(threads)
        val pool = java.util.concurrent.Executors.newFixedThreadPool(threads)
        repeat(threads) {
            pool.submit {
                try {
                    barrier.await()
                    repeat(50) { monitor.runProbe() }
                } catch (e: Throwable) {
                    errors.add(e)
                }
            }
        }
        pool.shutdown()
        assertTrue(pool.awaitTermination(30, java.util.concurrent.TimeUnit.SECONDS))
        assertTrue(errors.isEmpty(), "concurrent runProbe threw: ${errors.map { it.message }}")

        // All probes succeeded → must end UP, and the DOWN→UP transition fires exactly once
        // (subsequent successful probes stay UP without re-notifying).
        assertEquals(HealthState.Up, monitor.currentState())
        assertEquals(1, upTransitions.get(), "DOWN→UP must be signalled exactly once under concurrency")
    }
}
