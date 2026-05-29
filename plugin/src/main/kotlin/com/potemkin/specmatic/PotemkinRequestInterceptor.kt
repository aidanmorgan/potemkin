package com.potemkin.specmatic

import io.specmatic.core.HttpRequest
import io.specmatic.stub.RequestInterceptor

// Global request interceptor. Today narrowed to JWT signature verification +
// claim extraction (engine-side); other auth shapes (APIKey, Basic, OAuth2)
// defer to Specmatic's OpenAPISecurityScheme for presence + shape checks.
//
// The interceptor returns the request unchanged for the common case; future
// claim-extraction logic mutates req.extensions.jwt and req.extensions.session
// when the matched security scheme is a JWKS-bearing bearer.
class PotemkinRequestInterceptor : RequestInterceptor {

    override val name: String = "PotemkinRequestInterceptor"

    override fun interceptRequest(httpRequest: HttpRequest): HttpRequest {
        return httpRequest
    }
}
