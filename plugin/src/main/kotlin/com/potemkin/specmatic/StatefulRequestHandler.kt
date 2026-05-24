package com.potemkin.specmatic

import io.specmatic.core.HttpRequest
import io.specmatic.stub.HttpStubResponse
import io.specmatic.stub.RequestHandler
import org.slf4j.LoggerFactory

/**
 * Specmatic [RequestHandler] that intercepts requests whose paths match the configured patterns
 * and forwards them to the Node CQRS engine via [CqrsBackendClient].
 *
 * Contract:
 * - Returns `null` for any path that does NOT match the configured patterns → Specmatic continues.
 * - Returns `null` when the backend client cannot reach the engine → Specmatic falls through.
 * - Returns the engine's response for matched paths that the engine handles successfully.
 * - NEVER throws — all exceptions are caught internally so Specmatic is never disrupted.
 */
class StatefulRequestHandler(
    private val matcher: PathMatcher,
    private val client: CqrsBackendClient,
) : RequestHandler {

    override val name: String = "potemkin-stateful"

    private val log = LoggerFactory.getLogger(StatefulRequestHandler::class.java)

    override fun handleRequest(httpRequest: HttpRequest): HttpStubResponse? {
        return try {
            if (!matcher.matches(httpRequest.path)) {
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
