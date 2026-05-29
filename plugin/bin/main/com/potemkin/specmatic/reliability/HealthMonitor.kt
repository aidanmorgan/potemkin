package com.potemkin.specmatic.reliability

import com.potemkin.specmatic.PluginConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import org.slf4j.LoggerFactory
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * Adaptive coroutine-scheduled health monitor that probes the Node engine's
 * `GET /_engine/health` endpoint and tracks liveness as [HealthState].
 *
 * Probe intervals are adaptive:
 *  - DOWN:                   [config.healthProbeInitialMs] (default 250 ms)
 *  - DEGRADED:               1 000 ms
 *  - UP, stable < 1 min:     2 000 ms
 *  - UP, stable 1–5 min:     10 000 ms
 *  - UP, stable > 5 min:     [config.healthProbeStableMs] (default 30 000 ms)
 *
 * The probe loop runs on [Dispatchers.IO] inside a [SupervisorJob] so that a single
 * probe failure never crashes the loop.
 *
 * Thread-safety: all mutable state (state, counters, upSince) is held in
 * [AtomicReference]/[AtomicInteger] or volatile fields. Listener callbacks are
 * invoked synchronously from the probe coroutine.
 */
open class HealthMonitor(
    private val backendUrl: String,
    private val config: HealthProbeConfig = HealthProbeConfig(),
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(1, TimeUnit.SECONDS)
        .readTimeout(1, TimeUnit.SECONDS)
        .build(),
) {
    private val log = LoggerFactory.getLogger(HealthMonitor::class.java)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var probeJob: Job? = null

    private val state = AtomicReference<HealthState>(HealthState.Up)
    private val consecutiveFailures = AtomicInteger(0)
    private val consecutiveSuccesses = AtomicInteger(0)
    private val upSince = AtomicReference<Instant?>(Instant.now())

    private val listeners = CopyOnWriteArrayList<HealthStateListener>()

    // ---- lifecycle -----------------------------------------------------------------------

    fun start() {
        log.info("HealthMonitor: starting probe loop for {}", backendUrl)
        probeJob = scope.launch {
            while (isActive) {
                val intervalMs = probeIntervalMs()
                delay(intervalMs)
                runProbe()
            }
        }
    }

    fun stop() {
        log.info("HealthMonitor: stopping probe loop")
        probeJob?.cancel()
        scope.cancel()
    }

    // ---- public API ----------------------------------------------------------------------

    open fun currentState(): HealthState = state.get()

    fun addListener(listener: HealthStateListener) {
        listeners.add(listener)
    }

    /**
     * Called by the control endpoint when a `/shutdown` notification arrives.
     * Immediately transitions to DOWN without waiting for the next probe.
     */
    open fun markDownExternal() {
        log.info("HealthMonitor: external DOWN signal received")
        consecutiveFailures.set(3)
        consecutiveSuccesses.set(0)
        transition(HealthState.Down)
    }

    /**
     * Called by the control endpoint when a `/ready` notification arrives.
     * Immediately transitions to UP without waiting for the next probe.
     */
    open fun markUpExternal() {
        log.info("HealthMonitor: external UP signal received")
        consecutiveFailures.set(0)
        consecutiveSuccesses.set(2)
        transition(HealthState.Up)
    }

    // ---- internal probe logic ------------------------------------------------------------

    internal fun runProbe() {
        val success = doProbe()
        if (success) {
            consecutiveFailures.set(0)
            val succ = consecutiveSuccesses.incrementAndGet()
            when (state.get()) {
                HealthState.Down -> {
                    if (succ >= 2) {
                        transition(HealthState.Up)
                    }
                }
                HealthState.Degraded -> transition(HealthState.Up)
                HealthState.Up -> { /* stay */ }
            }
        } else {
            consecutiveSuccesses.set(0)
            val failures = consecutiveFailures.incrementAndGet()
            when (state.get()) {
                HealthState.Up -> transition(HealthState.Degraded)
                HealthState.Degraded -> {
                    if (failures >= 3) {
                        transition(HealthState.Down)
                    }
                }
                HealthState.Down -> { /* stay */ }
            }
        }
    }

    private fun transition(newState: HealthState) {
        val old = state.getAndSet(newState)
        if (old == newState) return
        if (newState == HealthState.Up) {
            upSince.set(Instant.now())
        } else if (old == HealthState.Up) {
            upSince.set(null)
        }
        log.info("HealthMonitor: state transition {} → {}", old, newState)
        for (listener in listeners) {
            try {
                listener.onTransition(old, newState)
            } catch (e: Exception) {
                log.error("HealthMonitor: listener threw during transition {} → {}: {}", old, newState, e.message, e)
            }
        }
    }

    private fun doProbe(): Boolean {
        val request = Request.Builder()
            .url("$backendUrl/_engine/health")
            .get()
            .build()
        return try {
            httpClient.newCall(request).execute().use { resp ->
                resp.code in 200..299
            }
        } catch (e: Exception) {
            log.debug("HealthMonitor: probe failed: {}", e.message)
            false
        }
    }

    internal fun probeIntervalMs(): Long {
        return when (state.get()) {
            HealthState.Down -> config.initialMs
            HealthState.Degraded -> 1_000L
            HealthState.Up -> {
                val since = upSince.get() ?: return 2_000L
                val stableMs = Duration.between(since, Instant.now()).toMillis()
                when {
                    stableMs > 5 * 60_000L -> config.stableMs
                    stableMs > 60_000L -> 10_000L
                    else -> 2_000L
                }
            }
        }
    }

    open fun upSince(): Instant? = upSince.get()
}

/**
 * Configuration for [HealthMonitor] probe intervals.
 *
 * @param initialMs Probe interval when DOWN (ms). Default 250.
 * @param stableMs  Probe interval when UP and stable for >5 min (ms). Default 30 000.
 */
data class HealthProbeConfig(
    val initialMs: Long = 250L,
    val stableMs: Long = 30_000L,
) {
    companion object {
        fun from(config: PluginConfig) = HealthProbeConfig(
            initialMs = config.healthProbeInitialMs,
            stableMs = config.healthProbeStableMs,
        )
    }
}
