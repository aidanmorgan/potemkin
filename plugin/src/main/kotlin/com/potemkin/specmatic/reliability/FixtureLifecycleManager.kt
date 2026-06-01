package com.potemkin.specmatic.reliability

import com.potemkin.specmatic.FixtureStub
import com.potemkin.specmatic.FixturesClient
import com.potemkin.specmatic.SpecmaticStubBridge
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.slf4j.LoggerFactory
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Subscribes to [HealthMonitor] state transitions and manages the lifecycle of
 * DSL-derived fixture stubs registered with Specmatic via [SpecmaticStubBridge].
 *
 * Behaviour:
 *  - **UP** (initial or recovery): fetch all fixtures from the engine, push each via
 *    [SpecmaticStubBridge.registerStub], record the pushed (method, path) set and the
 *    last-seen ETag.
 *  - **DOWN**: unregister all pushed stubs via [SpecmaticStubBridge.clearExpectations],
 *    clear the pushed-paths tracking in [FixturesClient].
 *  - **Periodic hot-reload** (while UP): re-fetch fixtures every [refreshIntervalMs].
 *    If the ETag has changed, unregister the old set and push the new set.
 *
 * The refresh loop runs on [Dispatchers.IO] inside a [SupervisorJob].
 */
class FixtureLifecycleManager(
    private val monitor: HealthMonitor,
    private val fixturesClient: FixturesClient,
    private val bridge: SpecmaticStubBridge,
    private val refreshIntervalMs: Long = 30_000L,
) : HealthStateListener {

    private val log = LoggerFactory.getLogger(FixtureLifecycleManager::class.java)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var refreshJob: Job? = null

    /**
     * Monotonically increasing sequence number. Incremented on every onTransition() call.
     * Each dispatched coroutine captures the sequence number at launch time and checks it
     * BOTH before performing I/O (fast bail-out) AND after the I/O completes (the
     * load-bearing guard) — preventing a stale push from clobbering a newer clear even
     * when the newer transition completes while the older one is blocked in fetchFixtures.
     */
    private val transitionSeq = AtomicLong(0L)

    /**
     * Serialises the apply/commit step of push and clear operations so they execute in
     * strictly the order their coroutines acquire the lock. Combined with the post-I/O
     * seq re-check, this guarantees the final state always reflects the latest transition.
     */
    private val transitionMutex = Mutex()

    /**
     * Last change signal seen from the fixtures endpoint, used to detect hot-reload changes.
     * Prefers the HTTP ETag exposed by [FixturesClient.lastEtag]; falls back to a content
     * hash of the fixture list when the server omits an ETag.
     */
    private val lastSignal = AtomicReference<String?>(null)

    // ---- public API ----------------------------------------------------------------------

    fun start() {
        // Perform an initial push if the engine is already UP at plugin boot.
        if (monitor.currentState() == HealthState.Up) {
            pushFixtures()
        }
        startRefreshLoop()
    }

    fun stop() {
        refreshJob?.cancel()
    }

    override fun onTransition(from: HealthState, to: HealthState) {
        // Increment the sequence number before dispatching so any in-flight coroutine
        // from a prior transition can detect it is stale and exit without acting.
        val seq = transitionSeq.incrementAndGet()
        when (to) {
            HealthState.Up -> {
                log.info("FixtureLifecycleManager: engine UP — dispatching fixture push (seq={})", seq)
                scope.launch {
                    // Fast bail-out: skip I/O entirely if already superseded.
                    if (transitionSeq.get() != seq) return@launch
                    // Perform the blocking fetch OUTSIDE the mutex so the Down coroutine
                    // can acquire the mutex and clear without waiting for the slow fetch.
                    val fixtures = safelyFetch() ?: return@launch
                    val signal = changeSignal(fixtures)
                    // Acquire the mutex to serialize the apply step, then re-check seq
                    // to discard results from a fetch that was superseded during I/O.
                    transitionMutex.withLock {
                        if (transitionSeq.get() != seq) {
                            log.debug(
                                "FixtureLifecycleManager: UP push (seq={}) superseded after fetch — discarding",
                                seq,
                            )
                            return@withLock
                        }
                        applyPush(fixtures, signal)
                    }
                }
            }
            HealthState.Down -> {
                log.info("FixtureLifecycleManager: engine DOWN — dispatching fixture clear (seq={})", seq)
                scope.launch {
                    if (transitionSeq.get() != seq) return@launch
                    transitionMutex.withLock {
                        if (transitionSeq.get() != seq) return@withLock
                        clearFixtures()
                    }
                }
            }
            HealthState.Degraded -> {
                // No action on DEGRADED — keep existing fixtures registered.
            }
        }
    }

    // ---- internal helpers ----------------------------------------------------------------

    private fun startRefreshLoop() {
        refreshJob = scope.launch {
            while (isActive) {
                delay(refreshIntervalMs)
                if (monitor.currentState() == HealthState.Up) {
                    hotReloadIfChanged()
                }
            }
        }
    }

    /**
     * Computes the change signal for a freshly fetched [fixtures] list. Uses the ETag from
     * the last fixtures response when the server supplied one; otherwise falls back to the
     * order-insensitive content hash of the fixture set.
     *
     * Must be called immediately after [FixturesClient.fetchFixtures] so that
     * [FixturesClient.lastEtag] reflects the same response that produced [fixtures].
     */
    private fun changeSignal(fixtures: List<FixtureStub>): String {
        val etag = fixturesClient.lastEtag()
        if (!etag.isNullOrBlank()) {
            return "etag:$etag"
        }
        return "hash:${fixtures.toHashSet().hashCode()}"
    }

    /** Fetch fixtures and return them, or null on error. Used by the coroutine UP path. */
    private fun safelyFetch(): List<FixtureStub>? {
        return try {
            fixturesClient.fetchFixtures()
        } catch (e: Exception) {
            log.warn("FixtureLifecycleManager: failed to fetch fixtures: {}", e.message, e)
            null
        }
    }

    /**
     * Apply a freshly fetched [fixtures] list with its pre-computed [signal].
     * Must be called while [transitionMutex] is held and the seq re-check has passed.
     */
    private fun applyPush(fixtures: List<FixtureStub>, signal: String) {
        try {
            lastSignal.set(signal)
            val pushed = mutableSetOf<Pair<String, String>>()
            var count = 0
            for (fixture in fixtures) {
                if (bridge.registerStub(fixture)) {
                    pushed.add(fixture.httpRequest.method.uppercase() to fixture.httpRequest.path)
                    count++
                }
            }
            fixturesClient.recordPushedPaths(pushed)
            log.info("FixtureLifecycleManager: registered {} fixture(s)", count)
        } catch (e: Exception) {
            log.warn("FixtureLifecycleManager: failed to apply fixture push: {}", e.message, e)
        }
    }

    internal fun pushFixtures() {
        try {
            val fixtures = fixturesClient.fetchFixtures()
            // Record the current change signal so hotReloadIfChanged can detect subsequent changes.
            val signal = changeSignal(fixtures)
            applyPush(fixtures, signal)
        } catch (e: Exception) {
            log.warn("FixtureLifecycleManager: failed to push fixtures: {}", e.message, e)
        }
    }

    internal fun clearFixtures() {
        try {
            bridge.clearExpectations()
            fixturesClient.recordPushedPaths(emptySet())
            lastSignal.set(null)
            log.info("FixtureLifecycleManager: cleared all registered fixtures")
        } catch (e: Exception) {
            log.warn("FixtureLifecycleManager: failed to clear fixtures: {}", e.message, e)
        }
    }

    internal fun hotReloadIfChanged() {
        try {
            val fixtures = fixturesClient.fetchFixtures()
            // Prefer the HTTP ETag as the change signal; fall back to a content hash only
            // when the server omits an ETag.
            val newSignal = changeSignal(fixtures)
            val known = lastSignal.getAndSet(newSignal)

            if (known == null) {
                // First call — record the baseline signal; no reload needed.
                log.debug("FixtureLifecycleManager: hot-reload baseline set (signal={})", newSignal)
                return
            }

            if (known == newSignal) {
                log.debug("FixtureLifecycleManager: fixtures unchanged (signal match), skipping hot-reload")
                return
            }

            log.info("FixtureLifecycleManager: fixture change detected — hot-reloading")
            bridge.clearExpectations()
            val pushed = mutableSetOf<Pair<String, String>>()
            var count = 0
            for (fixture in fixtures) {
                if (bridge.registerStub(fixture)) {
                    pushed.add(fixture.httpRequest.method.uppercase() to fixture.httpRequest.path)
                    count++
                }
            }
            fixturesClient.recordPushedPaths(pushed)
            log.info("FixtureLifecycleManager: hot-reload complete — {} fixture(s) registered", count)
        } catch (e: Exception) {
            log.warn("FixtureLifecycleManager: hot-reload failed: {}", e.message, e)
        }
    }
}
