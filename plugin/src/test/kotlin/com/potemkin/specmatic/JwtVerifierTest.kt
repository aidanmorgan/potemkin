package com.potemkin.specmatic

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.junit.jupiter.api.Test
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Unit tests for [JwtVerifier] — HS256 round-trip and expiry (AC-E2.3).
 */
class JwtVerifierTest {

    private val mapper = jacksonObjectMapper()
    private val urlEncoder = Base64.getUrlEncoder().withoutPadding()

    private fun mintHs256(secret: String, claims: Map<String, Any?>, alg: String = "HS256"): String {
        val header = encode(mapOf("alg" to alg, "typ" to "JWT"))
        val payload = encode(claims)
        val signingInput = "$header.$payload"
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(), "HmacSHA256"))
        val sig = urlEncoder.encodeToString(mac.doFinal(signingInput.toByteArray(Charsets.US_ASCII)))
        return "$signingInput.$sig"
    }

    private fun encode(obj: Any): String =
        urlEncoder.encodeToString(mapper.writeValueAsBytes(obj))

    private fun verifier(secret: String, now: Long = 1_000L): JwtVerifier =
        JwtVerifier(AuthConfig(mode = "jwt", algorithm = "HS256", secret = secret), clockSeconds = { now })

    @Test
    fun `valid HS256 token verifies and exposes claims`() {
        val token = mintHs256("topsecret", mapOf("sub" to "user-42", "role" to "admin"))

        val result = verifier("topsecret").verify(token)

        assertTrue(result is JwtResult.Valid)
        assertEquals("user-42", (result as JwtResult.Valid).claims["sub"])
        assertEquals("admin", result.claims["role"])
    }

    @Test
    fun `HS256 token with wrong secret fails`() {
        val token = mintHs256("topsecret", mapOf("sub" to "x"))
        val result = verifier("different-secret").verify(token)
        assertTrue(result is JwtResult.Invalid)
    }

    @Test
    fun `expired HS256 token fails`() {
        val token = mintHs256("topsecret", mapOf("sub" to "x", "exp" to 500))
        val result = verifier("topsecret", now = 1_000L).verify(token)
        assertTrue(result is JwtResult.Invalid)
        assertTrue((result as JwtResult.Invalid).reason.contains("expired"))
    }

    @Test
    fun `unexpired HS256 token with future exp verifies`() {
        val token = mintHs256("topsecret", mapOf("sub" to "x", "exp" to 5_000))
        val result = verifier("topsecret", now = 1_000L).verify(token)
        assertTrue(result is JwtResult.Valid)
    }

    @Test
    fun `not-yet-valid token (nbf in future) fails`() {
        val token = mintHs256("topsecret", mapOf("sub" to "x", "nbf" to 2_000))
        val result = verifier("topsecret", now = 1_000L).verify(token)
        assertTrue(result is JwtResult.Invalid)
        assertTrue((result as JwtResult.Invalid).reason.contains("nbf"))
    }

    @Test
    fun `malformed token (not 3 segments) fails`() {
        val result = verifier("topsecret").verify("not.a.valid.jwt.shape")
        assertTrue(result is JwtResult.Invalid)
    }

    @Test
    fun `algorithm mismatch fails`() {
        // Token minted claiming RS256 but verifier configured for HS256.
        val token = mintHs256("topsecret", mapOf("sub" to "x"), alg = "RS256")
        val result = verifier("topsecret").verify(token)
        assertTrue(result is JwtResult.Invalid)
        assertTrue((result as JwtResult.Invalid).reason.contains("algorithm"))
    }
}
