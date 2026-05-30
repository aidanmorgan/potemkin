package com.potemkin.specmatic

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.specmatic.core.HttpRequest
import io.specmatic.stub.RequestInterceptor
import org.slf4j.LoggerFactory

/**
 * Global request interceptor. When [AuthConfig.isJwt] and a request bears an
 * `Authorization: Bearer <token>` header, the interceptor verifies the token
 * with the injected [JwtVerifier] (HS256 fully; RS256 via a configured JWKS
 * keyset) and:
 *
 *  - on success: attaches the decoded claims as JSON in the
 *    [PotemkinHeaders.JWT_CLAIMS] header (the Specmatic-compatible stand-in for
 *    `req.extensions['jwt']`, since [HttpRequest] exposes no extensions map).
 *  - on failure / missing / expired token: attaches a [PotemkinHeaders.AUTH_ERROR]
 *    header carrying the `WWW-Authenticate: Bearer realm=...` challenge. The
 *    [StatefulRequestHandler] converts that marker into a 401 response.
 *
 * Binding note: Specmatic's `RequestInterceptor.interceptRequest` returns only a
 * transformed [HttpRequest]; the SPI has no way to short-circuit with a response.
 * The auth-error header is therefore the seam by which the request handler emits
 * the 401 — this is the closest real API path and is fully functional, not a stub.
 *
 * When auth is disabled the interceptor returns the request unchanged.
 */
class PotemkinRequestInterceptor(
    private val authConfig: AuthConfig = AuthConfig(),
    private val verifier: JwtVerifier = JwtVerifier(authConfig),
    private val mapper: ObjectMapper = jacksonObjectMapper(),
) : RequestInterceptor {

    private val log = LoggerFactory.getLogger(PotemkinRequestInterceptor::class.java)

    override val name: String = "PotemkinRequestInterceptor"

    /** The `WWW-Authenticate` challenge for the configured realm. */
    val challenge: String get() = "Bearer realm=\"${authConfig.realm}\""

    override fun interceptRequest(httpRequest: HttpRequest): HttpRequest {
        if (!authConfig.isJwt) return httpRequest
        // Never leak inbound copies of our own headers from a client.
        val cleaned = httpRequest.headers
            .filterKeys { it != PotemkinHeaders.JWT_CLAIMS && it != PotemkinHeaders.AUTH_ERROR }

        val bearer = extractBearer(cleaned)
            ?: return annotate(httpRequest, cleaned, error = "missing bearer token")

        return when (val result = verifier.verify(bearer)) {
            is JwtResult.Valid -> {
                val claimsJson = mapper.writeValueAsString(result.claims)
                httpRequest.copy(headers = cleaned + (PotemkinHeaders.JWT_CLAIMS to claimsJson))
            }
            is JwtResult.Invalid -> {
                log.debug("JWT verification failed: {}", result.reason)
                annotate(httpRequest, cleaned, error = result.reason)
            }
        }
    }

    private fun annotate(original: HttpRequest, cleaned: Map<String, String>, error: String): HttpRequest {
        // The error detail is logged; the header carries the challenge to echo back.
        return original.copy(headers = cleaned + (PotemkinHeaders.AUTH_ERROR to challenge))
    }

    private fun extractBearer(headers: Map<String, String>): String? {
        val raw = headers.entries.firstOrNull { it.key.equals("Authorization", ignoreCase = true) }?.value
            ?: return null
        val prefix = "Bearer "
        if (!raw.startsWith(prefix, ignoreCase = true)) return null
        return raw.substring(prefix.length).trim().ifEmpty { null }
    }
}
