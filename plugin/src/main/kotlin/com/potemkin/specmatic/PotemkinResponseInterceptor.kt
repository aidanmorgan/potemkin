package com.potemkin.specmatic

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.core.value.StringValue
import io.specmatic.stub.ResponseInterceptor
import org.slf4j.LoggerFactory

/**
 * Global response interceptor.
 *
 * When `/_engine/forward` returns a response whose JSON body carries a top-level
 * `_patches: Patch[]` array, this interceptor applies those patches to the body
 * via the Kotlin [PatchApplier] (a faithful port of the TS `applyPatches`), then
 * strips the `_patches` field so it never leaks to the client (E1).
 *
 * Atomicity (AC-E1.3): patches are applied to a clone of the parsed body. If any
 * op fails, the ORIGINAL response is preserved unchanged and a `Warning` header
 * is attached describing the failure. A successful application replaces the body
 * with the patched JSON.
 *
 * The [mapper] is injected so the interceptor holds no static mutable state.
 */
class PotemkinResponseInterceptor(
    private val mapper: ObjectMapper = jacksonObjectMapper(),
) : ResponseInterceptor {

    private val log = LoggerFactory.getLogger(PotemkinResponseInterceptor::class.java)

    override val name: String = "PotemkinResponseInterceptor"

    override fun interceptResponse(httpRequest: HttpRequest, httpResponse: HttpResponse): HttpResponse {
        val bodyText = httpResponse.body.toStringLiteral()
        if (bodyText.isBlank() || !bodyText.contains("\"_patches\"")) {
            return httpResponse
        }

        val parsed: Any? = try {
            mapper.readValue(bodyText, Any::class.java)
        } catch (e: Exception) {
            // Not JSON we can patch — leave the response untouched.
            return httpResponse
        }

        if (parsed !is Map<*, *> || !parsed.containsKey("_patches")) {
            return httpResponse
        }

        @Suppress("UNCHECKED_CAST")
        val bodyMap = LinkedHashMap(parsed as Map<String, Any?>)
        val patchesRaw = bodyMap.remove("_patches")
        if (patchesRaw !is List<*>) {
            return stripOnly(httpResponse, bodyMap)
        }

        val patches = try {
            Patch.fromList(patchesRaw)
        } catch (e: IllegalArgumentException) {
            return withWarning(httpResponse, "malformed _patches: ${e.message}")
        }

        if (patches.isEmpty()) {
            return stripOnly(httpResponse, bodyMap)
        }

        return try {
            val patched = PatchApplier.apply(bodyMap, patches)
            httpResponse.copy(body = StringValue(mapper.writeValueAsString(patched)))
        } catch (e: PatchApplyException) {
            log.warn(
                "PotemkinResponseInterceptor: patch {} ({}) at {} failed: {} — preserving original response",
                e.patchIndex, e.op, e.path, e.message,
            )
            withWarning(
                httpResponse,
                "_patches op[${e.patchIndex}] '${e.op}' at ${e.path} failed: ${e.message}",
            )
        }
    }

    /** Strip `_patches` (already removed from [bodyMap]) and re-serialise, no ops applied. */
    private fun stripOnly(original: HttpResponse, bodyMap: Map<String, Any?>): HttpResponse =
        original.copy(body = StringValue(mapper.writeValueAsString(bodyMap)))

    /**
     * Preserve the ORIGINAL response body and attach an RFC 7234 `Warning`
     * header (code 199 = miscellaneous warning). The `_patches` field remains
     * in the body because we made no change — Specmatic clients tolerate the
     * extra field, and preserving the original is the documented failure mode.
     */
    private fun withWarning(original: HttpResponse, detail: String): HttpResponse {
        val warning = "199 potemkin \"$detail\""
        return original.copy(headers = original.headers + ("Warning" to warning))
    }
}
