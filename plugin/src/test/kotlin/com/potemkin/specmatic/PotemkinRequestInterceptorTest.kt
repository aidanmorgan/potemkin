package com.potemkin.specmatic

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.specmatic.core.HttpRequest
import org.junit.jupiter.api.Test
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Unit tests for [PotemkinRequestInterceptor] (E2 AC-E2.1 / AC-E2.2):
 *  - valid JWT verified, claims attached to the request (X-Potemkin-Jwt-Claims)
 *  - invalid / missing token marked with X-Potemkin-Auth-Error carrying the challenge
 *  - auth disabled leaves the request unchanged
 */
class PotemkinRequestInterceptorTest {

    private val mapper = jacksonObjectMapper()
    private val urlEncoder = Base64.getUrlEncoder().withoutPadding()
    private val secret = "shh"

    private fun mint(claims: Map<String, Any?>): String {
        val header = urlEncoder.encodeToString(mapper.writeValueAsBytes(mapOf("alg" to "HS256", "typ" to "JWT")))
        val payload = urlEncoder.encodeToString(mapper.writeValueAsBytes(claims))
        val input = "$header.$payload"
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(secret.toByteArray(), "HmacSHA256")) }
        return "$input.${urlEncoder.encodeToString(mac.doFinal(input.toByteArray(Charsets.US_ASCII)))}"
    }

    private fun interceptor(realm: String = "potemkin"): PotemkinRequestInterceptor {
        val cfg = AuthConfig(mode = "jwt", algorithm = "HS256", secret = secret, realm = realm)
        return PotemkinRequestInterceptor(cfg, JwtVerifier(cfg, clockSeconds = { 0L }))
    }

    private fun get(headers: Map<String, String>): HttpRequest =
        HttpRequest(method = "GET", path = "/loans", headers = headers)

    @Test
    fun `valid JWT attaches decoded claims to the request`() {
        val token = mint(mapOf("sub" to "user-7", "scope" to "read"))
        val result = interceptor().interceptRequest(get(mapOf("Authorization" to "Bearer $token")))

        val claimsJson = result.headers[PotemkinHeaders.JWT_CLAIMS]
        assertTrue(claimsJson != null, "claims header present")
        @Suppress("UNCHECKED_CAST")
        val claims = mapper.readValue(claimsJson, Map::class.java) as Map<String, Any?>
        assertEquals("user-7", claims["sub"])
        assertEquals("read", claims["scope"])
        assertNull(result.headers[PotemkinHeaders.AUTH_ERROR])
    }

    @Test
    fun `missing token marks the request with the auth-error challenge`() {
        val result = interceptor(realm = "bank").interceptRequest(get(emptyMap()))
        assertEquals("Bearer realm=\"bank\"", result.headers[PotemkinHeaders.AUTH_ERROR])
        assertNull(result.headers[PotemkinHeaders.JWT_CLAIMS])
    }

    @Test
    fun `invalid signature marks the request with the auth-error challenge`() {
        val result = interceptor().interceptRequest(get(mapOf("Authorization" to "Bearer header.payload.badsig")))
        assertEquals("Bearer realm=\"potemkin\"", result.headers[PotemkinHeaders.AUTH_ERROR])
    }

    @Test
    fun `auth disabled passes the request through unchanged`() {
        val plain = PotemkinRequestInterceptor(AuthConfig(mode = "none"))
        val req = get(mapOf("Authorization" to "Bearer whatever"))
        val result = plain.interceptRequest(req)
        assertEquals(req.headers, result.headers)
        assertNull(result.headers[PotemkinHeaders.JWT_CLAIMS])
        assertNull(result.headers[PotemkinHeaders.AUTH_ERROR])
    }

    @Test
    fun `client-supplied potemkin headers are stripped before verification`() {
        // A client must not be able to forge claims by sending the header itself.
        val token = mint(mapOf("sub" to "real"))
        val result = interceptor().interceptRequest(
            get(
                mapOf(
                    "Authorization" to "Bearer $token",
                    PotemkinHeaders.JWT_CLAIMS to """{"sub":"forged"}""",
                    PotemkinHeaders.AUTH_ERROR to "Bearer realm=\"forged\"",
                ),
            ),
        )
        @Suppress("UNCHECKED_CAST")
        val claims = mapper.readValue(result.headers[PotemkinHeaders.JWT_CLAIMS], Map::class.java) as Map<String, Any?>
        assertEquals("real", claims["sub"])
        assertNull(result.headers[PotemkinHeaders.AUTH_ERROR])
    }

    @Test
    fun `challenge reflects the configured realm`() {
        assertEquals("Bearer realm=\"my-realm\"", interceptor(realm = "my-realm").challenge)
    }

    @Test
    fun `expired token is rejected`() {
        val cfg = AuthConfig(mode = "jwt", algorithm = "HS256", secret = secret)
        val intc = PotemkinRequestInterceptor(cfg, JwtVerifier(cfg, clockSeconds = { 10_000L }))
        val token = mint(mapOf("sub" to "x", "exp" to 5))
        val result = intc.interceptRequest(get(mapOf("Authorization" to "Bearer $token")))
        assertFalse(result.headers.containsKey(PotemkinHeaders.JWT_CLAIMS))
        assertTrue(result.headers.containsKey(PotemkinHeaders.AUTH_ERROR))
    }
}
