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
import org.slf4j.LoggerFactory
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

    /** Last ETag seen from the fixtures endpoint, used to detect hot-reload changes. */
    private val lastEtag = AtomicReference<String?>(null)

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
        when (to) {
            HealthState.Up -> {
                log.info("FixtureLifecycleManager: engine UP — pushing fixtures")
                pushFixtures()
            }
            HealthState.Down -> {
                log.info("FixtureLifecycleManager: engine DOWN — clearing registered fixtures")
                clearFixtures()
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

    internal fun pushFixtures() {
        try {
            val fixtures = fixturesClient.fetchFixtures()
            // Record the current checksum so hotReloadIfChanged can detect subsequent changes.
            lastEtag.set(fixtures.hashCode().toString())
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
            log.warn("FixtureLifecycleManager: failed to push fixtures: {}", e.message, e)
        }
    }

    internal fun clearFixtures() {
        try {
            bridge.clearExpectations()
            fixturesClient.recordPushedPaths(emptySet())
            lastEtag.set(null)
            log.info("FixtureLifecycleManager: cleared all registered fixtures")
        } catch (e: Exception) {
            log.warn("FixtureLifecycleManager: failed to clear fixtures: {}", e.message, e)
        }
    }

    internal fun hotReloadIfChanged() {
        try {
            val fixtures = fixturesClient.fetchFixtures()
            // Detect changes by comparing a content checksum.
            // Use the fixture list's hashCode as a lightweight change signal when the
            // FixturesClient does not expose the raw ETag directly.
            val newChecksum = fixtures.hashCode().toString()
            val known = lastEtag.getAndSet(newChecksum)

            if (known == null) {
                // First call — record the baseline checksum; no reload needed.
                log.debug("FixtureLifecycleManager: hot-reload baseline set (checksum={})", newChecksum)
                return
            }

            if (known == newChecksum) {
                log.debug("FixtureLifecycleManager: fixtures unchanged (checksum match), skipping hot-reload")
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
