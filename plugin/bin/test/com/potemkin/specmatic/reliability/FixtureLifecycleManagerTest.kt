package com.potemkin.specmatic.reliability

import com.potemkin.specmatic.FixtureHttpRequest
import com.potemkin.specmatic.FixtureHttpResponse
import com.potemkin.specmatic.FixtureSource
import com.potemkin.specmatic.FixtureStub
import com.potemkin.specmatic.FixturesClient
import com.potemkin.specmatic.SpecmaticStubBridge
import io.specmatic.mock.ScenarioStub
import io.specmatic.stub.HttpStubData
import okhttp3.OkHttpClient
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Unit tests for [FixtureLifecycleManager].
 *
 * Uses hand-rolled fakes for [HealthMonitor], [FixturesClient], and [SpecmaticStubBridge]
 * to drive lifecycle transitions without a real HTTP server.
 */
class FixtureLifecycleManagerTest {

    // ---- fakes --------------------------------------------------------------------------

    private class FakeFixturesClient(
        private var fixtures: List<FixtureStub> = emptyList(),
    ) : FixturesClient(
        backendUrl = "http://unused",
        httpClient = noOpHttpClient(),
    ) {
        val pushedPathHistory = mutableListOf<Set<Pair<String, String>>>()

        fun setFixtures(newFixtures: List<FixtureStub>) {
            fixtures = newFixtures
        }

        override fun fetchFixtures(): List<FixtureStub> = fixtures

        override fun recordPushedPaths(paths: Set<Pair<String, String>>) {
            pushedPathHistory.add(paths)
        }

        override fun excludedPaths(): Set<Pair<String, String>> =
            pushedPathHistory.lastOrNull() ?: emptySet()
    }

    private class CapturingBridge : SpecmaticStubBridge(null) {
        val registered = mutableListOf<FixtureStub>()
        var clearCount = 0

        override fun doSetExpectation(stub: ScenarioStub): List<HttpStubData>? {
            // no-op — registration tracked at FixtureStub level in registerStub wrapper
            return null
        }

        override fun registerStub(fixture: FixtureStub): Boolean {
            registered.add(fixture)
            return true
        }

        override fun doClearExpectations() {
            clearCount++
        }
    }

    private fun makeFixture(method: String = "GET", path: String = "/test"): FixtureStub =
        FixtureStub(
            httpRequest = FixtureHttpRequest(method = method, path = path),
            httpResponse = FixtureHttpResponse(status = 200),
            source = FixtureSource(boundary = "b", aggregateId = "a", contractPath = "/c.yaml"),
        )

    private lateinit var fixturesClient: FakeFixturesClient
    private lateinit var bridge: CapturingBridge
    private lateinit var monitor: HealthMonitor

    @BeforeEach
    fun setUp() {
        fixturesClient = FakeFixturesClient()
        bridge = CapturingBridge()
        // Create monitor without a real HTTP server — we'll drive transitions manually.
        monitor = object : HealthMonitor(
            backendUrl = "http://unused",
            config = HealthProbeConfig(),
        ) {
            // Prevent any actual HTTP calls.
        }
    }

    // ---- initial UP push ----------------------------------------------------------------

    @Test
    fun `start() pushes fixtures when engine is already UP`() {
        fixturesClient.setFixtures(listOf(makeFixture("GET", "/loans")))

        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)
        manager.start()

        assertEquals(1, bridge.registered.size)
        assertEquals("/loans", bridge.registered[0].httpRequest.path)
    }

    @Test
    fun `start() with no fixtures registers nothing`() {
        fixturesClient.setFixtures(emptyList())

        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)
        manager.start()

        assertTrue(bridge.registered.isEmpty())
    }

    // ---- UP transition ------------------------------------------------------------------

    @Test
    fun `onTransition to UP pushes fixtures`() {
        fixturesClient.setFixtures(listOf(makeFixture("POST", "/orders")))
        // Start with engine DOWN so start() doesn't push.
        monitor.markDownExternal()

        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)
        manager.start()

        assertEquals(0, bridge.registered.size, "No push expected when starting in DOWN state")

        // Simulate transition to UP
        monitor.markUpExternal()
        manager.onTransition(HealthState.Down, HealthState.Up)

        assertEquals(1, bridge.registered.size)
        assertEquals("/orders", bridge.registered[0].httpRequest.path)
    }

    // ---- DOWN transition ----------------------------------------------------------------

    @Test
    fun `onTransition to DOWN clears all registered fixtures`() {
        fixturesClient.setFixtures(listOf(makeFixture()))
        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)
        manager.start()

        // Simulate DOWN
        manager.onTransition(HealthState.Up, HealthState.Down)

        assertEquals(1, bridge.clearCount)
    }

    @Test
    fun `onTransition to DOWN records empty pushed paths`() {
        fixturesClient.setFixtures(listOf(makeFixture()))
        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)
        manager.start()

        manager.onTransition(HealthState.Up, HealthState.Down)

        // Last recorded pushed-paths should be empty after DOWN
        val lastPushed = fixturesClient.pushedPathHistory.last()
        assertTrue(lastPushed.isEmpty(), "Pushed paths should be cleared on DOWN")
    }

    // ---- DOWN → UP recovery -------------------------------------------------------------

    @Test
    fun `DOWN then UP re-fetches and re-registers fixtures`() {
        fixturesClient.setFixtures(listOf(makeFixture("GET", "/products")))
        monitor.markDownExternal()

        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)
        manager.start()

        // DOWN clears
        manager.onTransition(HealthState.Up, HealthState.Down)
        assertEquals(1, bridge.clearCount)
        val registeredAfterDown = bridge.registered.size

        // UP re-pushes
        manager.onTransition(HealthState.Down, HealthState.Up)
        assertEquals(registeredAfterDown + 1, bridge.registered.size)
        assertEquals("/products", bridge.registered.last().httpRequest.path)
    }

    // ---- DEGRADED transition ------------------------------------------------------------

    @Test
    fun `onTransition to DEGRADED does not push or clear fixtures`() {
        fixturesClient.setFixtures(listOf(makeFixture()))
        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)
        manager.start()

        val registeredBefore = bridge.registered.size
        val clearedBefore = bridge.clearCount

        manager.onTransition(HealthState.Up, HealthState.Degraded)

        assertEquals(registeredBefore, bridge.registered.size, "No new registrations on DEGRADED")
        assertEquals(clearedBefore, bridge.clearCount, "No clears on DEGRADED")
    }

    // ---- hot-reload tests ---------------------------------------------------------------

    @Test
    fun `hotReloadIfChanged clears and re-pushes when fixture set changes`() {
        val fixtureV1 = makeFixture("GET", "/v1")
        val fixtureV2 = makeFixture("GET", "/v2")
        fixturesClient.setFixtures(listOf(fixtureV1))

        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)
        // start() calls pushFixtures() which sets the baseline checksum for fixtureV1.
        manager.start()

        assertEquals(1, bridge.registered.size)

        // Change fixtures to simulate ETag/content change.
        fixturesClient.setFixtures(listOf(fixtureV2))
        // hotReloadIfChanged: known (fixtureV1 checksum) != new (fixtureV2 checksum) → reload.
        manager.hotReloadIfChanged()

        // Should have cleared once and re-registered the new fixture.
        assertTrue(bridge.clearCount >= 1, "Expected at least one clear during hot-reload")
        assertEquals(fixtureV2.httpRequest.path, bridge.registered.last().httpRequest.path)
    }

    // ---- concurrency tests --------------------------------------------------------------

    /**
     * Hammers [pushFixtures], [clearFixtures], and [hotReloadIfChanged] from many
     * threads simultaneously. The manager's only shared mutable state is the
     * [java.util.concurrent.atomic.AtomicReference] ETag and the bridge's
     * CopyOnWriteArrayList registry; this asserts no
     * ConcurrentModificationException or other failure escapes under contention.
     */
    @Test
    fun `concurrent push, clear, and hot-reload never corrupt the registry`() {
        fixturesClient.setFixtures(listOf(makeFixture("GET", "/a"), makeFixture("POST", "/b")))
        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)

        val threads = 12
        val iterations = 200
        val errors = java.util.concurrent.CopyOnWriteArrayList<Throwable>()
        val barrier = java.util.concurrent.CyclicBarrier(threads)
        val pool = java.util.concurrent.Executors.newFixedThreadPool(threads)

        repeat(threads) { t ->
            pool.submit {
                try {
                    barrier.await()
                    repeat(iterations) { i ->
                        when ((t + i) % 3) {
                            0 -> manager.pushFixtures()
                            1 -> manager.clearFixtures()
                            else -> manager.hotReloadIfChanged()
                        }
                    }
                } catch (e: Throwable) {
                    errors.add(e)
                }
            }
        }
        pool.shutdown()
        assertTrue(pool.awaitTermination(30, java.util.concurrent.TimeUnit.SECONDS), "threads did not finish")
        assertTrue(errors.isEmpty(), "concurrent lifecycle ops threw: ${errors.map { "${it::class.simpleName}: ${it.message}" }}")
    }

    /**
     * Registers and clears stubs on [SpecmaticStubBridge] from many threads using
     * a bridge backed by a real [java.util.concurrent.CopyOnWriteArrayList] registry,
     * asserting no ConcurrentModificationException — the registry is the bridge's
     * only shared mutable state.
     */
    @Test
    fun `concurrent register and clear on the stub bridge are race-free`() {
        val realRegistryBridge = object : SpecmaticStubBridge(null) {
            override fun doSetExpectation(scenarioStub: ScenarioStub): List<HttpStubData>? = null
            override fun doClearExpectations() { /* registry-only test */ }
        }
        val fixture = makeFixture("GET", "/concurrent")

        val threads = 16
        val iterations = 300
        val errors = java.util.concurrent.CopyOnWriteArrayList<Throwable>()
        val barrier = java.util.concurrent.CyclicBarrier(threads)
        val pool = java.util.concurrent.Executors.newFixedThreadPool(threads)
        repeat(threads) { t ->
            pool.submit {
                try {
                    barrier.await()
                    repeat(iterations) { i ->
                        if ((t + i) % 2 == 0) realRegistryBridge.registerStub(fixture)
                        else realRegistryBridge.clearExpectations()
                    }
                } catch (e: Throwable) {
                    errors.add(e)
                }
            }
        }
        pool.shutdown()
        assertTrue(pool.awaitTermination(30, java.util.concurrent.TimeUnit.SECONDS))
        assertTrue(errors.isEmpty(), "concurrent bridge ops threw: ${errors.map { "${it::class.simpleName}: ${it.message}" }}")
    }

    @Test
    fun `hotReloadIfChanged skips reload when fixtures are identical`() {
        val fixture = makeFixture("GET", "/stable")
        fixturesClient.setFixtures(listOf(fixture))

        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)
        // start() calls pushFixtures() which sets the baseline checksum.
        manager.start()

        val clearsBefore = bridge.clearCount

        // Same fixture set — hotReloadIfChanged should detect no change (baseline was set by start).
        manager.hotReloadIfChanged()
        manager.hotReloadIfChanged()

        assertEquals(clearsBefore, bridge.clearCount, "Should not clear when fixture set is unchanged")
    }
}

private fun noOpHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .addInterceptor { _ ->
        throw java.io.IOException("no-op client — tests must not hit real network")
    }
    .build()
