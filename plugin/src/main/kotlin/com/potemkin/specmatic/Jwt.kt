package com.potemkin.specmatic

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import okhttp3.OkHttpClient
import okhttp3.Request
import java.math.BigInteger
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.RSAPublicKeySpec
import java.util.Base64
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Authentication policy from the `auth:` block of potemkin.yaml.
 *
 *  - `mode: jwt` enables JWT verification on the request interceptor.
 *  - `algorithm: HS256 | RS256` selects the verification scheme.
 *  - `secret:` supplies the HS256 shared secret.
 *  - `jwks:` supplies an inline JWK set (list of `{ kty, kid, n, e }`) for RS256.
 *  - `jwksUrl:` names a JWKS endpoint; the actual fetch is supplied by an injected
 *    [JwksProvider], leaving a clean, functional extension point (AC-E2.4).
 *  - `realm:` is echoed in the `WWW-Authenticate: Bearer realm=...` challenge.
 */
data class AuthConfig(
    val mode: String = "none",
    val algorithm: String = "HS256",
    val secret: String? = null,
    val jwks: List<Jwk> = emptyList(),
    val jwksUrl: String? = null,
    val realm: String = "potemkin",
) {
    val isJwt: Boolean get() = mode.equals("jwt", ignoreCase = true)

    companion object {
        @Suppress("UNCHECKED_CAST")
        fun parse(raw: Any?): AuthConfig {
            if (raw == null) return AuthConfig()
            if (raw !is Map<*, *>) throw IllegalArgumentException("auth: must be an object")
            val auth = raw as Map<String, Any?>
            val mode = auth["mode"] as? String ?: "none"
            // The canonical DSL form nests the scheme detail under `jwt:`
            // (matching the engine's global.yaml); accept that, falling back to
            // flat keys directly under `auth:`. A nested value wins when present.
            val jwt = auth["jwt"] as? Map<String, Any?> ?: emptyMap()
            fun field(name: String): Any? = jwt[name] ?: auth[name]
            val algorithm = field("algorithm") as? String ?: "HS256"
            val secret = field("secret") as? String
            val realm = field("realm") as? String ?: "potemkin"
            val jwksUrl = field("jwksUrl") as? String
            val jwks = when (val j = field("jwks")) {
                null -> emptyList()
                is List<*> -> j.map { entry ->
                    if (entry !is Map<*, *>) throw IllegalArgumentException("auth.jwks[]: must be JWK objects")
                    val jwk = entry as Map<String, Any?>
                    Jwk(
                        kty = jwk["kty"] as? String ?: "RSA",
                        kid = jwk["kid"] as? String,
                        n = jwk["n"] as? String
                            ?: throw IllegalArgumentException("auth.jwks[].n (modulus) is required"),
                        e = jwk["e"] as? String
                            ?: throw IllegalArgumentException("auth.jwks[].e (exponent) is required"),
                    )
                }
                else -> throw IllegalArgumentException("auth.jwks: must be a list")
            }
            return AuthConfig(
                mode = mode,
                algorithm = algorithm,
                secret = secret,
                jwks = jwks,
                jwksUrl = jwksUrl,
                realm = realm,
            )
        }
    }
}

/** A JSON Web Key (RSA public key material), base64url-encoded modulus/exponent. */
data class Jwk(
    val kty: String,
    val kid: String?,
    val n: String,
    val e: String,
)

/**
 * Supplies the JWK set used for RS256 verification. Implementations may return
 * an inline keyset or fetch from a JWKS URL; the verifier depends only on this
 * interface, so the fetch strategy is an injected, fully-functional seam.
 */
fun interface JwksProvider {
    fun keys(): List<Jwk>
}

/**
 * [JwksProvider] that fetches a JWKS document from [url] via HTTP and caches the
 * parsed keyset for [cacheTtlMs] milliseconds. A stale or failed fetch returns the
 * last successfully-fetched keyset, so transient network errors do not invalidate
 * an already-healthy token flow. First-fetch failures return an empty list (all
 * RS256 tokens will be rejected until the endpoint becomes reachable).
 *
 * Built on OkHttp, which is already a plugin dependency. Thread-safe via
 * [AtomicReference] on the cached state.
 */
class HttpJwksProvider(
    private val url: String,
    private val cacheTtlMs: Long = 300_000L,
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build(),
    private val clock: () -> Long = { System.currentTimeMillis() },
) : JwksProvider {

    private val mapper = jacksonObjectMapper()

    private data class CachedKeys(val keys: List<Jwk>, val expiresAt: Long)

    private val cache = AtomicReference<CachedKeys?>(null)

    override fun keys(): List<Jwk> {
        val cached = cache.get()
        if (cached != null && clock() < cached.expiresAt) return cached.keys
        return fetch() ?: cached?.keys ?: emptyList()
    }

    private fun fetch(): List<Jwk>? {
        val request = Request.Builder().url(url).get().build()
        return try {
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                val body = response.body?.string() ?: return null
                val raw = mapper.readValue<Map<String, Any?>>(body)
                @Suppress("UNCHECKED_CAST")
                val jwksRaw = raw["keys"] as? List<*> ?: return null
                val keys = jwksRaw.mapNotNull { entry ->
                    if (entry !is Map<*, *>) return@mapNotNull null
                    val jwk = entry as Map<String, Any?>
                    val n = jwk["n"] as? String ?: return@mapNotNull null
                    val e = jwk["e"] as? String ?: return@mapNotNull null
                    Jwk(
                        kty = jwk["kty"] as? String ?: "RSA",
                        kid = jwk["kid"] as? String,
                        n = n,
                        e = e,
                    )
                }
                cache.set(CachedKeys(keys = keys, expiresAt = clock() + cacheTtlMs))
                keys
            }
        } catch (_: Exception) {
            null
        }
    }
}

/** Result of verifying a token: either the decoded claims, or a failure reason. */
sealed class JwtResult {
    data class Valid(val claims: Map<String, Any?>) : JwtResult()
    data class Invalid(val reason: String) : JwtResult()
}

/**
 * Stateless JWT verifier. Supports HS256 (shared secret) fully and RS256 (RSA
 * public key from a [JwksProvider]). Performs signature verification plus `exp`
 * and `nbf` claim checks. No external library — JDK crypto only.
 *
 * Constructed with an [AuthConfig] and an optional [JwksProvider] (defaults to
 * the inline keyset in [AuthConfig.jwks]); both are injected so the verifier
 * holds no static state.
 */
class JwtVerifier(
    private val config: AuthConfig,
    private val jwksProvider: JwksProvider = JwksProvider { config.jwks },
    private val clockSeconds: () -> Long = { System.currentTimeMillis() / 1000 },
) {
    private val mapper = jacksonObjectMapper()
    private val urlDecoder = Base64.getUrlDecoder()

    fun verify(token: String): JwtResult {
        val parts = token.split(".")
        if (parts.size != 3) return JwtResult.Invalid("token is not a well-formed JWS (expected 3 segments)")

        val header: Map<String, Any?>
        val claims: Map<String, Any?>
        try {
            header = decodeJson(parts[0])
            claims = decodeJson(parts[1])
        } catch (e: Exception) {
            return JwtResult.Invalid("token header/payload is not valid base64url JSON: ${e.message}")
        }

        val alg = header["alg"] as? String
            ?: return JwtResult.Invalid("token header missing 'alg'")
        if (!alg.equals(config.algorithm, ignoreCase = true)) {
            return JwtResult.Invalid("token alg '$alg' does not match configured algorithm '${config.algorithm}'")
        }

        val signingInput = (parts[0] + "." + parts[1]).toByteArray(Charsets.US_ASCII)
        val signature = try {
            urlDecoder.decode(parts[2])
        } catch (e: Exception) {
            return JwtResult.Invalid("signature is not valid base64url")
        }

        val sigFailReason: String? = when (alg.uppercase()) {
            "HS256" -> if (verifyHs256(signingInput, signature)) null else "signature verification failed"
            "RS256" -> {
                val rs256Result = verifyRs256(signingInput, signature, header["kid"] as? String)
                if (rs256Result is JwtResult.Invalid) return rs256Result else null
            }
            else -> return JwtResult.Invalid("unsupported alg '$alg'")
        }
        if (sigFailReason != null) return JwtResult.Invalid(sigFailReason)

        val now = clockSeconds()
        (claims["exp"] as? Number)?.let {
            if (now >= it.toLong()) return JwtResult.Invalid("token expired")
        }
        (claims["nbf"] as? Number)?.let {
            if (now < it.toLong()) return JwtResult.Invalid("token not yet valid (nbf)")
        }

        return JwtResult.Valid(claims)
    }

    private fun verifyHs256(signingInput: ByteArray, signature: ByteArray): Boolean {
        val secret = config.secret ?: return false
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        val expected = mac.doFinal(signingInput)
        return constantTimeEquals(expected, signature)
    }

    private fun verifyRs256(signingInput: ByteArray, signature: ByteArray, kid: String?): JwtResult {
        val keys = jwksProvider.keys()
        val candidates = if (kid != null) {
            val matched = keys.filter { it.kid == kid }
            if (matched.isEmpty()) return JwtResult.Invalid("no JWK matches kid '$kid'")
            matched
        } else {
            keys
        }
        val factory = KeyFactory.getInstance("RSA")
        for (jwk in candidates) {
            try {
                val modulus = BigInteger(1, urlDecoder.decode(jwk.n))
                val exponent = BigInteger(1, urlDecoder.decode(jwk.e))
                val pub = factory.generatePublic(RSAPublicKeySpec(modulus, exponent))
                val sig = Signature.getInstance("SHA256withRSA")
                sig.initVerify(pub)
                sig.update(signingInput)
                if (sig.verify(signature)) return JwtResult.Valid(emptyMap())
            } catch (e: Exception) {
                // try next key
            }
        }
        return JwtResult.Invalid("signature verification failed")
    }

    @Suppress("UNCHECKED_CAST")
    private fun decodeJson(segment: String): Map<String, Any?> {
        val bytes = urlDecoder.decode(segment)
        return mapper.readValue(bytes, Map::class.java) as Map<String, Any?>
    }

    private fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean {
        if (a.size != b.size) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].toInt() xor b[i].toInt())
        return diff == 0
    }
}
