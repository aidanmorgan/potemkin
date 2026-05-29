package com.potemkin.specmatic

import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.stub.HttpStubResponse
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

    // ---- private helpers ----------------------------------------------------------------

    private fun buildForwardedRequest(req: HttpRequest): ForwardedRequest {
        val rawBody = req.body.toStringLiteral().ifBlank { null }
        val bodyValue: Any? = if (rawBody != null) {
            try {
                mapper.readValue<Any>(rawBody)
            } catch (_: Exception) {
                rawBody  // fall back to plain string if not valid JSON
            }
        } else {
            null
        }

        return ForwardedRequest(
            method = req.method ?: "GET",
            path = req.path ?: "/",
            headers = req.headers,
            body = bodyValue,
            queryParams = req.queryParams.asMap(),
        )
    }

    private fun buildHttpStubResponse(resp: ForwardedResponse): HttpStubResponse {
        val bodyString = when (val b = resp.body) {
            null -> ""
            is String -> b
            else -> mapper.writeValueAsString(b)
        }
        val httpResponse = HttpResponse(
            status = resp.status,
            headers = resp.headers,
            body = io.specmatic.core.value.StringValue(bodyString),
        )
        return HttpStubResponse(response = httpResponse)
    }

    companion object {
        private const val JSON_MEDIA_TYPE = "application/json; charset=utf-8"
    }
}
