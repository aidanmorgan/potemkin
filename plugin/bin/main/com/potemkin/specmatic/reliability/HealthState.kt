package com.potemkin.specmatic.reliability

/**
 * Sealed hierarchy representing the liveness state of the Node CQRS engine.
 *
 * Transitions (managed by [HealthMonitor]):
 *   UP      → DEGRADED : first probe failure
 *   DEGRADED → DOWN    : 3 consecutive failures
 *   DOWN    → UP       : 2 consecutive successes (debounce)
 *   DEGRADED → UP      : 1 success
 *
 * External transitions (from [ControlServer] notifications):
 *   any → DOWN : POST /shutdown
 *   any → UP   : POST /ready
 */
sealed class HealthState {
    object Up : HealthState() {
        override fun toString() = "UP"
    }
    object Degraded : HealthState() {
        override fun toString() = "DEGRADED"
    }
    object Down : HealthState() {
        override fun toString() = "DOWN"
    }
}

/**
 * Listener that receives state-transition notifications from [HealthMonitor].
 */
interface HealthStateListener {
    fun onTransition(from: HealthState, to: HealthState)
}
