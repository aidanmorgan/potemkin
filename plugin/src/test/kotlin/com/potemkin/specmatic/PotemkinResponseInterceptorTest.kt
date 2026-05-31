package com.potemkin.specmatic

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.core.value.StringValue
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Unit tests for [PotemkinResponseInterceptor] (E1):
 *  - reads `_patches` and applies them to the response body (AC-E1.1)
 *  - covers all 10 ops via [PatchApplier] (parity verified in [PatchApplierTest], AC-E1.2)
 *  - patch failure preserves the original response and adds a `Warning` header (AC-E1.3)
 */
class PotemkinResponseInterceptorTest {

    private val interceptor = PotemkinResponseInterceptor()
    private val mapper = jacksonObjectMapper()
    private val req = HttpRequest(method = "GET", path = "/loans/L-1")

    private fun response(body: String, status: Int = 200): HttpResponse =
        HttpResponse(status = status, headers = mapOf("Content-Type" to "application/json"), body = StringValue(body))

    private fun bodyAsMap(resp: HttpResponse): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return mapper.readValue(resp.body.toStringLiteral(), Map::class.java) as Map<String, Any?>
    }

    @Test
    fun `adds Deprecation header for an operation the overlay deprecated`() {
        val policy = DeprecationPolicy.fromOverlayPatches(
            listOf(Patch.Add("/paths/~1loans~1{id}/get/deprecated", true)),
        )
        val deprecating = PotemkinResponseInterceptor(policy)
        val result = deprecating.interceptResponse(req, response("""{"id":"L-1"}"""))
        assertEquals("true", result.headers["Deprecation"])
    }

    @Test
    fun `no Deprecation header for an operation that is not deprecated`() {
        val policy = DeprecationPolicy.fromOverlayPatches(
            listOf(Patch.Add("/paths/~1campaigns~1{id}/get/deprecated", true)),
        )
        val deprecating = PotemkinResponseInterceptor(policy)
        val result = deprecating.interceptResponse(req, response("""{"id":"L-1"}"""))
        assertNull(result.headers["Deprecation"])
    }

    @Test
    fun `applies _patches to the response body and strips the field`() {
        val resp = response(
            """{"status":"PENDING","version":1,"_patches":[{"op":"replace","path":"/status","value":"ACTIVE"},{"op":"increment","path":"/version","by":1}]}""",
        )

        val result = interceptor.interceptResponse(req, resp)
        val body = bodyAsMap(result)

        assertEquals("ACTIVE", body["status"])
        assertEquals(2, body["version"])
        assertFalse(body.containsKey("_patches"), "_patches must be stripped")
        assertNull(result.headers["Warning"])
    }

    @Test
    fun `response without _patches passes through untouched`() {
        val resp = response("""{"status":"ACTIVE"}""")
        val result = interceptor.interceptResponse(req, resp)
        assertEquals(resp.body.toStringLiteral(), result.body.toStringLiteral())
        assertNull(result.headers["Warning"])
    }

    @Test
    fun `empty _patches strips the field and applies nothing`() {
        val resp = response("""{"status":"ACTIVE","_patches":[]}""")
        val result = interceptor.interceptResponse(req, resp)
        val body = bodyAsMap(result)
        assertEquals("ACTIVE", body["status"])
        assertFalse(body.containsKey("_patches"))
    }

    @Test
    fun `failed patch preserves the original response and adds a Warning header`() {
        val original =
            """{"status":"PENDING","_patches":[{"op":"replace","path":"/missing","value":"X"}]}"""
        val resp = response(original)

        val result = interceptor.interceptResponse(req, resp)

        // Original body preserved verbatim (atomicity): no field changed.
        assertEquals(original, result.body.toStringLiteral())
        val warning = result.headers["Warning"]
        assertTrue(warning != null && warning.startsWith("199 potemkin"), "Warning header: $warning")
        assertTrue(warning.contains("replace"), "Warning describes the failing op: $warning")
    }

    @Test
    fun `malformed _patches entry yields a Warning and preserves the body`() {
        val original = """{"x":1,"_patches":[{"op":"frobnicate","path":"/x"}]}"""
        val resp = response(original)

        val result = interceptor.interceptResponse(req, resp)

        assertEquals(original, result.body.toStringLiteral())
        assertTrue(result.headers["Warning"]?.startsWith("199 potemkin") == true)
    }

    @Test
    fun `applies array and merge ops`() {
        val resp = response(
            """{"items":[1,2],"meta":{"a":1},"_patches":[{"op":"append","path":"/items","value":3},{"op":"merge","path":"/meta","value":{"b":2}}]}""",
        )
        val body = bodyAsMap(interceptor.interceptResponse(req, resp))
        assertEquals(listOf(1, 2, 3), body["items"])
        @Suppress("UNCHECKED_CAST")
        val meta = body["meta"] as Map<String, Any?>
        assertEquals(mapOf("a" to 1, "b" to 2), meta)
    }

    @Test
    fun `non-json body passes through untouched`() {
        val resp = response("not json but mentions _patches somehow")
        val result = interceptor.interceptResponse(req, resp)
        assertEquals(resp.body.toStringLiteral(), result.body.toStringLiteral())
    }
}
