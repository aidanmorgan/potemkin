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
 * Unit tests for [PotemkinResponseInterceptor]:
 *  - reads `_patches` and applies them to the response body
 *  - covers all 10 ops via [PatchApplier] (parity verified in [PatchApplierTest])
 *  - patch failure preserves the original response and adds a `Warning` header
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

    @Test
    fun `Warning header with double-quote and CRLF in detail is well-formed single line`() {
        // Construct a response whose patch detail contains a double-quote and CRLF
        // so we can verify the Warning header is a valid quoted-string on one line.
        val malformedPatch = """{"x":1,"_patches":[{"op":"frobnicate","path":"/x\"evil\r\nInjected:hdr"}]}"""
        val resp = response(malformedPatch)

        val result = interceptor.interceptResponse(req, resp)

        val warning = result.headers["Warning"]
        assertTrue(warning != null, "Warning header must be present")
        // Must be a single line (no CR or LF).
        assertFalse(warning!!.contains('\r'), "Warning header must not contain CR: $warning")
        assertFalse(warning.contains('\n'), "Warning header must not contain LF: $warning")
        // Must start and end with a valid 199 potemkin quoted-string.
        assertTrue(warning.startsWith("199 potemkin \""), "Warning must start with '199 potemkin \"': $warning")
        assertTrue(warning.endsWith("\""), "Warning must end with closing quote: $warning")
        // The embedded double-quote must be escaped, not raw.
        val detail = warning.removePrefix("199 potemkin \"").removeSuffix("\"")
        assertFalse(detail.contains('"'), "Unescaped double-quote must not appear in detail: $detail")
    }

    @Test
    fun `Warning header backslash in detail is escaped so quoted-string is well-formed`() {
        // A path ending in a backslash: without proper escaping the backslash would
        // escape the closing quote and corrupt the RFC-7234 quoted-string.
        // A backslash immediately before a quote is the worst case: \\" must become \\\\\"
        // so the parser sees one escaped backslash followed by an escaped quote.
        val malformedPatch = """{"x":1,"_patches":[{"op":"replace","path":"/missing\\"}]}"""
        val resp = response(malformedPatch)

        val result = interceptor.interceptResponse(req, resp)

        val warning = result.headers["Warning"]
        assertTrue(warning != null, "Warning header must be present")
        assertFalse(warning!!.contains('\r'), "Warning header must not contain CR: $warning")
        assertFalse(warning.contains('\n'), "Warning header must not contain LF: $warning")
        assertTrue(warning.startsWith("199 potemkin \""), "Warning must start with '199 potemkin \"': $warning")
        assertTrue(warning.endsWith("\""), "Warning must end with closing quote: $warning")
        // Parse the detail between the outer quotes; it must have no raw unescaped double-quote.
        val detail = warning.removePrefix("199 potemkin \"").removeSuffix("\"")
        assertFalse(detail.contains('"'), "Unescaped double-quote must not appear in detail: $detail")
        // The backslash must have been escaped to \\ in the output.
        assertTrue(detail.contains("\\\\"), "Backslash must be escaped to \\\\ in detail: $detail")
    }

    @Test
    fun `Warning header backslash-before-quote in detail is escaped correctly`() {
        // Path is /foo\" — the backslash is immediately before a double-quote.
        // Without correct ordering (escape \ first, then "), the \" pair at the end of the
        // header value would escape the closing quote and corrupt the RFC-7234 quoted-string.
        val malformedPatch = """{"x":1,"_patches":[{"op":"replace","path":"/foo\\\""}]}"""
        val resp = response(malformedPatch)

        val result = interceptor.interceptResponse(req, resp)

        val warning = result.headers["Warning"]
        assertTrue(warning != null, "Warning header must be present")
        assertTrue(warning!!.startsWith("199 potemkin \""), "Warning must start with '199 potemkin \"': $warning")
        assertFalse(warning.contains('\r') || warning.contains('\n'), "Warning must be a single line: $warning")
        // The closing quote must NOT be preceded by an odd number of backslashes (which would
        // escape it and corrupt the quoted-string). With correct escaping the trailing backslash
        // is doubled so the closing quote is a genuine terminator.
        assertTrue(warning.endsWith("\""), "Warning must end with a quote: $warning")
        // Count backslashes immediately before the final quote.
        val beforeLastQuote = warning.dropLast(1)
        val trailingBackslashes = beforeLastQuote.reversed().takeWhile { it == '\\' }.length
        assertEquals(
            0,
            trailingBackslashes % 2,
            "Closing quote must not be escaped (backslash count before it must be even): $warning",
        )
    }
}
