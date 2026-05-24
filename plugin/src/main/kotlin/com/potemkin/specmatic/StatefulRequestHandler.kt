package com.potemkin.specmatic

import io.specmatic.core.HttpRequest
import io.specmatic.stub.HttpStubResponse
import io.specmatic.stub.RequestHandler
import org.slf4j.LoggerFactory

/**
 * Specmatic [RequestHandler] that intercepts requests whose paths are owned by the Node CQRS
 * engine (as discovered at runtime via [RoutesDiscoveryClient]) and forwards them to the engine
 * via [CqrsBackendClient].
 *
 * Contract:
 * - Returns `null` for any (method, path) tuple that was registered as a Specmatic stub via
 *   [FixturesClient.excludedPaths] → Specmatic serves the registered stub directly.
 * - Returns `null` for any path that is NOT a discovered stateful route → Specmatic continues.
 * - Returns `null` when the backend client cannot reach the engine → Specmatic falls through.
 * - Returns the engine's response for matched paths that the engine handles successfully.
 * - NEVER throws — all exceptions are caught internally so Specmatic is never disrupted.
 */
class StatefulRequestHandler(
    private val discovery: RoutesDiscoveryClient,
    private val client: CqrsBackendClient,
    private val fixtures: FixturesClient? = null,
) : RequestHandler {

    override val name: String = "potemkin-stateful"

    private val log = LoggerFactory.getLogger(StatefulRequestHandler::class.java)

    override fun handleRequest(httpRequest: HttpRequest): HttpStubResponse? {
        return try {
            // If this (method, path) was registered as a Specmatic fixture stub, let Specmatic
            // serve it directly. The plugin must not intercept it.
            val method = (httpRequest.method ?: "").uppercase()
            val path = httpRequest.path ?: ""
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

            val response = client.forward(httpRequest)
            if (response == null) {
                log.debug(
                    "Node engine returned null for path '{}'; falling through to Specmatic stub matching",
                    httpRequest.path,
                )
            }
            response
        } catch (e: Exception) {
            // Belt-and-suspenders: catch absolutely anything so Specmatic's request loop is never
            // interrupted by plugin code.
            log.error(
                "Unexpected error in StatefulRequestHandler for path '{}': {}; falling through to Specmatic",
                httpRequest.path,
                e.message,
                e,
            )
            null
        }
    }
}
