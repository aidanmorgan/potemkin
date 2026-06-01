package com.potemkin.specmatic

import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.core.value.StringValue
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Unit tests for [WorkflowPropagator]: an id extracted from a create
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

    private fun jwtClaims(sub: String): Map<String, String> =
        mapOf(PotemkinHeaders.JWT_CLAIMS to """{"sub":"$sub"}""")

    private fun workflowSession(id: String): Map<String, String> =
        mapOf(PotemkinHeaders.WORKFLOW_SESSION to id)

    @Test
    fun `two interleaved chains keyed by JWT subject each substitute their own captured id`() {
        val prop = WorkflowPropagator(blockOf(extract = "BODY.id", use = "PATH.leadId"))

        // Interleave: A creates, B creates (same id NAME, different values), then
        // each reads back. With a shared flat map B's create would clobber A's.
        prop.observeResponse(
            HttpRequest(method = "POST", path = "/leads", headers = jwtClaims("alice")),
            HttpResponse(status = 201, body = StringValue("""{"id":"lead-A"}""")),
        )
        prop.observeResponse(
            HttpRequest(method = "POST", path = "/leads", headers = jwtClaims("bob")),
            HttpResponse(status = 201, body = StringValue("""{"id":"lead-B"}""")),
        )

        val aRead = prop.applyToRequest(
            HttpRequest(method = "GET", path = "/leads/{leadId}", headers = jwtClaims("alice")),
        )
        val bRead = prop.applyToRequest(
            HttpRequest(method = "GET", path = "/leads/{leadId}", headers = jwtClaims("bob")),
        )

        assertEquals("/leads/lead-A", aRead.path)
        assertEquals("/leads/lead-B", bRead.path)
    }

    @Test
    fun `two interleaved chains keyed by workflow-session header each substitute their own captured id`() {
        val prop = WorkflowPropagator(blockOf(extract = "BODY.id", use = "PATH.leadId"))

        prop.observeResponse(
            HttpRequest(method = "POST", path = "/leads", headers = workflowSession("chain-1")),
            HttpResponse(status = 201, body = StringValue("""{"id":"lead-1"}""")),
        )
        prop.observeResponse(
            HttpRequest(method = "POST", path = "/leads", headers = workflowSession("chain-2")),
            HttpResponse(status = 201, body = StringValue("""{"id":"lead-2"}""")),
        )

        assertEquals(
            "/leads/lead-2",
            prop.applyToRequest(
                HttpRequest(method = "GET", path = "/leads/{leadId}", headers = workflowSession("chain-2")),
            ).path,
        )
        assertEquals(
            "/leads/lead-1",
            prop.applyToRequest(
                HttpRequest(method = "GET", path = "/leads/{leadId}", headers = workflowSession("chain-1")),
            ).path,
        )
    }

    @Test
    fun `concurrent interleaved chains stay isolated under parallel dispatch`() {
        val prop = WorkflowPropagator(blockOf(extract = "BODY.id", use = "PATH.leadId"))
        val chains = 200
        val pool = java.util.concurrent.Executors.newFixedThreadPool(16)
        val start = java.util.concurrent.CountDownLatch(1)
        val mismatches = java.util.concurrent.atomic.AtomicInteger(0)

        val tasks = (0 until chains).map { i ->
            java.util.concurrent.Callable {
                start.await()
                val sub = "actor-$i"
                val expectedId = "lead-$i"
                // Each chain captures the SAME id NAME (leadId) with its own value,
                // then immediately reads it back interleaved with every other chain.
                prop.observeResponse(
                    HttpRequest(method = "POST", path = "/leads", headers = jwtClaims(sub)),
                    HttpResponse(status = 201, body = StringValue("""{"id":"$expectedId"}""")),
                )
                val read = prop.applyToRequest(
                    HttpRequest(method = "GET", path = "/leads/{leadId}", headers = jwtClaims(sub)),
                )
                if (read.path != "/leads/$expectedId") mismatches.incrementAndGet()
            }
        }
        val futures = tasks.map { pool.submit(it) }
        start.countDown()
        futures.forEach { it.get() }
        pool.shutdown()

        assertEquals(0, mismatches.get(), "every chain must read back its own captured id")
    }

    @Test
    fun `capturedBySession is bounded and does not grow past the configured cap`() {
        val cap = 10
        val prop = WorkflowPropagator(blockOf(extract = "BODY.id", use = "PATH.leadId"), maxSessions = cap)

        // Insert cap + 5 distinct sessions by using distinct JWT subjects.
        repeat(cap + 5) { i ->
            val headers = mapOf(PotemkinHeaders.JWT_CLAIMS to """{"sub":"user-$i"}""")
            prop.observeResponse(
                HttpRequest(method = "POST", path = "/leads", headers = headers),
                HttpResponse(status = 201, body = io.specmatic.core.value.StringValue("""{"id":"lead-$i"}""")),
            )
        }

        // Access the underlying map size via reflection to verify the cap is enforced.
        val field = WorkflowPropagator::class.java.getDeclaredField("capturedBySession")
        field.isAccessible = true
        val map = field.get(prop) as Map<*, *>
        assertTrue(map.size <= cap, "capturedBySession must not exceed cap=$cap; actual size=${map.size}")
    }

    @Test
    fun `chains without correlation share the default session namespace`() {
        // Documented single-session fallback: requests carrying neither a JWT
        // subject nor a workflow-session header share one namespace, so a later
        // capture under the same id name is visible to all such requests.
        val prop = WorkflowPropagator(blockOf(extract = "BODY.id", use = "PATH.leadId"))
        prop.observeResponse(
            HttpRequest(method = "POST", path = "/leads"),
            HttpResponse(status = 201, body = StringValue("""{"id":"shared"}""")),
        )
        assertEquals(
            "/leads/shared",
            prop.applyToRequest(HttpRequest(method = "GET", path = "/leads/{leadId}")).path,
        )
    }
}
