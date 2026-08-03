package com.potemkin.specmatic

import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.core.value.StringValue
import io.specmatic.stub.HttpStubResponse
import io.specmatic.stub.RequestHandler
import org.slf4j.LoggerFactory

/**
 * Specmatic [RequestHandler] that intercepts requests whose paths are owned by the Node CQRS
 * engine (as discovered at runtime via [RoutesDiscoveryClient]) and forwards them through the
 * injected [EngineRequestForwarder]. Production supplies the resilience policy as that strategy.
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
 */
class StatefulRequestHandler(
    private val discovery: RoutesDiscoveryClient,
    private val forwarder: EngineRequestForwarder,
    private val fixtures: FixturesClient? = null,
    private val workflow: WorkflowPropagator? = null,
    private val fallback: FallbackPolicy? = null,
    /** (METHOD, path) tuples that Specmatic serves via a registered seed — the
     *  fallback must defer to Specmatic for these, not preempt them. */
    private val seededPaths: Set<Pair<String, String>> = emptySet(),
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
                return unauthorized(challenge, httpRequest.headers[PotemkinHeaders.AUTH_ERROR_CODE])
            }

            // Admin control surface: proxy requests under /_admin/ straight to the engine's
            // admin routes (reset, clock, faults, state). These are NOT contract paths and not
            // handled via /_engine/forward — a raw passthrough lets a consumer force state
            // THROUGH the stub URL (the Authorization admin token is preserved by the header copy).
            if (path.startsWith("/_admin/")) {
                val adminResp = forwarder.proxyRaw(httpRequest)
                if (adminResp != null) return adminResp
                log.warn("Admin proxy for '{} {}' failed; falling through to Specmatic", method, path)
                return null
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

            // A registered seed is intentional Specmatic-served content. Check this
            // before discovery because the engine advertises the complete OpenAPI
            // surface, including paths that are owned by a seed rather than a runtime
            // boundary.
            if (seededPaths.contains(method to path)) {
                return null
            }

            if (!discovery.isStateful(path)) {
                // Otherwise apply the engine's `fallback:` policy (static 501/404/custom)
                // so the stub behaves like the direct engine, rather than letting
                // Specmatic generate an example. When no fallback policy is wired,
                // fall through to Specmatic.
                return fallback?.evaluate(method, path)
            }

            val response = forwarder.forward(httpRequest)
            if (response == null) {
                log.debug(
                    "Engine forwarder returned no response for path '{}'; falling through to Specmatic stub matching",
                    httpRequest.path,
                )
            } else {
                workflow?.observeResponse(httpRequest, response.response)
                if (response.response.status == 503) {
                    log.warn("Node engine unavailable for owned path '{}' — returning 503", path)
                }
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
    private fun unauthorized(challenge: String, code: String? = null): HttpStubResponse {
        val body = if (code === null) {
            """{"error":"unauthorized"}"""
        } else {
            """{"code":"$code","message":"Authentication failed","details":{"code":"$code"},"error":"$code"}"""
        }
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
