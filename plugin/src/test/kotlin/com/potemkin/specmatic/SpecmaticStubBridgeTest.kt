package com.potemkin.specmatic

import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.core.value.StringValue
import io.specmatic.mock.ScenarioStub
import io.specmatic.stub.HttpStub
import io.specmatic.stub.HttpStubData
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Unit tests for [SpecmaticStubBridge].
 *
 * [HttpStub] is a final class in Specmatic that requires loaded contract files to instantiate.
 * To keep these tests fast and dependency-free we use a test subclass of [SpecmaticStubBridge]
 * that overrides [SpecmaticStubBridge.doSetExpectation] to capture the [ScenarioStub] that
 * would be passed to Specmatic, rather than calling through to a real [HttpStub].
 *
 * This approach:
 * - Verifies that [SpecmaticStubBridge.registerStub] builds the correct [ScenarioStub].
 * - Verifies exception handling (NoMatchingScenario analog) without needing real contracts.
 * - Documents that the real API is [HttpStub.setExpectation(ScenarioStub)].
 */
class SpecmaticStubBridgeTest {

    // ---- test infrastructure ------------------------------------------------------------

    /**
     * Captures ScenarioStub instances that would be passed to Specmatic.
     * Optionally throws to simulate Specmatic's NoMatchingScenario.
     */
    private class CapturingBridge(
        private val shouldThrow: Boolean = false,
        private val throwMessage: String = "No matching scenario",
    ) : SpecmaticStubBridge(
        // HttpStub is final — pass null here since doSetExpectation is overridden and
        // the real setExpectation is never called in these unit tests.
        null,
    ) {
        val captured = mutableListOf<ScenarioStub>()

        override fun doSetExpectation(scenarioStub: ScenarioStub): List<HttpStubData>? {
            if (shouldThrow) throw RuntimeException(throwMessage)
            captured.add(scenarioStub)
            return null
        }
    }

    // ---- helpers ------------------------------------------------------------------------

    private fun makeFixture(
        method: String = "GET",
        path: String = "/loans/{id}",
        status: Int = 200,
        responseBody: Any? = mapOf("id" to "123"),
        requestHeaders: Map<String, String>? = null,
        responseHeaders: Map<String, String> = mapOf("Content-Type" to "application/json"),
    ) = FixtureStub(
        httpRequest = FixtureHttpRequest(
            method = method,
            path = path,
            headers = requestHeaders,
        ),
        httpResponse = FixtureHttpResponse(
            status = status,
            headers = responseHeaders,
            body = responseBody,
        ),
        source = FixtureSource(
            boundary = "lending",
            aggregateId = "loan",
            contractPath = "/contracts/lending.yaml",
        ),
    )

    // ---- registerStub: success path -----------------------------------------------------

    @Test
    fun `registerStub returns true on success`() {
        val bridge = CapturingBridge()
        val result = bridge.registerStub(makeFixture())
        assertTrue(result)
    }

    @Test
    fun `registerStub passes correct method (uppercase) to Specmatic`() {
        val bridge = CapturingBridge()
        bridge.registerStub(makeFixture(method = "post"))

        assertEquals(1, bridge.captured.size)
        assertEquals("POST", bridge.captured[0].request.method)
    }

    @Test
    fun `registerStub passes correct path to Specmatic`() {
        val bridge = CapturingBridge()
        bridge.registerStub(makeFixture(path = "/customers/{id}"))

        assertEquals("/customers/{id}", bridge.captured[0].request.path)
    }

    @Test
    fun `registerStub passes correct response status to Specmatic`() {
        val bridge = CapturingBridge()
        bridge.registerStub(makeFixture(status = 404))

        assertEquals(404, bridge.captured[0].response.status)
    }

    @Test
    fun `registerStub passes request headers to Specmatic`() {
        val bridge = CapturingBridge()
        bridge.registerStub(makeFixture(requestHeaders = mapOf("Authorization" to "Bearer token")))

        val headers = bridge.captured[0].request.headers
        assertEquals("Bearer token", headers["Authorization"])
    }

    @Test
    fun `registerStub passes response headers to Specmatic`() {
        val bridge = CapturingBridge()
        bridge.registerStub(makeFixture(responseHeaders = mapOf("X-Custom" to "value")))

        val headers = bridge.captured[0].response.headers
        assertEquals("value", headers["X-Custom"])
    }

    @Test
    fun `registerStub serialises map body to JSON string`() {
        val bridge = CapturingBridge()
        bridge.registerStub(makeFixture(responseBody = mapOf("id" to "123", "status" to "active")))

        val body = bridge.captured[0].response.body.toStringLiteral()
        assertTrue(body.contains("\"id\""), "Body should contain 'id' key")
        assertTrue(body.contains("123"), "Body should contain '123' value")
    }

    @Test
    fun `registerStub serialises list body to JSON string`() {
        val bridge = CapturingBridge()
        bridge.registerStub(makeFixture(responseBody = listOf("a", "b", "c")))

        val body = bridge.captured[0].response.body.toStringLiteral()
        assertTrue(body.startsWith("["), "Body should be a JSON array")
    }

    @Test
    fun `registerStub handles null body as empty string`() {
        val bridge = CapturingBridge()
        bridge.registerStub(makeFixture(responseBody = null))

        val body = bridge.captured[0].response.body.toStringLiteral()
        assertEquals("", body)
    }

    @Test
    fun `registerStub handles string body directly as StringValue`() {
        val bridge = CapturingBridge()
        bridge.registerStub(makeFixture(responseBody = "plain text"))

        val body = bridge.captured[0].response.body.toStringLiteral()
        assertEquals("plain text", body)
    }

    @Test
    fun `registerStub handles null request headers as empty map`() {
        val bridge = CapturingBridge()
        bridge.registerStub(makeFixture(requestHeaders = null))

        val headers = bridge.captured[0].request.headers
        assertNotNull(headers)
        assertTrue(headers.isEmpty())
    }

    // ---- registerStub: failure / exception handling ------------------------------------

    @Test
    fun `registerStub returns false when Specmatic throws NoMatchingScenario analog`() {
        val bridge = CapturingBridge(shouldThrow = true, throwMessage = "No matching scenario found")
        val result = bridge.registerStub(makeFixture())
        assertFalse(result, "Should return false when Specmatic throws")
    }

    @Test
    fun `registerStub does not throw when Specmatic throws`() {
        val bridge = CapturingBridge(shouldThrow = true)
        // Must not propagate the exception.
        val result = bridge.registerStub(makeFixture())
        assertFalse(result)
    }

    @Test
    fun `registerStub returns false on any exception type`() {
        val bridge = object : SpecmaticStubBridge(null) {
            override fun doSetExpectation(scenarioStub: ScenarioStub): List<HttpStubData>? {
                throw IllegalStateException("Unexpected internal Specmatic error")
            }
        }
        val result = bridge.registerStub(makeFixture())
        assertFalse(result)
    }

    // ---- buildSpecmaticRequest (internal) -----------------------------------------------

    @Test
    fun `buildSpecmaticRequest uppercases method`() {
        val bridge = CapturingBridge()
        val req = bridge.buildSpecmaticRequest(FixtureHttpRequest("delete", "/items/1"))
        assertEquals("DELETE", req.method)
    }

    @Test
    fun `buildSpecmaticRequest maps path correctly`() {
        val bridge = CapturingBridge()
        val req = bridge.buildSpecmaticRequest(FixtureHttpRequest("GET", "/items/{id}"))
        assertEquals("/items/{id}", req.path)
    }

    // ---- buildSpecmaticRequest: query parameters -----------------------

    @Test
    fun `buildSpecmaticRequest maps query parameters into the Specmatic request`() {
        val bridge = CapturingBridge()
        val req = bridge.buildSpecmaticRequest(
            FixtureHttpRequest("GET", "/loans", queryParameters = mapOf("status" to "active", "page" to 2)),
        )
        val qp = req.queryParams.asMap()
        assertEquals("active", qp["status"])
        assertEquals("2", qp["page"])
    }

    @Test
    fun `buildSpecmaticRequest with null queryParameters produces empty query params`() {
        val bridge = CapturingBridge()
        val req = bridge.buildSpecmaticRequest(FixtureHttpRequest("GET", "/loans", queryParameters = null))
        assertTrue(req.queryParams.asMap().isEmpty())
    }

    @Test
    fun `buildSpecmaticRequest with empty queryParameters produces empty query params`() {
        val bridge = CapturingBridge()
        val req = bridge.buildSpecmaticRequest(FixtureHttpRequest("GET", "/loans", queryParameters = emptyMap()))
        assertTrue(req.queryParams.asMap().isEmpty())
    }

    @Test
    fun `registerStub passes query parameters through to captured ScenarioStub`() {
        val bridge = CapturingBridge()
        val fixture = FixtureStub(
            httpRequest = FixtureHttpRequest("GET", "/items", queryParameters = mapOf("filter" to "open")),
            httpResponse = FixtureHttpResponse(status = 200, body = null),
            source = FixtureSource("boundary", "agg", "/contract.yaml"),
        )
        bridge.registerStub(fixture)

        assertEquals(1, bridge.captured.size)
        val qp = bridge.captured[0].request.queryParams.asMap()
        assertEquals("open", qp["filter"])
    }

    // ---- buildSpecmaticResponse (internal) ----------------------------------------------

    @Test
    fun `buildSpecmaticResponse maps status correctly`() {
        val bridge = CapturingBridge()
        val resp = bridge.buildSpecmaticResponse(
            FixtureHttpResponse(status = 201, headers = emptyMap(), body = null),
        )
        assertEquals(201, resp.status)
    }

    @Test
    fun `buildSpecmaticResponse maps headers correctly`() {
        val bridge = CapturingBridge()
        val resp = bridge.buildSpecmaticResponse(
            FixtureHttpResponse(
                status = 200,
                headers = mapOf("Content-Type" to "application/json"),
                body = null,
            ),
        )
        assertEquals("application/json", resp.headers["Content-Type"])
    }
}
