package com.potemkin.specmatic

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import java.util.Base64
import kotlin.test.assertEquals
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

    // ---- kid mismatch must not fall back to full keyset ----------------------

    @Test
    fun `RS256 token with kid that matches no configured JWK returns Invalid without trying other keys`() {
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val pub = pair.public as RSAPublicKey
        val jwk = Jwk("RSA", "key-known", b64u(toUnsigned(pub.modulus.toByteArray())), b64u(toUnsigned(pub.publicExponent.toByteArray())))

        // Token signed with the matching private key but claims a different kid.
        val header = b64u(mapper.writeValueAsBytes(mapOf("alg" to "RS256", "kid" to "key-unknown")))
        val payload = b64u(mapper.writeValueAsBytes(mapOf("sub" to "x")))
        val signingInput = "$header.$payload"
        val sig = Signature.getInstance("SHA256withRSA").run {
            initSign(pair.private); update(signingInput.toByteArray(Charsets.US_ASCII)); sign()
        }
        val token = "$signingInput.${b64u(sig)}"

        val verifier = JwtVerifier(AuthConfig(mode = "jwt", algorithm = "RS256", jwks = listOf(jwk)), clockSeconds = { 0L })
        val result = verifier.verify(token)

        assertTrue(result is JwtResult.Invalid)
        assertTrue((result as JwtResult.Invalid).reason.contains("kid"), "reason should mention kid, got: ${result.reason}")
    }

    @Test
    fun `RS256 token without kid tries all keys (no-kid fallback retained)`() {
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val pub = pair.public as RSAPublicKey
        val jwk = Jwk("RSA", "key-1", b64u(toUnsigned(pub.modulus.toByteArray())), b64u(toUnsigned(pub.publicExponent.toByteArray())))

        // Token has no kid header — verifier should try all keys.
        val header = b64u(mapper.writeValueAsBytes(mapOf("alg" to "RS256")))
        val payload = b64u(mapper.writeValueAsBytes(mapOf("sub" to "no-kid-user")))
        val signingInput = "$header.$payload"
        val sig = Signature.getInstance("SHA256withRSA").run {
            initSign(pair.private); update(signingInput.toByteArray(Charsets.US_ASCII)); sign()
        }
        val token = "$signingInput.${b64u(sig)}"

        val verifier = JwtVerifier(AuthConfig(mode = "jwt", algorithm = "RS256", jwks = listOf(jwk)), clockSeconds = { 0L })
        val result = verifier.verify(token)

        assertTrue(result is JwtResult.Valid, "token without kid should verify against any matching key, got $result")
    }

    // ---- HttpJwksProvider fetches and caches JWKS from URL -----------------

    @Test
    fun `HttpJwksProvider fetches JWKS document and parses keys`() {
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val pub = pair.public as RSAPublicKey
        val n = b64u(toUnsigned(pub.modulus.toByteArray()))
        val e = b64u(toUnsigned(pub.publicExponent.toByteArray()))

        val jwksJson = """{"keys":[{"kty":"RSA","kid":"fetched-key","n":"$n","e":"$e"}]}"""

        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(jwksJson).addHeader("Content-Type", "application/json"))
        server.start()

        val provider = HttpJwksProvider(url = server.url("/jwks").toString())
        val keys = provider.keys()

        assertEquals(1, keys.size)
        assertEquals("fetched-key", keys[0].kid)
        assertEquals(n, keys[0].n)
        server.shutdown()
    }

    @Test
    fun `HttpJwksProvider caches keys and does not re-fetch within TTL`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"keys":[{"kty":"RSA","kid":"k1","n":"abc","e":"AQAB"}]}"""))
        // No second response enqueued — a second fetch would throw.
        server.start()

        var time = 0L
        val provider = HttpJwksProvider(
            url = server.url("/jwks").toString(),
            cacheTtlMs = 60_000L,
            clock = { time },
        )
        provider.keys()           // first call: fetches
        time = 30_000L
        val second = provider.keys()  // second call within TTL: must not fetch again

        assertEquals(1, second.size)
        assertEquals(1, server.requestCount, "should only have fetched once within TTL")
        server.shutdown()
    }

    @Test
    fun `HttpJwksProvider re-fetches after TTL expires`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"keys":[{"kty":"RSA","kid":"k1","n":"n1","e":"AQAB"}]}"""))
        server.enqueue(MockResponse().setBody("""{"keys":[{"kty":"RSA","kid":"k2","n":"n2","e":"AQAB"}]}"""))
        server.start()

        var time = 0L
        val provider = HttpJwksProvider(
            url = server.url("/jwks").toString(),
            cacheTtlMs = 1_000L,
            clock = { time },
        )
        provider.keys()         // fetches at t=0
        time = 2_000L
        val refreshed = provider.keys()  // TTL expired; re-fetches

        assertEquals(2, server.requestCount)
        assertEquals("k2", refreshed.first().kid)
        server.shutdown()
    }

    @Test
    fun `HttpJwksProvider returns last cached keys on fetch failure`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"keys":[{"kty":"RSA","kid":"stale","n":"n","e":"AQAB"}]}"""))
        server.enqueue(MockResponse().setResponseCode(500))
        server.start()

        var time = 0L
        val provider = HttpJwksProvider(
            url = server.url("/jwks").toString(),
            cacheTtlMs = 100L,
            clock = { time },
        )
        val first = provider.keys()
        assertEquals(1, first.size)

        time = 200L
        val fallback = provider.keys()  // TTL expired, fetch fails → returns stale cache

        assertEquals(1, fallback.size, "should return stale cached keys on error")
        assertEquals("stale", fallback.first().kid)
        server.shutdown()
    }

    @Test
    fun `HttpJwksProvider returns empty list when server unreachable and no cache`() {
        // Port 19999 is not expected to be listening; connection refused → empty list.
        val provider = HttpJwksProvider(url = "http://127.0.0.1:19999/jwks")
        val keys = provider.keys()
        assertTrue(keys.isEmpty(), "should return empty list when server is unreachable")
    }

    @Test
    fun `JwtVerifier with HttpJwksProvider verifies RS256 token fetched from JWKS endpoint`() {
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val pub = pair.public as RSAPublicKey
        val n = b64u(toUnsigned(pub.modulus.toByteArray()))
        val e = b64u(toUnsigned(pub.publicExponent.toByteArray()))

        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"keys":[{"kty":"RSA","kid":"live","n":"$n","e":"$e"}]}"""))
        server.start()

        val provider = HttpJwksProvider(url = server.url("/jwks").toString())
        val verifier = JwtVerifier(AuthConfig(mode = "jwt", algorithm = "RS256"), jwksProvider = provider, clockSeconds = { 0L })

        val header = b64u(mapper.writeValueAsBytes(mapOf("alg" to "RS256", "kid" to "live")))
        val payload = b64u(mapper.writeValueAsBytes(mapOf("sub" to "http-user")))
        val signingInput = "$header.$payload"
        val sig = Signature.getInstance("SHA256withRSA").run {
            initSign(pair.private); update(signingInput.toByteArray(Charsets.US_ASCII)); sign()
        }
        val token = "$signingInput.${b64u(sig)}"

        val result = verifier.verify(token)
        assertTrue(result is JwtResult.Valid, "expected valid, got $result")
        server.shutdown()
    }

    /** Strip the leading sign byte BigInteger.toByteArray() may add, to match JWK encoding. */
    private fun toUnsigned(bytes: ByteArray): ByteArray =
        if (bytes.size > 1 && bytes[0].toInt() == 0) bytes.copyOfRange(1, bytes.size) else bytes
}
