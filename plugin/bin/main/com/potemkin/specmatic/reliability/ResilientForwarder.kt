package com.potemkin.specmatic.reliability

import com.potemkin.specmatic.CqrsBackendClient
import com.potemkin.specmatic.PluginConfig
import io.github.resilience4j.circuitbreaker.CallNotPermittedException
import io.github.resilience4j.circuitbreaker.CircuitBreaker
import io.github.resilience4j.circuitbreaker.CircuitBreakerConfig
import io.github.resilience4j.circuitbreaker.CircuitBreakerRegistry
import io.github.resilience4j.retry.Retry
import io.github.resilience4j.retry.RetryConfig
import io.github.resilience4j.retry.RetryRegistry
import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.core.value.StringValue
import io.specmatic.stub.HttpStubResponse
import org.slf4j.LoggerFactory
import java.io.IOException
import java.time.Duration

/**
 * Wraps [CqrsBackendClient.forward] with a resilience4j [Retry] + [CircuitBreaker].
 *
 * Retry policy:
 *   - 3 total attempts (1 initial + 2 retries)
 *   - Exponential backoff: 50 ms → 200 ms → 800 ms (multiplier 4.0, cap 800 ms)
 *   - Retried on [EngineUnavailableException] or [IOException]
 *
 * Circuit breaker policy:
 *   - COUNT_BASED sliding window, size 20
 *   - Opens at 50% failure rate
 *   - Waits 10 s before half-open
 *   - 3 calls permitted in half-open state
 *
 * On definitive failure (retries exhausted or circuit open) returns a 503 [HttpStubResponse]
 * with body `{"error":"engine-unavailable","code":"ENGINE_UNAVAILABLE"}`.
 */
class ResilientForwarder(
    private val delegate: CqrsBackendClient,
    private val config: ResilienceConfig = ResilienceConfig(),
) {
    private val log = LoggerFactory.getLogger(ResilientForwarder::class.java)

    private val retry: Retry = RetryRegistry.of(
        RetryConfig.custom<HttpStubResponse?>()
            .maxAttempts(config.forwarderMaxRetries)
            .intervalFunction(
                io.github.resilience4j.core.IntervalFunction.ofExponentialBackoff(
                    config.forwarderBackoffMs,
                    4.0,
                    800,
                )
            )
            .retryOnException { it is EngineUnavailableException || it is IOException }
            .build(),
    ).retry("forwarder")

    private val circuitBreaker: CircuitBreaker = CircuitBreakerRegistry.of(
        CircuitBreakerConfig.custom()
            .failureRateThreshold(config.circuitBreakerFailureRate.toFloat())
            .slidingWindowType(CircuitBreakerConfig.SlidingWindowType.COUNT_BASED)
            .slidingWindowSize(20)
            .waitDurationInOpenState(Duration.ofMillis(config.circuitBreakerWaitMs))
            .permittedNumberOfCallsInHalfOpenState(3)
            .recordExceptions(EngineUnavailableException::class.java, IOException::class.java)
            .build(),
    ).circuitBreaker("forwarder")

    fun forward(httpRequest: HttpRequest): HttpStubResponse {
        return try {
            CircuitBreaker.decorateSupplier(circuitBreaker) {
                Retry.decorateSupplier(retry) {
                    delegate.forward(httpRequest) ?: throw EngineUnavailableException("engine returned null for ${httpRequest.path}")
                }.get()
            }.get()
        } catch (e: CallNotPermittedException) {
            log.warn("ResilientForwarder: circuit open for path '{}' — returning 503", httpRequest.path)
            buildFailureResponse("engine-circuit-open")
        } catch (e: Exception) {
            log.warn("ResilientForwarder: all retries exhausted for path '{}': {} — returning 503", httpRequest.path, e.message)
            buildFailureResponse("engine-unavailable")
        }
    }

    private fun buildFailureResponse(code: String): HttpStubResponse {
        val body = """{"error":"engine-unavailable","code":"ENGINE_UNAVAILABLE","detail":"$code"}"""
        return HttpStubResponse(
            response = HttpResponse(
                status = 503,
                headers = mapOf("Content-Type" to "application/json"),
                body = StringValue(body),
            ),
        )
    }
}

/**
 * Thrown by [ResilientForwarder] when the delegate returns null, signalling
 * that the engine is unreachable or unhealthy. Resilience4j is configured to
 * retry on this exception type.
 */
class EngineUnavailableException(message: String = "engine unavailable") : RuntimeException(message)

/**
 * Resilience configuration for [ResilientForwarder].
 *
 * @param forwarderMaxRetries       Total attempts (1 initial + N-1 retries). Default 3.
 * @param forwarderBackoffMs        Initial backoff in ms. Default 50.
 * @param circuitBreakerFailureRate Failure rate % to open the circuit. Default 50.
 * @param circuitBreakerWaitMs      Time to wait in open state before half-open (ms). Default 10 000.
 */
data class ResilienceConfig(
    val forwarderMaxRetries: Int = 3,
    val forwarderBackoffMs: Long = 50L,
    val circuitBreakerFailureRate: Int = 50,
    val circuitBreakerWaitMs: Long = 10_000L,
) {
    companion object {
        fun from(config: PluginConfig) = ResilienceConfig(
            forwarderMaxRetries = config.forwarderMaxRetries,
            forwarderBackoffMs = config.forwarderBackoffMs,
            circuitBreakerFailureRate = config.circuitBreakerFailureRate,
            circuitBreakerWaitMs = config.circuitBreakerWaitMs,
        )
    }
}
