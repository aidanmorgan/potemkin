package com.potemkin.specmatic

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.junit.jupiter.api.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import java.util.Base64
import kotlin.test.assertTrue

/**
 * Unit tests for RS256 verification via a configured JWK keyset, proving the
 * JWKS extension point is functional (not a stub). Uses a generated RSA keypair;
 * the public key is encoded as a JWK (n, e) and supplied via [AuthConfig.jwks].
 */
class JwtRs256Test {

    private val mapper = jacksonObjectMapper()
    private val urlEncoder = Base64.getUrlEncoder().withoutPadding()

    private fun b64u(bytes: ByteArray): String = urlEncoder.encodeToString(bytes)

    @Test
    fun `valid RS256 token verifies against configured JWK`() {
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val pub = pair.public as RSAPublicKey

        val jwk = Jwk(
            kty = "RSA",
            kid = "key-1",
            n = b64u(toUnsigned(pub.modulus.toByteArray())),
            e = b64u(toUnsigned(pub.publicExponent.toByteArray())),
        )

        val header = b64u(mapper.writeValueAsBytes(mapOf("alg" to "RS256", "kid" to "key-1")))
        val payload = b64u(mapper.writeValueAsBytes(mapOf("sub" to "rsa-user")))
        val signingInput = "$header.$payload"
        val sig = Signature.getInstance("SHA256withRSA").run {
            initSign(pair.private)
            update(signingInput.toByteArray(Charsets.US_ASCII))
            sign()
        }
        val token = "$signingInput.${b64u(sig)}"

        val verifier = JwtVerifier(
            AuthConfig(mode = "jwt", algorithm = "RS256", jwks = listOf(jwk)),
            clockSeconds = { 0L },
        )

        val result = verifier.verify(token)
        assertTrue(result is JwtResult.Valid, "expected valid, got $result")
        assertTrue((result as JwtResult.Valid).claims["sub"] == "rsa-user")
    }

    @Test
    fun `RS256 token fails with a non-matching key`() {
        val signer = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val other = (KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair().public) as RSAPublicKey

        val jwk = Jwk("RSA", "key-1", b64u(toUnsigned(other.modulus.toByteArray())), b64u(toUnsigned(other.publicExponent.toByteArray())))
        val header = b64u(mapper.writeValueAsBytes(mapOf("alg" to "RS256", "kid" to "key-1")))
        val payload = b64u(mapper.writeValueAsBytes(mapOf("sub" to "x")))
        val signingInput = "$header.$payload"
        val sig = Signature.getInstance("SHA256withRSA").run {
            initSign(signer.private); update(signingInput.toByteArray(Charsets.US_ASCII)); sign()
        }
        val token = "$signingInput.${b64u(sig)}"

        val verifier = JwtVerifier(AuthConfig(mode = "jwt", algorithm = "RS256", jwks = listOf(jwk)), clockSeconds = { 0L })
        assertTrue(verifier.verify(token) is JwtResult.Invalid)
    }

    @Test
    fun `JwksProvider seam supplies keys`() {
        // The verifier depends only on JwksProvider; an injected provider is honoured.
        var called = false
        val provider = JwksProvider { called = true; emptyList() }
        val verifier = JwtVerifier(AuthConfig(mode = "jwt", algorithm = "RS256"), jwksProvider = provider, clockSeconds = { 0L })
        // A structurally valid token will trigger key lookup (and fail with no keys).
        val header = b64u(mapper.writeValueAsBytes(mapOf("alg" to "RS256")))
        val payload = b64u(mapper.writeValueAsBytes(mapOf("sub" to "x")))
        verifier.verify("$header.$payload.AAAA")
        assertTrue(called, "JwksProvider should be consulted during RS256 verification")
    }

    /** Strip the leading sign byte BigInteger.toByteArray() may add, to match JWK encoding. */
    private fun toUnsigned(bytes: ByteArray): ByteArray =
        if (bytes.size > 1 && bytes[0].toInt() == 0) bytes.copyOfRange(1, bytes.size) else bytes
}
