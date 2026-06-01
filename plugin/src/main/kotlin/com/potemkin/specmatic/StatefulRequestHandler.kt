package com.potemkin.specmatic

import com.potemkin.specmatic.reliability.ResilientForwarder
import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.core.value.StringValue
import io.specmatic.stub.HttpStubResponse
import io.specmatic.stub.RequestHandler
import org.slf4j.LoggerFactory

/**
 * Specmatic [RequestHandler] that intercepts requests whose paths are owned by the Node CQRS
 * engine (as discovered at runtime via [RoutesDiscoveryClient]) and forwards them to the engine
 * via [ResilientForwarder] (resilience4j retry + circuit-breaker wrapper around [CqrsBackendClient]).
 *
 * Contract:
 * - Returns `null` for any (method, path) tuple that was registered as a Specmatic stub via
 *   [FixturesClient.excludedPaths] → Specmatic serves the registered stub directly.
 * - Returns `null` for any path that is NOT a discovered stateful route → Specmatic continues.
 * - Returns a **503** [HttpStubResponse] when the resilient forwarder definitively fails
 *   (retries exhausted, circuit open) for a path we own — so the client sees a clear error
 *   rather than Specmatic generating a fake success response.
 * - Returns the engine's response for matched paths that the engine handles successfully.
 * - NEVER throws — all exceptions are caught internally so Specmatic is never disrupted.
 *
 * The [client] parameter accepts either a [CqrsBackendClient] (legacy / test path) or a
 * [ResilientForwarder] (production). Both are subtypes of [ForwardingClient] (structural
 * duck-typed via the [forward] extension inside this file) — since [CqrsBackendClient]
 * returns nullable and [ResilientForwarder] is non-nullable, [StatefulRequestHandler]
 * wraps the call in a common [forward] helper.
 */
class StatefulRequestHandler(
    private val discovery: RoutesDiscoveryClient,
    private val client: CqrsBackendClient,
    private val fixtures: FixturesClient? = null,
    private val resilientForwarder: ResilientForwarder? = null,
    private val workflow: WorkflowPropagator? = null,
) : RequestHandler {

    override val name: String = "potemkin-stateful"

    private val log = LoggerFactory.getLogger(StatefulRequestHandler::class.java)

    override fun handleRequest(rawRequest: HttpRequest): HttpStubResponse? {
        return try {
            // Substitute captured workflow ids into the path BEFORE statefulness/forwarding
            // decisions so the resolved path is used throughout. No-op when no workflow
            // ids are configured.
            val httpRequest = workflow?.applyToRequest(rawRequest) ?: rawRequest
            val method = (httpRequest.method ?: "").uppercase()
            val path = httpRequest.path ?: ""

            // Specmatic internal control surfaces — let Specmatic handle them
            // natively. No logging, no state mutation.
            if (path.startsWith("/_specmatic/") || path.startsWith("/swagger/")) {
                return null
            }

            // JWT auth gate: the request interceptor marks failed verification
            // with PotemkinHeaders.AUTH_ERROR (carrying the WWW-Authenticate
            // challenge). Emit a 401 before doing any forwarding or stub matching.
            httpRequest.headers[PotemkinHeaders.AUTH_ERROR]?.let { challenge ->
                log.debug("Rejecting '{} {}' with 401 — JWT verification failed", method, path)
                return unauthorized(challenge)
            }

            // If this (method, path) was registered as a Specmatic fixture stub, let Specmatic
            // serve it directly. The plugin must not intercept it.
            if (fixtures != null && fixtures.excludedPaths().contains(method to path)) {
                log.debug(
                    "Skipping fixture-excluded path '{} {}' — Specmatic stub will serve it",
                    method,
                    path,
                )
                return null
            }

            if (!discovery.isStateful(path)) {
                return null  // Not our path — let Specmatic handle it.
            }

            // Use the resilient forwarder when available (production path).
            if (resilientForwarder != null) {
                val response = resilientForwarder.forward(httpRequest)
                // 503 from ResilientForwarder means the engine is definitively unavailable.
                // Return it directly so the caller sees the failure.
                if (response.response.status == 503) {
                    log.warn(
                        "Node engine unavailable for owned path '{}' — returning 503",
                        path,
                    )
                }
                workflow?.observeResponse(httpRequest, response.response)
                return response
            }

            // Legacy path: bare CqrsBackendClient (used in existing unit tests).
            val response = client.forward(httpRequest)
            if (response == null) {
                log.debug(
                    "Node engine returned null for path '{}'; falling through to Specmatic stub matching",
                    httpRequest.path,
                )
            } else {
                workflow?.observeResponse(httpRequest, response.response)
            }
            response
        } catch (e: Exception) {
            // Belt-and-suspenders: catch absolutely anything so Specmatic's request loop is never
            // interrupted by plugin code.
            log.error(
                "Unexpected error in StatefulRequestHandler for path '{}': {}; falling through to Specmatic",
                rawRequest.path,
                e.message,
                e,
            )
            null
        }
    }

    /**
     * Build a 401 response with a `WWW-Authenticate: Bearer realm=...` challenge
     * when JWT verification fails.
     */
    private fun unauthorized(challenge: String): HttpStubResponse {
        val body = """{"error":"unauthorized"}"""
        return HttpStubResponse(
            response = HttpResponse(
                status = 401,
                headers = mapOf(
                    "WWW-Authenticate" to challenge,
                    "Content-Type" to "application/json",
                ),
                body = StringValue(body),
            ),
        )
    }
}
