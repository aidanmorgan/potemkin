package com.potemkin.specmatic

/**
 * Canonical `X-Potemkin-*` header names exchanged between the request
 * interceptor and the request handler. Mirrors the project header convention
 * (TS side: `src/http/potemkinHeaders.ts`).
 */
object PotemkinHeaders {
    /** Set by the request interceptor on a successfully-verified JWT; value is JSON-encoded claims. */
    const val JWT_CLAIMS = "X-Potemkin-Jwt-Claims"

    /**
     * Set by the request interceptor when JWT verification fails. The request
     * handler turns this into a 401 + `WWW-Authenticate` challenge. The value is
     * the `WWW-Authenticate` challenge string to echo back.
     */
    const val AUTH_ERROR = "X-Potemkin-Auth-Error"

    /**
     * Optional client-supplied correlation id that scopes workflow id-propagation
     * to a single chain. When two clients run interleaved workflow chains that
     * extract the SAME id name, each sets a distinct value here so their captured
     * ids never clobber one another. See [WorkflowPropagator] for the full
     * session-key resolution order.
     */
    const val WORKFLOW_SESSION = "X-Potemkin-Workflow-Session"
}
