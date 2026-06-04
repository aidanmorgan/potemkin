package com.potemkin.specmatic

import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.stub.HttpStubResponse
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.slf4j.LoggerFactory
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * HTTP client that forwards intercepted Specmatic requests to the Node CQRS engine's
 * `POST /_engine/forward` endpoint and converts the response back into an [HttpStubResponse].
 *
 * Failure modes (connection error, timeout, 5xx from engine) all return `null` so that
 * Specmatic falls through to its own stub/example matching rather than returning an error.
 *
 * 4xx responses from the engine are treated as deliberate client errors and are propagated.
 */
open class CqrsBackendClient(
    private val backendUrl: String,
    timeoutMs: Long = 5_000,
) {
    private val log = LoggerFactory.getLogger(CqrsBackendClient::class.java)
    private val json = JSON_MEDIA_TYPE.toMediaType()
    private val mapper = jacksonObjectMapper().apply {
        configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
    }
    private val http = OkHttpClient.Builder()
        .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        .build()

    /** Resolves declared form-field types so form requests forward as typed JSON. */
    protected open val formFieldIndex: FormFieldIndex = FormFieldIndex(backendUrl, http)

    /**
     * Serialises [httpRequest] as a [ForwardedRequest] JSON body, POSTs it to `<backendUrl>/_engine/forward`,
     * and converts the [ForwardedResponse] back into an [HttpStubResponse].
     *
     * Returns `null` when:
     * - The engine is unreachable (connection refused, DNS failure, etc.)
     * - The call times out
     * - The engine returns 5xx
     * - The response body is not valid JSON / cannot be deserialised
     */
    open fun forward(httpRequest: HttpRequest): HttpStubResponse? {
        val forwardedReq = buildForwardedRequest(httpRequest)
        val bodyJson = try {
            mapper.writeValueAsString(forwardedReq)
        } catch (e: Exception) {
            log.error("Failed to serialise forwarded request for path '{}': {}", httpRequest.path, e.message)
            return null
        }

        val request = Request.Builder()
            .url("$backendUrl/_engine/forward")
            .post(bodyJson.toRequestBody(json))
            .build()

        return try {
            http.newCall(request).execute().use { response ->
                val statusCode = response.code
                if (statusCode in 500..599) {
                    log.warn(
                        "Node engine returned {} for path '{}'; falling through to Specmatic",
                        statusCode,
                        httpRequest.path,
                    )
                    return null
                }

                val responseBodyString = response.body?.string() ?: "{}"
                val forwardedResp = try {
                    mapper.readValue<ForwardedResponse>(responseBodyString)
                } catch (e: Exception) {
                    log.warn(
                        "Malformed JSON from Node engine for path '{}': {}; falling through to Specmatic",
                        httpRequest.path,
                        e.message,
                    )
                    return null
                }

                // A ForwardedResponse envelope always carries a real HTTP status. A status of
                // 0 means the engine returned a non-envelope body (e.g. a bare {error,message}
                // rejection) that Jackson coerced into the default Int. Emitting that verbatim
                // would surface an invalid "status 0" to Specmatic, so fall through to null and
                // let the resilient forwarder report a definitive failure instead.
                if (forwardedResp.status == 0) {
                    log.warn(
                        "Node engine returned non-envelope body for path '{}' (HTTP {}): {}; falling through",
                        httpRequest.path,
                        statusCode,
                        responseBodyString.take(200),
                    )
                    return null
                }

                buildHttpStubResponse(forwardedResp)
            }
        } catch (e: IOException) {
            log.warn(
                "IO error forwarding path '{}' to Node engine: {}; falling through to Specmatic",
                httpRequest.path,
                e.message,
            )
            null
        } catch (e: Exception) {
            log.warn(
                "Unexpected error forwarding path '{}' to Node engine: {}; falling through to Specmatic",
                httpRequest.path,
                e.message,
            )
            null
        }
    }

    /**
     * Raw passthrough proxy to the engine for NON-contract control paths under `/_admin/`.
     *
     * Unlike [forward], this does NOT wrap the request in a ForwardedRequest envelope or post
     * to `/_engine/forward` — admin endpoints live directly on the engine's Express app
     * ([registerAdminRoutes]). It replays method/path/query/body/headers verbatim to
     * `<backendUrl><path>` and returns the engine's response as-is, so a consumer can
     * reset/advance-clock/register-faults THROUGH the Specmatic stub. The Authorization
     * header (admin token) is preserved by the header copy.
     *
     * Returns `null` on any transport error so Specmatic falls through rather than break.
     */
    open fun proxyRaw(httpRequest: HttpRequest): HttpStubResponse? {
        val method = (httpRequest.method ?: "GET").uppercase()
        val path = httpRequest.path ?: "/"
        val base = "$backendUrl$path".toHttpUrlOrNull() ?: return null
        val urlBuilder = base.newBuilder()
        httpRequest.queryParams.paramPairs.forEach { (k, v) -> urlBuilder.addQueryParameter(k, v) }

        val rawBody = httpRequest.body.toStringLiteral()
        val outBody = if (rawBody.isNotBlank()) rawBody.toRequestBody(json) else null
        val builder = Request.Builder().url(urlBuilder.build())
        // Copy request headers, dropping hop-by-hop / framing headers OkHttp manages itself.
        httpRequest.headers.forEach { (k, v) ->
            if (k.lowercase() !in HOP_BY_HOP_HEADERS) builder.header(k, v)
        }
        when (method) {
            "GET" -> builder.get()
            "HEAD" -> builder.head()
            "DELETE" -> if (outBody != null) builder.delete(outBody) else builder.delete()
            "POST" -> builder.post(outBody ?: ByteArray(0).toRequestBody(json))
            "PUT" -> builder.put(outBody ?: ByteArray(0).toRequestBody(json))
            "PATCH" -> builder.patch(outBody ?: ByteArray(0).toRequestBody(json))
            else -> builder.method(method, outBody)
        }

        return try {
            http.newCall(builder.build()).execute().use { response ->
                val bodyString = response.body?.string() ?: ""
                HttpStubResponse(
                    response = HttpResponse(
                        status = response.code,
                        headers = response.headers.toMap(),
                        body = io.specmatic.core.value.StringValue(bodyString),
                    ),
                )
            }
        } catch (e: Exception) {
            log.warn("Admin proxy error for '{}': {}; falling through to Specmatic", path, e.message)
            null
        }
    }

    // ---- private helpers ----------------------------------------------------------------

    private fun buildForwardedRequest(req: HttpRequest): ForwardedRequest {
        val method = req.method ?: "GET"
        val path = req.path ?: "/"

        // x-www-form-urlencoded: Specmatic parses the body into formFields (a string
        // map). Convert it to a typed JSON object — coercing integer/number/boolean
        // fields per the contract — so the engine receives JSON, not a form string.
        val bodyValue: Any? = if (req.formFields.isNotEmpty()) {
            buildFormBody(method, path, req.formFields)
        } else {
            val rawBody = req.body.toStringLiteral().ifBlank { null }
            if (rawBody != null) {
                try {
                    mapper.readValue<Any>(rawBody)
                } catch (_: Exception) {
                    rawBody  // fall back to plain string if not valid JSON
                }
            } else {
                null
            }
        }

        // Build query map preserving multi-value params. paramPairs holds all (key, value)
        // pairs including repeated keys. A key with a single value becomes a bare String
        // (matching the common case), while a key with multiple values becomes a List<String>
        // so Jackson serialises it as a JSON array. This aligns with the TS engine type
        // Record<string, string | string[]>.
        val query: Map<String, Any> = req.queryParams.paramPairs
            .groupBy({ it.first }, { it.second })
            .mapValues { (_, values) -> if (values.size == 1) values[0] else values }

        return ForwardedRequest(
            method = req.method ?: "GET",
            path = req.path ?: "/",
            headers = req.headers,
            body = bodyValue,
            query = query,
        )
    }

    /**
     * Convert Specmatic's parsed form fields into a typed JSON object. Flat fields
     * are coerced to their contract type; one level of bracket notation
     * (`metadata[key]=v`) becomes a nested object of strings (Stripe metadata).
     */
    private fun buildFormBody(method: String, path: String, formFields: Map<String, String>): Map<String, Any?> {
        val obj = LinkedHashMap<String, Any?>()
        for ((rawKey, value) in formFields) {
            val m = BRACKET.matchEntire(rawKey)
            if (m != null) {
                val base = m.groupValues[1]
                val sub = m.groupValues[2]
                @Suppress("UNCHECKED_CAST")
                val nested = obj.getOrPut(base) { LinkedHashMap<String, Any?>() } as MutableMap<String, Any?>
                nested[sub] = value
            } else {
                obj[rawKey] = formFieldIndex.coerce(method, path, rawKey, value)
            }
        }
        return obj
    }

    private fun buildHttpStubResponse(resp: ForwardedResponse): HttpStubResponse {
        val bodyString = serialiseBodyWithPatches(resp)
        // Drop-connection chaos note: when the engine's forwarding layer fires drop-connection
        // chaos it cannot destroy the upstream socket (only gateway.ts can do that via
        // `res.socket?.destroy()`). Instead it sends a synthetic 504 with header
        // `x-potemkin-dropped: true` (PotemkinHeaders.DROPPED). The plugin has no API to
        // abort the Specmatic HTTP connection from inside a RequestHandler — the Specmatic
        // stub framework only accepts an HttpResponse, not a raw socket close. The 504 is
        // therefore propagated verbatim. Plugin-path drop-connection chaos means 504, not
        // a TCP reset. This divergence from the gateway path is intentional and known.
        val httpResponse = HttpResponse(
            status = resp.status,
            headers = resp.headers,
            body = io.specmatic.core.value.StringValue(bodyString),
        )
        return HttpStubResponse(response = httpResponse)
    }

    /**
     * Serialise the forwarded body, applying the engine's out-of-band `_patches` envelope
     * (HATEOAS/mask/etc.) so the served body carries the mutated shape.
     *
     * Specmatic 2.46.2 runs [io.specmatic.stub.ResponseInterceptor]s ONLY on responses it
     * generates from its own stub matching — NOT on responses returned by a registered
     * [io.specmatic.stub.RequestHandler] (verified by decompiling
     * io.specmatic.stub.HttpStub$environment$1$1$1: after `RequestHandler.handleRequest`
     * returns non-null, the response is written via `respondToKtorHttpResponse` and the
     * `applyResponseInterceptors` branch is never entered). Since the forwarded response is
     * produced by [StatefulRequestHandler], the plugin must apply the patches here, using the
     * same [PatchApplier] the interceptor uses — keeping the served body and the
     * [PotemkinResponseInterceptor] replay path (for Specmatic-served bodies) op-for-op equal.
     *
     * Patches only apply to an object body. A non-object body (string/array/null) is emitted
     * as-is. A malformed/failing patch set leaves the base body unchanged (the engine already
     * validated the base; never disrupt the response).
     */
    private fun serialiseBodyWithPatches(resp: ForwardedResponse): String {
        val body = resp.body
        val patchesRaw = resp.patches
        if (!patchesRaw.isNullOrEmpty() && body is Map<*, *>) {
            val patched = try {
                val patches = Patch.fromList(patchesRaw)
                @Suppress("UNCHECKED_CAST")
                // Response-mutation patches are produced by the engine for autoVivify
                // application (src/http/responseMutations.ts): a `merge /_links` on a body
                // without `_links` must create it. Apply with the same semantics for parity.
                PatchApplier.apply(body as Map<String, Any?>, patches, autoVivify = true)
            } catch (e: Exception) {
                log.warn("Failed to apply response _patches; emitting base body: {}", e.message)
                body
            }
            return mapper.writeValueAsString(patched)
        }
        return when (body) {
            null -> ""
            is String -> body
            else -> mapper.writeValueAsString(body)
        }
    }

    companion object {
        private const val JSON_MEDIA_TYPE = "application/json; charset=utf-8"

        /** One level of form bracket notation: `metadata[key]`. */
        private val BRACKET = Regex("""^([^\[]+)\[([^\]]+)\]$""")

        /** Framing/hop-by-hop headers OkHttp sets itself; never copy these on a proxied request. */
        private val HOP_BY_HOP_HEADERS = setOf(
            "host", "content-length", "connection", "transfer-encoding", "keep-alive",
            "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade",
        )
    }
}
