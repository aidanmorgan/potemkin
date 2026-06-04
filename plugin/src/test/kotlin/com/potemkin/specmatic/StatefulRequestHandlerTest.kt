package com.potemkin.specmatic

import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.core.value.StringValue
import io.specmatic.stub.HttpStubResponse
import okhttp3.OkHttpClient
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Unit tests for [StatefulRequestHandler].
 *
 * Uses hand-rolled fakes for [RoutesDiscoveryClient], [CqrsBackendClient], and [FixturesClient]
 * to keep tests fast and dependency-free.
 */
class StatefulRequestHandlerTest {

    // ---- fakes --------------------------------------------------------------------------

    /**
     * Fake discovery client that always returns a fixed answer for [isStateful].
     * Uses a no-op OkHttpClient so construction never hits the network.
     */
    private class FixedDiscoveryClient(
        private val result: Boolean,
    ) : RoutesDiscoveryClient(
        backendUrl = "http://unused",
        httpClient = noOpHttpClient(),
    ) {
        override fun isStateful(path: String): Boolean = result
    }

    /**
     * Fake client that returns a pre-configured response (or null to simulate engine errors).
     * Tracks whether [forward] was called.
     */
    private class FakeClient(private val response: HttpStubResponse?) : CqrsBackendClient("http://unused") {
        var called = false
        var proxyCalled = false
        var proxiedPath: String? = null

        override fun forward(httpRequest: HttpRequest): HttpStubResponse? {
            called = true
            return response
        }

        override fun proxyRaw(httpRequest: HttpRequest): HttpStubResponse? {
            proxyCalled = true
            proxiedPath = httpRequest.path
            return response
        }
    }

    /**
     * Fake fixtures client with a configurable excluded-paths set.
     * Uses a no-op OkHttpClient so construction never hits the network.
     */
    private class FakeFixturesClient(
        private val excluded: Set<Pair<String, String>> = emptySet(),
    ) : FixturesClient(
        backendUrl = "http://unused",
        httpClient = noOpHttpClient(),
    ) {
        override fun excludedPaths(): Set<Pair<String, String>> = excluded
    }

    private fun cannedResponse(status: Int = 200): HttpStubResponse =
        HttpStubResponse(response = HttpResponse(status = status, body = StringValue("ok")))

    private fun request(method: String = "GET", path: String = "/loans/123") =
        HttpRequest(method = method, path = path, body = StringValue(""))

    // ---- admin proxy --------------------------------------------------------------------

    @Test
    fun `admin path is raw-proxied to the engine even when not a stateful route`() {
        val client = FakeClient(cannedResponse(204))
        // discovery says NOT stateful — admin paths must be claimed before the discovery check
        val handler = StatefulRequestHandler(FixedDiscoveryClient(false), client)

        val result = handler.handleRequest(request(method = "POST", path = "/_admin/reset"))

        assertNotNull(result)
        assertEquals(204, result.response.status)
        assertTrue(client.proxyCalled, "admin path should be raw-proxied")
        assertEquals("/_admin/reset", client.proxiedPath)
        assertFalse(client.called, "admin path must NOT go through the /_engine/forward path")
    }

    @Test
    fun `admin proxy failure falls through to Specmatic`() {
        val client = FakeClient(null) // proxy returns null (engine unreachable)
        val handler = StatefulRequestHandler(FixedDiscoveryClient(false), client)

        val result = handler.handleRequest(request(method = "POST", path = "/_admin/faults"))

        assertNull(result)
        assertTrue(client.proxyCalled)
    }

    // ---- original tests (unchanged) -----------------------------------------------------

    @Test
    fun `path matches and client returns response - handler returns response`() {
        val expectedResponse = cannedResponse(200)
        val client = FakeClient(expectedResponse)
        val handler = StatefulRequestHandler(FixedDiscoveryClient(true), client)

        val result = handler.handleRequest(request())

        assertNotNull(result)
        assertEquals(200, result.response.status)
    }

    @Test
    fun `path does not match - returns null without calling client`() {
        val client = FakeClient(cannedResponse())
        val handler = StatefulRequestHandler(FixedDiscoveryClient(false), client)

        val result = handler.handleRequest(request(path = "/products/1"))

        assertNull(result)
        assertEquals(false, client.called, "Client should NOT be called when path does not match")
    }

    @Test
    fun `path matches but client returns null (engine unreachable) - handler returns null`() {
        val client = FakeClient(null)
        val handler = StatefulRequestHandler(FixedDiscoveryClient(true), client)

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
        val handler = StatefulRequestHandler(FixedDiscoveryClient(true), crashingClient)

        // Must not throw — must return null gracefully.
        val result = handler.handleRequest(request())

        assertNull(result)
    }

    @Test
    fun `handler name is correct`() {
        val handler = StatefulRequestHandler(FixedDiscoveryClient(true), FakeClient(null))
        assertEquals("potemkin-stateful", handler.name)
    }

    @Test
    fun `auth-error header yields 401 with WWW-Authenticate before forwarding`() {
        val client = FakeClient(cannedResponse(200))
        val handler = StatefulRequestHandler(FixedDiscoveryClient(true), client)

        val req = request().copy(
            headers = mapOf(PotemkinHeaders.AUTH_ERROR to "Bearer realm=\"bank\""),
        )
        val result = handler.handleRequest(req)

        assertNotNull(result)
        assertEquals(401, result.response.status)
        assertEquals("Bearer realm=\"bank\"", result.response.headers["WWW-Authenticate"])
        assertEquals(false, client.called, "must reject before forwarding")
    }

    @Test
    fun `4xx response from client is propagated`() {
        val notFound = cannedResponse(404)
        val handler = StatefulRequestHandler(FixedDiscoveryClient(true), FakeClient(notFound))

        val result = handler.handleRequest(request())

        assertNotNull(result)
        assertEquals(404, result.response.status)
    }

    // ---- excluded-paths short-circuit tests ---------------------------------------------

    @Test
    fun `request in excludedPaths returns null without calling discovery or client`() {
        val client = FakeClient(cannedResponse())
        var discoveryCalled = false
        val discovery = object : RoutesDiscoveryClient(
            backendUrl = "http://unused",
            httpClient = noOpHttpClient(),
        ) {
            override fun isStateful(path: String): Boolean {
                discoveryCalled = true
                return true
            }
        }
        val fixtures = FakeFixturesClient(excluded = setOf("GET" to "/loans/123"))
        val handler = StatefulRequestHandler(discovery, client, fixtures)

        val result = handler.handleRequest(request(method = "GET", path = "/loans/123"))

        assertNull(result, "Handler should return null for excluded paths")
        assertFalse(client.called, "Client should NOT be called for excluded paths")
        assertFalse(discoveryCalled, "Discovery should NOT be called for excluded paths")
    }

    @Test
    fun `request NOT in excludedPaths is handled normally`() {
        val client = FakeClient(cannedResponse(200))
        val fixtures = FakeFixturesClient(excluded = setOf("DELETE" to "/other"))
        val handler = StatefulRequestHandler(FixedDiscoveryClient(true), client, fixtures)

        val result = handler.handleRequest(request(method = "GET", path = "/loans/123"))

        assertNotNull(result, "Handler should forward non-excluded stateful paths")
        assertTrue(client.called)
    }

    @Test
    fun `excludedPaths check is case-insensitive on method (uppercase normalised)`() {
        val client = FakeClient(cannedResponse())
        // The fixture was registered as uppercase "POST"
        val fixtures = FakeFixturesClient(excluded = setOf("POST" to "/loans"))
        val handler = StatefulRequestHandler(FixedDiscoveryClient(true), client, fixtures)

        // Request comes in with lowercase method (shouldn't happen in practice, but be safe)
        val result = handler.handleRequest(request(method = "post", path = "/loans"))

        assertNull(result, "Handler should exclude paths regardless of incoming method casing")
        assertFalse(client.called)
    }

    @Test
    fun `null fixtures client - handler behaves as before (no short-circuit)`() {
        val client = FakeClient(cannedResponse(200))
        val handler = StatefulRequestHandler(FixedDiscoveryClient(true), client, fixtures = null)

        val result = handler.handleRequest(request(method = "GET", path = "/loans/123"))

        assertNotNull(result)
        assertTrue(client.called)
    }

    @Test
    fun `excluded path with different method is NOT excluded`() {
        val client = FakeClient(cannedResponse(200))
        // Only DELETE /loans is excluded, not GET /loans
        val fixtures = FakeFixturesClient(excluded = setOf("DELETE" to "/loans"))
        val handler = StatefulRequestHandler(FixedDiscoveryClient(true), client, fixtures)

        val result = handler.handleRequest(request(method = "GET", path = "/loans"))

        assertNotNull(result, "GET /loans should not be excluded when only DELETE /loans is in excludedPaths")
        assertTrue(client.called)
    }

    @Test
    fun `excluded path with different path is NOT excluded`() {
        val client = FakeClient(cannedResponse(200))
        val fixtures = FakeFixturesClient(excluded = setOf("GET" to "/loans"))
        val handler = StatefulRequestHandler(FixedDiscoveryClient(true), client, fixtures)

        // /customers is not in excluded set
        val result = handler.handleRequest(request(method = "GET", path = "/customers"))

        assertNotNull(result)
        assertTrue(client.called)
    }
}

// ---- test helpers -----------------------------------------------------------------------

/**
 * Creates an OkHttpClient that immediately fails all requests.
 * Used to prevent discovery client construction from hitting the network in tests.
 */
private fun noOpHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .addInterceptor { _ ->
        throw java.io.IOException("no-op client — no real requests allowed in tests")
    }
    .build()
