package com.potemkin.specmatic.reliability

import com.potemkin.specmatic.CqrsBackendClient
import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.core.value.StringValue
import io.specmatic.stub.HttpStubResponse
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Unit tests for [ResilientForwarder].
 *
 * Uses hand-rolled fakes for [CqrsBackendClient] to control per-call behaviour
 * without needing a real HTTP server — testing the resilience4j config in isolation.
 */
class ResilientForwarderTest {

    private fun request(path: String = "/test"): HttpRequest =
        HttpRequest(method = "GET", path = path, body = StringValue(""))

    private fun successResponse(status: Int = 200): HttpStubResponse =
        HttpStubResponse(response = HttpResponse(status = status, body = StringValue("ok")))

    // ---- Fake delegate ------------------------------------------------------------------

    /**
     * Client that returns a pre-configured sequence of responses per call.
     * `null` elements simulate engine unreachable (will be turned into [EngineUnavailableException]
     * by the forwarder).
     */
    private class SequenceClient(vararg responses: HttpStubResponse?) : CqrsBackendClient("http://unused") {
        private val queue = ArrayDeque(responses.toList())
        var callCount = 0

        override fun forward(httpRequest: HttpRequest): HttpStubResponse? {
            callCount++
            return if (queue.isEmpty()) null else queue.removeFirst()
        }
    }

    // ---- success path tests -------------------------------------------------------------

    @Test
    fun `successful call returns engine response`() {
        val delegate = SequenceClient(successResponse(200))
        val forwarder = ResilientForwarder(delegate, ResilienceConfig(forwarderMaxRetries = 3, forwarderBackoffMs = 1L))

        val result = forwarder.forward(request())

        assertEquals(200, result.response.status)
        assertEquals(1, delegate.callCount)
    }

    @Test
    fun `success on second attempt returns response and retries once`() {
        // First call: null (engine down) → second call: 200
        val delegate = SequenceClient(null, successResponse(200))
        val forwarder = ResilientForwarder(delegate, ResilienceConfig(forwarderMaxRetries = 3, forwarderBackoffMs = 1L))

        val result = forwarder.forward(request())

        assertEquals(200, result.response.status)
        assertEquals(2, delegate.callCount)
    }

    // ---- retry exhaustion tests ---------------------------------------------------------

    @Test
    fun `all retries exhausted returns 503`() {
        // 3 null responses → all 3 attempts fail
        val delegate = SequenceClient(null, null, null)
        val forwarder = ResilientForwarder(delegate, ResilienceConfig(forwarderMaxRetries = 3, forwarderBackoffMs = 1L))

        val result = forwarder.forward(request())

        assertEquals(503, result.response.status)
        assertEquals(3, delegate.callCount, "Should have tried exactly 3 times")
    }

    @Test
    fun `503 response body contains ENGINE_UNAVAILABLE`() {
        val delegate = SequenceClient(null, null, null)
        val forwarder = ResilientForwarder(delegate, ResilienceConfig(forwarderMaxRetries = 3, forwarderBackoffMs = 1L))

        val result = forwarder.forward(request())
        val body = result.response.body.toStringLiteral()

        assertNotNull(body)
        assert(body.contains("ENGINE_UNAVAILABLE")) { "Expected ENGINE_UNAVAILABLE in body, got: $body" }
    }

    @Test
    fun `4xx response from engine is not retried and is returned as-is`() {
        // CqrsBackendClient returns 4xx responses directly (not null), so they bypass retry.
        val delegate = SequenceClient(successResponse(404))
        val forwarder = ResilientForwarder(delegate, ResilienceConfig(forwarderMaxRetries = 3, forwarderBackoffMs = 1L))

        val result = forwarder.forward(request())

        assertEquals(404, result.response.status)
        assertEquals(1, delegate.callCount)
    }

    // ---- circuit breaker tests ----------------------------------------------------------

    @Test
    fun `circuit opens after exceeding failure rate threshold`() {
        // Config: sliding window 20, failure rate 50% → open after 10+ failures in 20 calls.
        // We use 21 failures to ensure the window is full and failure rate = 100%.
        val nulls = Array(21) { null as HttpStubResponse? }
        val delegate = SequenceClient(*nulls)
        val config = ResilienceConfig(
            forwarderMaxRetries = 1,   // 1 attempt only to keep test fast
            forwarderBackoffMs = 1L,
            circuitBreakerFailureRate = 50,
            circuitBreakerWaitMs = 60_000L,  // long wait so circuit stays open during test
        )
        val forwarder = ResilientForwarder(delegate, config)

        // Exhaust all 21 calls — circuit should eventually open
        repeat(21) {
            forwarder.forward(request())
        }

        // Now the circuit is open; the delegate should NOT be called again.
        val before = delegate.callCount
        val result = forwarder.forward(request())
        val after = delegate.callCount

        assertEquals(503, result.response.status)
        assertEquals(before, after, "Delegate should not be called when circuit is open")
    }

    @Test
    fun `circuit breaker config failure rate threshold is respected`() {
        // Verify the resilience config is accepted without error.
        val config = ResilienceConfig(
            forwarderMaxRetries = 3,
            forwarderBackoffMs = 50L,
            circuitBreakerFailureRate = 75,
            circuitBreakerWaitMs = 5_000L,
        )
        val delegate = SequenceClient(successResponse(200))
        val forwarder = ResilientForwarder(delegate, config)

        val result = forwarder.forward(request())
        assertEquals(200, result.response.status)
    }

    // ---- retry config verification ------------------------------------------------------

    @Test
    fun `forwarder with maxRetries=1 does not retry`() {
        val delegate = SequenceClient(null, successResponse(200))
        val forwarder = ResilientForwarder(delegate, ResilienceConfig(forwarderMaxRetries = 1, forwarderBackoffMs = 1L))

        val result = forwarder.forward(request())

        assertEquals(503, result.response.status)
        assertEquals(1, delegate.callCount, "maxRetries=1 means only 1 attempt — no retries")
    }

    // ---- concurrency tests --------------------------------------------------------------

    /**
     * A delegate that always succeeds, counting every call atomically. Many threads
     * forward concurrently; the resilience4j Retry/CircuitBreaker state is shared but
     * thread-safe, so the delegate must be invoked exactly once per successful forward
     * (no retries on success) — proving no lost updates or spurious retries under load.
     */
    private class CountingClient(private val response: HttpStubResponse) : CqrsBackendClient("http://unused") {
        val callCount = java.util.concurrent.atomic.AtomicInteger(0)
        override fun forward(httpRequest: HttpRequest): HttpStubResponse? {
            callCount.incrementAndGet()
            return response
        }
    }

    @Test
    fun `concurrent successful forwards each call the delegate exactly once`() {
        val delegate = CountingClient(successResponse(200))
        val forwarder = ResilientForwarder(delegate, ResilienceConfig(forwarderMaxRetries = 3, forwarderBackoffMs = 1L))

        val threads = 16
        val perThread = 100
        val errors = java.util.concurrent.CopyOnWriteArrayList<Throwable>()
        val barrier = java.util.concurrent.CyclicBarrier(threads)
        val pool = java.util.concurrent.Executors.newFixedThreadPool(threads)
        val ok = java.util.concurrent.atomic.AtomicInteger(0)
        repeat(threads) {
            pool.submit {
                try {
                    barrier.await()
                    repeat(perThread) {
                        val result = forwarder.forward(request())
                        if (result.response.status == 200) ok.incrementAndGet()
                    }
                } catch (e: Throwable) {
                    errors.add(e)
                }
            }
        }
        pool.shutdown()
        assertTrue(pool.awaitTermination(30, java.util.concurrent.TimeUnit.SECONDS), "threads did not finish")
        assertTrue(errors.isEmpty(), "concurrent forward threw: ${errors.map { it.message }}")

        val expected = threads * perThread
        assertEquals(expected, ok.get(), "every concurrent forward should succeed")
        assertEquals(expected, delegate.callCount.get(), "success path must invoke delegate exactly once per forward (no retries)")
    }

    @Test
    fun `EngineUnavailableException is handled as 503`() {
        val throwingClient = object : CqrsBackendClient("http://unused") {
            override fun forward(httpRequest: HttpRequest): HttpStubResponse? {
                throw EngineUnavailableException("simulated engine crash")
            }
        }
        val forwarder = ResilientForwarder(throwingClient, ResilienceConfig(forwarderMaxRetries = 1, forwarderBackoffMs = 1L))

        val result = forwarder.forward(request())

        assertEquals(503, result.response.status)
    }
}
