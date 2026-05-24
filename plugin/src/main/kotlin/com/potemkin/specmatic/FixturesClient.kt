package com.potemkin.specmatic

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import okhttp3.OkHttpClient
import okhttp3.Request
import org.slf4j.LoggerFactory
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/**
 * Client for the Node engine's GET /_engine/fixtures endpoint.
 *
 * Fetches DSL-derived fixture stubs on demand, with ETag-aware caching and TTL-based
 * background refresh (same pattern as [RoutesDiscoveryClient]).
 *
 * Thread-safe: the cache is updated under a write lock; reads are non-blocking when fresh.
 *
 * [excludedPaths] returns the set of (method.uppercase(), path) tuples that this client has
 * successfully pushed as Specmatic stubs. [StatefulRequestHandler] uses this set to
 * short-circuit: if the incoming request's (method, path) is in the set, it returns null
 * immediately and lets Specmatic serve its own registered stub.
 *
 * NEVER throws out of [fetchFixtures]; all exceptions are caught and logged.
 *
 * @param backendUrl Base URL of the Node engine, e.g. "http://localhost:3000".
 * @param refreshOnFailureMs Back-off interval (ms) used as the cache TTL after a fetch error.
 * @param defaultTtlSeconds Default cache TTL in seconds (used when the server doesn't return one).
 * @param httpClient Shared OkHttpClient; a short-timeout one is created by default.
 */
open class FixturesClient(
    private val backendUrl: String,
    private val refreshOnFailureMs: Long = 5_000,
    private val defaultTtlSeconds: Long = 30,
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(2, TimeUnit.SECONDS)
        .build(),
) {
    private val log = LoggerFactory.getLogger(FixturesClient::class.java)
    private val mapper = jacksonObjectMapper()
    private val lock = ReentrantReadWriteLock()

    /** The (method, path) tuples that have been registered with Specmatic as stubs. Guarded by [lock]. */
    private var pushedPaths: Set<Pair<String, String>> = emptySet()

    /** Current cached state — guarded by [lock]. */
    private var cache = CacheState(
        fixtures = emptyList(),
        expiresAt = Instant.EPOCH,
        etag = null,
    )

    /**
     * Fetches the current fixture list. Returns the cached list on 304 Not Modified.
     * Returns an empty list (without throwing) on any error.
     */
    open fun fetchFixtures(): List<FixtureStub> {
        val etag = lock.read { cache.etag }
        val fetched = doFetch(currentEtag = etag) ?: return lock.read { cache.fixtures }
        lock.write { cache = fetched }
        return fetched.fixtures
    }

    /**
     * Records the set of (method, path) tuples that have been successfully pushed to Specmatic.
     * Called by [SpecmaticStubBridge] after registration.
     */
    open fun recordPushedPaths(paths: Set<Pair<String, String>>) {
        lock.write { pushedPaths = paths }
    }

    /**
     * Returns the (method.uppercase(), exact-path) tuples that this plugin has pushed into
     * Specmatic. [StatefulRequestHandler] short-circuits when a request matches this set.
     */
    open fun excludedPaths(): Set<Pair<String, String>> = lock.read { pushedPaths }

    // ---- private helpers -----------------------------------------------------------------

    /**
     * Executes a GET /_engine/fixtures request. Sends [currentEtag] in `If-None-Match` if present.
     *
     * Returns a new [CacheState] if the server returned new data (200 OK).
     * Returns a [CacheState] with preserved fixtures on 304 Not Modified.
     * Returns null on any error (network failure, unexpected status, parse error).
     * NEVER throws.
     */
    private fun doFetch(currentEtag: String?): CacheState? {
        val requestBuilder = Request.Builder()
            .url("$backendUrl/_engine/fixtures")
            .get()
        if (!currentEtag.isNullOrBlank()) {
            requestBuilder.header("If-None-Match", currentEtag)
        }
        val request = requestBuilder.build()

        return try {
            httpClient.newCall(request).execute().use { response ->
                when (response.code) {
                    304 -> {
                        log.debug("FixturesClient: 304 Not Modified — fixtures unchanged, refreshing TTL")
                        val current = lock.read { cache }
                        current.copy(
                            expiresAt = computeExpiry(response.header("Cache-Control")),
                            etag = response.header("ETag") ?: current.etag,
                        )
                    }
                    200 -> {
                        val bodyString = response.body?.string() ?: "{}"
                        val parsed = parseFixturesResponse(bodyString) ?: return null
                        CacheState(
                            fixtures = parsed.fixtures,
                            expiresAt = computeExpiry(response.header("Cache-Control")),
                            etag = response.header("ETag"),
                        )
                    }
                    else -> {
                        log.warn(
                            "FixturesClient: unexpected HTTP {} from {}/_engine/fixtures",
                            response.code,
                            backendUrl,
                        )
                        null
                    }
                }
            }
        } catch (e: IOException) {
            log.warn(
                "FixturesClient: IO error fetching fixtures from {}: {}",
                backendUrl,
                e.message,
            )
            null
        } catch (e: Exception) {
            log.warn(
                "FixturesClient: unexpected error fetching fixtures from {}: {}",
                backendUrl,
                e.message,
                e,
            )
            null
        }
    }

    private fun parseFixturesResponse(bodyString: String): FixturesResponse? {
        return try {
            mapper.readValue<FixturesResponse>(bodyString)
        } catch (e: Exception) {
            log.warn("FixturesClient: failed to parse fixtures response: {}", e.message)
            null
        }
    }

    private fun computeExpiry(cacheControl: String?): Instant {
        if (!cacheControl.isNullOrBlank()) {
            val maxAge = MAX_AGE_REGEX.find(cacheControl)?.groupValues?.get(1)?.toLongOrNull()
            if (maxAge != null && maxAge > 0) {
                return Instant.now().plusSeconds(maxAge)
            }
        }
        return Instant.now().plusSeconds(defaultTtlSeconds)
    }

    // ---- inner types ---------------------------------------------------------------------

    private data class CacheState(
        val fixtures: List<FixtureStub>,
        val expiresAt: Instant,
        val etag: String?,
    )

    companion object {
        private val MAX_AGE_REGEX = Regex("""max-age=(\d+)""")
    }
}
