package com.potemkin.specmatic

import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.core.value.StringValue
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Unit tests for [WorkflowPropagator] (E6 / AC-G6.2): an id extracted from a create
 * response is substituted into a later request's path placeholder, mirroring
 * Specmatic's BODY/PATH workflow vocabulary.
 */
class WorkflowPropagatorTest {

    private fun blockOf(extract: String, use: String) =
        WorkflowBlock(ids = mapOf("leadId" to WorkflowIdEntry(extract = extract, use = use)))

    @Test
    fun `id captured from create response is substituted into a later path (BODY-PATH)`() {
        val prop = WorkflowPropagator(blockOf(extract = "BODY.id", use = "PATH.leadId"))
        assertTrue(prop.isActive)

        val createReq = HttpRequest(method = "POST", path = "/leads")
        val createResp = HttpResponse(status = 201, body = StringValue("""{"id":"lead-42","status":"NEW"}"""))
        prop.observeResponse(createReq, createResp)

        val getReq = HttpRequest(method = "GET", path = "/leads/{leadId}")
        val rewritten = prop.applyToRequest(getReq)
        assertEquals("/leads/lead-42", rewritten.path)
    }

    @Test
    fun `JSONPath dollar form is accepted for extract and use`() {
        val prop = WorkflowPropagator(blockOf(extract = "$.id", use = "$.leadId"))
        prop.observeResponse(
            HttpRequest(method = "POST", path = "/leads"),
            HttpResponse(status = 200, body = StringValue("""{"id":"abc"}""")),
        )
        val rewritten = prop.applyToRequest(HttpRequest(method = "GET", path = "/leads/{leadId}"))
        assertEquals("/leads/abc", rewritten.path)
    }

    @Test
    fun `request is unchanged before any id is captured`() {
        val prop = WorkflowPropagator(blockOf(extract = "BODY.id", use = "PATH.leadId"))
        val getReq = HttpRequest(method = "GET", path = "/leads/{leadId}")
        assertEquals("/leads/{leadId}", prop.applyToRequest(getReq).path)
    }

    @Test
    fun `non-2xx response does not capture an id`() {
        val prop = WorkflowPropagator(blockOf(extract = "BODY.id", use = "PATH.leadId"))
        prop.observeResponse(
            HttpRequest(method = "POST", path = "/leads"),
            HttpResponse(status = 422, body = StringValue("""{"id":"should-not-capture"}""")),
        )
        assertEquals("/leads/{leadId}", prop.applyToRequest(HttpRequest(method = "GET", path = "/leads/{leadId}")).path)
    }

    @Test
    fun `inactive propagator is a no-op`() {
        val prop = WorkflowPropagator(WorkflowBlock())
        assertFalse(prop.isActive)
        val req = HttpRequest(method = "GET", path = "/leads/{leadId}")
        assertEquals(req.path, prop.applyToRequest(req).path)
    }

    @Test
    fun `leafOf strips JSONPath root and location prefixes`() {
        assertEquals("id", WorkflowPropagator.leafOf("BODY.id"))
        assertEquals("leadId", WorkflowPropagator.leafOf("PATH.leadId"))
        assertEquals("id", WorkflowPropagator.leafOf("$.id"))
        assertEquals("id", WorkflowPropagator.leafOf("$.data.id"))
    }
}
