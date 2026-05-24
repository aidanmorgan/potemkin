package com.potemkin.specmatic

import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.core.value.StringValue
import io.specmatic.stub.HttpStubResponse
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * Unit tests for [StatefulRequestHandler].
 *
 * Uses hand-rolled fakes for [PathMatcher] and [CqrsBackendClient] to keep the tests fast
 * and dependency-free.
 */
class StatefulRequestHandlerTest {

    // ---- fakes --------------------------------------------------------------------------

    private class FixedPathMatcher(private val result: Boolean) : PathMatcher(emptyList()) {
        override fun matches(path: String?): Boolean = result
    }

    /**
     * Fake client that returns a pre-configured response (or null to simulate engine errors).
     * Tracks whether [forward] was called.
     */
    private class FakeClient(private val response: HttpStubResponse?) : CqrsBackendClient("http://unused") {
        var called = false

        override fun forward(httpRequest: HttpRequest): HttpStubResponse? {
            called = true
            return response
        }
    }

    private fun cannedResponse(status: Int = 200): HttpStubResponse =
        HttpStubResponse(response = HttpResponse(status = status, body = StringValue("ok")))

    private fun request(path: String = "/loans/123") =
        HttpRequest(method = "GET", path = path, body = StringValue(""))

    // ---- tests --------------------------------------------------------------------------

    @Test
    fun `path matches and client returns response - handler returns response`() {
        val expectedResponse = cannedResponse(200)
        val client = FakeClient(expectedResponse)
        val handler = StatefulRequestHandler(FixedPathMatcher(true), client)

        val result = handler.handleRequest(request())

        assertNotNull(result)
        assertEquals(200, result.response.status)
    }

    @Test
    fun `path does not match - returns null without calling client`() {
        val client = FakeClient(cannedResponse())
        val handler = StatefulRequestHandler(FixedPathMatcher(false), client)

        val result = handler.handleRequest(request("/products/1"))

        assertNull(result)
        assertEquals(false, client.called, "Client should NOT be called when path does not match")
    }

    @Test
    fun `path matches but client returns null (engine unreachable) - handler returns null`() {
        val client = FakeClient(null)
        val handler = StatefulRequestHandler(FixedPathMatcher(true), client)

        val result = handler.handleRequest(request())

        assertNull(result)
        assertEquals(true, client.called, "Client SHOULD be called when path matches")
    }

    @Test
    fun `exception thrown inside client is caught - handler returns null`() {
        val crashingClient = object : CqrsBackendClient("http://unused") {
            override fun forward(httpRequest: HttpRequest): HttpStubResponse? {
                throw RuntimeException("Unexpected crash")
            }
        }
        val handler = StatefulRequestHandler(FixedPathMatcher(true), crashingClient)

        // Must not throw — must return null gracefully.
        val result = handler.handleRequest(request())

        assertNull(result)
    }

    @Test
    fun `handler name is correct`() {
        val handler = StatefulRequestHandler(FixedPathMatcher(true), FakeClient(null))
        assertEquals("potemkin-stateful", handler.name)
    }

    @Test
    fun `4xx response from client is propagated`() {
        val notFound = cannedResponse(404)
        val handler = StatefulRequestHandler(FixedPathMatcher(true), FakeClient(notFound))

        val result = handler.handleRequest(request())

        assertNotNull(result)
        assertEquals(404, result.response.status)
    }
}
