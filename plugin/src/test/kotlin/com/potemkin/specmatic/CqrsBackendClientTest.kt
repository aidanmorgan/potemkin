package com.potemkin.specmatic

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.specmatic.core.HttpRequest
import io.specmatic.core.QueryParameters
import io.specmatic.core.value.StringValue
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CqrsBackendClientTest {

    private lateinit var server: MockWebServer
    private lateinit var client: CqrsBackendClient
    private val mapper = jacksonObjectMapper()

    @BeforeEach
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = CqrsBackendClient(
            backendUrl = "http://${server.hostName}:${server.port}",
            timeoutMs = 2_000,
        )
    }

    @AfterEach
    fun tearDown() {
        server.shutdown()
    }

    // ---- helpers ------------------------------------------------------------------------

    private fun simpleRequest(path: String = "/loans/123") = HttpRequest(
        method = "GET",
        path = path,
        headers = mapOf("Accept" to "application/json"),
        body = StringValue(""),
    )

    private fun cannedForwardedResponse(status: Int = 200, body: Any? = mapOf("id" to "123")): String =
        mapper.writeValueAsString(
            mapOf(
                "status" to status,
                "headers" to mapOf("Content-Type" to "application/json"),
                "body" to body,
            ),
        )

    // ---- happy path ---------------------------------------------------------------------

    @Test
    fun `happy path - request forwarded and response returned`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(cannedForwardedResponse()))

        val result = client.forward(simpleRequest())

        assertNotNull(result)
        assertEquals(200, result.response.status)
    }

    @Test
    fun `happy path - response status is preserved`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(cannedForwardedResponse(status = 201)))

        val result = client.forward(simpleRequest())

        assertNotNull(result)
        assertEquals(201, result.response.status)
    }

    @Test
    fun `happy path - server receives correct path in forwarded body`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(cannedForwardedResponse()))

        client.forward(simpleRequest("/loans/456"))

        val recorded = server.takeRequest()
        val body = mapper.readTree(recorded.body.readUtf8())
        assertEquals("/loans/456", body["path"].asText())
    }

    // ---- 4xx - propagated as deliberate client errors -----------------------------------

    @Test
    fun `4xx response is returned (deliberate client error from engine)`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(cannedForwardedResponse(status = 404)))

        val result = client.forward(simpleRequest())

        assertNotNull(result)
        assertEquals(404, result.response.status)
    }

    @Test
    fun `422 unprocessable entity is returned`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(cannedForwardedResponse(status = 422)))

        val result = client.forward(simpleRequest())

        assertNotNull(result)
        assertEquals(422, result.response.status)
    }

    // ---- 5xx - fall through to Specmatic -----------------------------------------------

    @Test
    fun `500 from engine returns null (fall through)`() {
        server.enqueue(MockResponse().setResponseCode(500).setBody("Internal Server Error"))

        val result = client.forward(simpleRequest())

        assertNull(result)
    }

    @Test
    fun `503 from engine returns null (fall through)`() {
        server.enqueue(MockResponse().setResponseCode(503).setBody("Unavailable"))

        val result = client.forward(simpleRequest())

        assertNull(result)
    }

    // ---- malformed JSON -----------------------------------------------------------------

    @Test
    fun `malformed JSON response body returns null`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("not-json{{{"))

        val result = client.forward(simpleRequest())

        assertNull(result)
    }

    @Test
    fun `empty response body returns null`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(""))

        val result = client.forward(simpleRequest())

        assertNull(result)
    }

    // ---- network errors -----------------------------------------------------------------

    @Test
    fun `server unreachable returns null`() {
        // Shut down before calling so the connection is refused.
        server.shutdown()

        val result = client.forward(simpleRequest())

        assertNull(result)
    }

    @Test
    fun `timeout returns null`() {
        // Fast-timeout client (100 ms) + server that never responds.
        val fastClient = CqrsBackendClient(
            backendUrl = "http://${server.hostName}:${server.port}",
            timeoutMs = 100,
        )
        server.enqueue(MockResponse().setBodyDelay(5_000, java.util.concurrent.TimeUnit.MILLISECONDS).setBody("{}"))

        val result = fastClient.forward(simpleRequest())

        assertNull(result)
    }

    // ---- drop-connection chaos (ac36) ---------------------------------------------------

    @Test
    fun `drop-connection chaos returns 504 with x-potemkin-dropped header on plugin path`() {
        // The forwarding handler emits a synthetic 504 + x-potemkin-dropped:true when
        // drop-connection chaos fires (src/forwarding/handler.ts). The plugin cannot abort
        // the Specmatic socket from inside a RequestHandler so it propagates the 504 verbatim.
        // This test asserts that canonical plugin behaviour: 504 + header present, no TCP reset.
        val droppedEnvelope = mapper.writeValueAsString(
            mapOf(
                "status" to 504,
                "headers" to mapOf(PotemkinHeaders.DROPPED to "true"),
                "body" to null,
            ),
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody(droppedEnvelope))

        val result = client.forward(simpleRequest())

        assertNotNull(result, "drop-connection chaos must yield a response, not null")
        assertEquals(504, result.response.status)
        assertEquals("true", result.response.headers[PotemkinHeaders.DROPPED],
            "x-potemkin-dropped header must be preserved so callers can distinguish drop-chaos from real timeouts")
    }

    // ---- query parameter serialisation --------------------------------------------------

    @Test
    fun `single-valued query param serialises as a plain JSON string`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(cannedForwardedResponse()))

        val request = HttpRequest(
            method = "GET",
            path = "/items",
            headers = emptyMap(),
            body = StringValue(""),
            queryParams = QueryParameters(listOf("status" to "active")),
        )
        client.forward(request)

        val recorded = server.takeRequest()
        val body = mapper.readTree(recorded.body.readUtf8())
        val queryNode = body["query"]
        assertNotNull(queryNode)
        assertTrue(queryNode.isObject, "query should be a JSON object")
        val statusNode = queryNode["status"]
        assertNotNull(statusNode)
        assertTrue(statusNode.isTextual, "single-valued query param should serialise as a plain JSON string")
        assertEquals("active", statusNode.asText())
    }

    @Test
    fun `repeated query key serialises as a JSON array in the forwarded payload`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(cannedForwardedResponse()))

        val request = HttpRequest(
            method = "GET",
            path = "/items",
            headers = emptyMap(),
            body = StringValue(""),
            queryParams = QueryParameters(listOf("status" to "active", "status" to "inactive")),
        )
        client.forward(request)

        val recorded = server.takeRequest()
        val body = mapper.readTree(recorded.body.readUtf8())
        val queryNode = body["query"]
        assertNotNull(queryNode)
        assertTrue(queryNode.isObject, "query should be a JSON object")
        val statusNode = queryNode["status"]
        assertNotNull(statusNode)
        assertTrue(statusNode.isArray, "repeated query key should serialise as a JSON array")
        val values = statusNode.map { it.asText() }
        assertEquals(listOf("active", "inactive"), values)
    }
}
