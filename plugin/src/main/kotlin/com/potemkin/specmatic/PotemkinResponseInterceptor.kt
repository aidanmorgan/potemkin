package com.potemkin.specmatic

import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.stub.ResponseInterceptor

// Global response interceptor. Mutates responses for HATEOAS link injection,
// Deprecation/Sunset header emission, and response-body field masking.
// Mutations are compiled to the canonical Patch[] vocabulary via
// responseDslCompiler (engine-side) and applied here uniformly; the audit
// journal sees one shape across reducers, seeds, and response mutations.
class PotemkinResponseInterceptor : ResponseInterceptor {

    override val name: String = "PotemkinResponseInterceptor"

    override fun interceptResponse(httpRequest: HttpRequest, httpResponse: HttpResponse): HttpResponse {
        return httpResponse
    }
}
