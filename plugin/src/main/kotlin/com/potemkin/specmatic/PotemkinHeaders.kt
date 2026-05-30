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
}
