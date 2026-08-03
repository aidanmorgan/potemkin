package com.potemkin.specmatic

import io.specmatic.core.HttpRequest
import io.specmatic.stub.HttpStubResponse

/**
 * Port used by the Specmatic request handler to reach the Node engine.
 *
 * Production supplies [com.potemkin.specmatic.reliability.ResilientForwarder],
 * which owns retry and circuit-breaker policy. The nullable result is reserved
 * for a forwarding implementation that cannot produce a response; the
 * production implementation converts that condition into a 503 response.
 */
interface EngineRequestForwarder {
    fun forward(httpRequest: HttpRequest): HttpStubResponse?

    /** Proxy non-contract control requests under the admin prefix to the engine. */
    fun proxyRaw(httpRequest: HttpRequest): HttpStubResponse?
}
