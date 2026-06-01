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

        /** When set, [lastEtag] returns this; when null, the client behaves as if the server omitted an ETag. */
        private var etag: String? = null

        fun setFixtures(newFixtures: List<FixtureStub>) {
            fixtures = newFixtures
        }

        fun setEtag(newEtag: String?) {
            etag = newEtag
        }

        override fun fetchFixtures(): List<FixtureStub> = fixtures

        override fun lastEtag(): String? = etag

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

    // ---- helpers ------------------------------------------------------------------------

    /** Polls [condition] every 20 ms until true, or fails after [timeoutMs]. */
    private fun awaitCondition(timeoutMs: Long = 2_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(20)
        }
        assertTrue(condition(), "Condition not met within ${timeoutMs}ms")
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

    @Test
    fun `start() initial push goes through the seq+mutex scheme and is ordered before a following clear`() {
        // start()'s initial push participates in the transitionSeq + transitionMutex
        // scheme (it no longer bypasses it via a synchronous pushFixtures).
        // The initial push registers exactly once (no double-register), and a DOWN
        // transition dispatched afterwards correctly clears the booted fixtures —
        // proving the boot push and the async clear are serialized through the mutex.
        fixturesClient.setFixtures(listOf(makeFixture("GET", "/boot")))

        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)
        manager.start()

        // Exactly one registration from the boot push (no race-induced duplicate).
        assertEquals(1, bridge.registered.size)
        assertEquals("/boot", bridge.registered[0].httpRequest.path)

        // A DOWN transition (higher seq) must clear the booted fixtures.
        manager.onTransition(HealthState.Up, HealthState.Down)
        awaitCondition { bridge.clearCount >= 1 }
        assertEquals(1, bridge.clearCount)
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

        // Simulate transition to UP — push is dispatched asynchronously.
        monitor.markUpExternal()
        manager.onTransition(HealthState.Down, HealthState.Up)

        awaitCondition { bridge.registered.size >= 1 }
        assertEquals(1, bridge.registered.size)
        assertEquals("/orders", bridge.registered[0].httpRequest.path)
    }

    // ---- DOWN transition ----------------------------------------------------------------

    @Test
    fun `onTransition to DOWN clears all registered fixtures`() {
        fixturesClient.setFixtures(listOf(makeFixture()))
        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)
        manager.start()

        // Simulate DOWN — clear is dispatched asynchronously.
        manager.onTransition(HealthState.Up, HealthState.Down)

        awaitCondition { bridge.clearCount >= 1 }
        assertEquals(1, bridge.clearCount)
    }

    @Test
    fun `onTransition to DOWN records empty pushed paths`() {
        fixturesClient.setFixtures(listOf(makeFixture()))
        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)
        manager.start()

        manager.onTransition(HealthState.Up, HealthState.Down)

        // Last recorded pushed-paths should be empty after DOWN (await async dispatch).
        awaitCondition { fixturesClient.pushedPathHistory.size >= 2 }
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

        // DOWN clears — dispatched asynchronously.
        manager.onTransition(HealthState.Up, HealthState.Down)
        awaitCondition { bridge.clearCount >= 1 }
        assertEquals(1, bridge.clearCount)
        val registeredAfterDown = bridge.registered.size

        // UP re-pushes — dispatched asynchronously.
        manager.onTransition(HealthState.Down, HealthState.Up)
        awaitCondition { bridge.registered.size > registeredAfterDown }
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

    // ---- ETag-driven change detection ---------------------------------------------------

    @Test
    fun `hotReloadIfChanged skips reload when ETag is unchanged even if content hash would differ`() {
        // Same ETag but different fixture content: the ETag is authoritative, so no reload.
        fixturesClient.setEtag("\"v1\"")
        fixturesClient.setFixtures(listOf(makeFixture("GET", "/original")))

        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)
        manager.start()   // baseline signal = etag:"v1"
        val clearsBefore = bridge.clearCount

        // Content changes but the server reports the same ETag.
        fixturesClient.setFixtures(listOf(makeFixture("GET", "/changed-but-same-etag")))
        manager.hotReloadIfChanged()

        assertEquals(clearsBefore, bridge.clearCount, "Unchanged ETag must not trigger a reload")
    }

    @Test
    fun `hotReloadIfChanged reloads when ETag changes even if content hash is identical`() {
        // Identical fixture content but a new ETag: the ETag is authoritative, so reload.
        val fixture = makeFixture("GET", "/stable")
        fixturesClient.setEtag("\"v1\"")
        fixturesClient.setFixtures(listOf(fixture))

        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)
        manager.start()   // baseline signal = etag:"v1"
        val clearsBefore = bridge.clearCount

        // Same content, new ETag.
        fixturesClient.setEtag("\"v2\"")
        manager.hotReloadIfChanged()

        assertTrue(bridge.clearCount > clearsBefore, "Changed ETag must trigger a reload")
    }

    @Test
    fun `hotReloadIfChanged falls back to content hash when server omits the ETag`() {
        // No ETag at all → change detection must fall back to the fixture content hash.
        fixturesClient.setEtag(null)
        fixturesClient.setFixtures(listOf(makeFixture("GET", "/v1")))

        val manager = FixtureLifecycleManager(monitor, fixturesClient, bridge)
        manager.start()   // baseline signal = hash of [/v1]
        val clearsBefore = bridge.clearCount

        // Content changes; with no ETag the hash fallback must detect it.
        fixturesClient.setFixtures(listOf(makeFixture("GET", "/v2")))
        manager.hotReloadIfChanged()
        assertTrue(bridge.clearCount > clearsBefore, "Hash fallback must detect content change when ETag is absent")

        // Identical content again → hash fallback reports no change.
        val clearsAfterReload = bridge.clearCount
        manager.hotReloadIfChanged()
        assertEquals(clearsAfterReload, bridge.clearCount, "Hash fallback must report no change for identical content")
    }

    // ---- async dispatch tests -----------------------------------------------------------

    /**
     * onTransition() must return quickly — the blocking fixture I/O is dispatched to
     * the coroutine scope, not run inline on the caller's thread (which holds stateLock
     * in HealthMonitor). Asserts that onTransition completes in well under 500 ms even
     * when the fixture fetch itself is slow.
     */
    @Test
    fun `onTransition returns quickly without performing fixture fetch synchronously`() {
        // A fixture client that sleeps 300 ms to simulate a slow HTTP fetch.
        val slowClient = object : FixturesClient(
            backendUrl = "http://unused",
            httpClient = noOpHttpClient(),
        ) {
            override fun fetchFixtures(): List<FixtureStub> {
                Thread.sleep(300)
                return emptyList()
            }
        }
        monitor.markDownExternal()
        val manager = FixtureLifecycleManager(monitor, slowClient, bridge)
        manager.start()

        val startNs = System.nanoTime()
        manager.onTransition(HealthState.Down, HealthState.Up)
        val elapsedMs = (System.nanoTime() - startNs) / 1_000_000

        assertTrue(elapsedMs < 200, "onTransition must return in <200 ms (was ${elapsedMs} ms); fetch must be async")
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

    // ---- stale-push guard -----------------------------------------------

    /**
     * Simulates Up(seq1) → Down(seq2) where the Up push is slow and the Down clear is fast.
     *
     * Timeline:
     *  1. onTransition(Down→Up) dispatched: seq1 job starts a slow fetch (300 ms)
     *  2. onTransition(Up→Down) dispatched: seq2 job runs quickly and clears
     *  3. seq1's slow fetch completes — the re-check must detect seq is stale and NOT push
     *
     * Expected final state: CLEARED (fixtures NOT seated).
     */
    @Test
    fun `stale UP push does not clobber a subsequent DOWN clear`() {
        val fetchStarted = java.util.concurrent.CountDownLatch(1)
        val allowFetchComplete = java.util.concurrent.CountDownLatch(1)

        // A slow fixtures client: signals when the fetch begins, then blocks until released.
        val slowClient = object : FixturesClient(
            backendUrl = "http://unused",
            httpClient = noOpHttpClient(),
        ) {
            override fun fetchFixtures(): List<FixtureStub> {
                fetchStarted.countDown()
                allowFetchComplete.await()
                return listOf(makeFixture("GET", "/should-not-be-seated"))
            }

            override fun lastEtag(): String? = null

            override fun recordPushedPaths(paths: Set<Pair<String, String>>) {
                // track in bridge indirectly — bridge.registered size tells us what happened
            }

            override fun excludedPaths(): Set<Pair<String, String>> = emptySet()
        }

        monitor.markDownExternal()
        val manager = FixtureLifecycleManager(monitor, slowClient, bridge)
        manager.start()

        // seq1: dispatch the slow UP push
        manager.onTransition(HealthState.Down, HealthState.Up)

        // Wait until the fetch has started (seq1 is now blocked inside fetchFixtures)
        assertTrue(fetchStarted.await(2, java.util.concurrent.TimeUnit.SECONDS), "Fetch should start within 2s")

        // seq2: dispatch a fast DOWN clear (seq is now newer than seq1)
        manager.onTransition(HealthState.Up, HealthState.Down)

        // Wait for the clear to complete before unblocking the slow fetch
        awaitCondition(2_000) { bridge.clearCount >= 1 }

        // Now let the slow fetch complete — it should detect the stale seq and NOT push
        allowFetchComplete.countDown()

        // Give enough time for the now-unblocked seq1 coroutine to finish (if it were to push)
        Thread.sleep(200)

        // The stale UP push must NOT have registered any fixtures
        assertEquals(
            0,
            bridge.registered.size,
            "Stale UP push must not seat fixtures after a newer DOWN clear; registered=${bridge.registered.map { it.httpRequest.path }}",
        )
        // Clear must have happened exactly once
        assertEquals(1, bridge.clearCount, "DOWN clear must have run exactly once")
    }

    // ---- stop() cancels the scope -------------------------------------------------------

    /**
     * stop() must cancel the owned CoroutineScope so that any in-flight transition
     * coroutines are cancelled in addition to the refresh loop job.
     *
     * Strategy: dispatch a slow UP coroutine (fetchFixtures sleeps 500 ms), then call
     * stop() immediately. After stop() the scope is cancelled; the transition coroutine
     * must not complete its work, so no fixtures should be registered.
     */
    @Test
    fun `stop() cancels the scope so in-flight transition coroutines are cancelled`() {
        val fetchStarted = java.util.concurrent.CountDownLatch(1)

        val blockingClient = object : FixturesClient(
            backendUrl = "http://unused",
            httpClient = noOpHttpClient(),
        ) {
            override fun fetchFixtures(): List<FixtureStub> {
                fetchStarted.countDown()
                Thread.sleep(500)
                return listOf(makeFixture("GET", "/should-be-cancelled"))
            }

            override fun lastEtag(): String? = null
            override fun recordPushedPaths(paths: Set<Pair<String, String>>) {}
            override fun excludedPaths(): Set<Pair<String, String>> = emptySet()
        }

        monitor.markDownExternal()
        val manager = FixtureLifecycleManager(monitor, blockingClient, bridge)
        manager.start()

        // Dispatch a slow UP transition coroutine.
        manager.onTransition(HealthState.Down, HealthState.Up)

        // Wait until the fetch has started so the coroutine is genuinely in-flight.
        assertTrue(fetchStarted.await(2, java.util.concurrent.TimeUnit.SECONDS), "Fetch should start within 2s")

        // stop() must cancel the scope, which cancels the in-flight coroutine.
        manager.stop()

        // Give the coroutine scheduler time to propagate cancellation.
        Thread.sleep(200)

        // The cancelled coroutine must not have registered any fixtures.
        assertEquals(
            0,
            bridge.registered.size,
            "stop() must cancel in-flight coroutines; no fixtures should be registered",
        )
    }
}

private fun noOpHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .addInterceptor { _ ->
        throw java.io.IOException("no-op client — tests must not hit real network")
    }
    .build()
