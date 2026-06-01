package com.potemkin.specmatic

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import okhttp3.OkHttpClient
import okhttp3.Request
import org.slf4j.LoggerFactory
import java.io.IOException
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/**
 * Client for the Node engine's GET /_engine/routes discovery endpoint.
 * Maintains a TTL-cached list of contract paths the engine owns.
 *
 * Thread-safe: the cache is updated under a write lock; reads are non-blocking
 * when the cache is fresh.
 *
 * @param backendUrl Base URL of the Node engine, e.g. "http://localhost:3000".
 * @param refreshOnFailureMs Back-off interval (ms) used as the cache TTL after a fetch error.
 * @param defaultTtlSeconds Default cache TTL in seconds (used when the server doesn't specify one).
 * @param httpClient Shared OkHttpClient; a short-timeout one is created by default.
 */
open class RoutesDiscoveryClient(
    private val backendUrl: String,
    private val refreshOnFailureMs: Long = 5_000,
    private val defaultTtlSeconds: Long = 30,
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(2, TimeUnit.SECONDS)
        .build(),
) {
    private val log = LoggerFactory.getLogger(RoutesDiscoveryClient::class.java)
    private val mapper = jacksonObjectMapper()
    private val lock = ReentrantReadWriteLock()
    private val backgroundRefreshPending = AtomicBoolean(false)
    /**
     * Serialises the bounded blocking cold-cache fetch in [isStateful] so that, while the
     * engine is still coming up, concurrent requests don't each spend the OkHttp timeout
     * hammering the same endpoint. Held only around the blocking network call, never while
     * reading the warm cache under [lock].
     */
    private val coldFetchLock = Any()
    /**
     * True once a fetch has successfully populated the cache with at least one path. Until
     * then the cache is "cold" and [isStateful] performs a bounded BLOCKING fetch so the
     * first owned-path request after the engine is up forwards correctly. Once warm, reads
     * stay non-blocking with background refresh.
     */
    private val everPopulated = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "potemkin-discovery-refresh").apply { isDaemon = true }
    }

    /** Current cached state — guarded by [lock]. */
    private var cache = CacheState(
        paths = emptyList(),
        matcher = PathMatcher(emptyList()),
        expiresAt = Instant.EPOCH,          // already expired → first isStateful() triggers refresh
        etag = null,
    )

    init {
        // Attempt a blocking initial fetch. If it fails, cache stays empty; discovery will
        // be retried on the first isStateful() call.
        val fetched = doFetch(currentEtag = null)
        if (fetched != null) {
            lock.write { cache = fetched }
            if (fetched.paths.isNotEmpty()) everPopulated.set(true)
            log.info(
                "RoutesDiscoveryClient: initial fetch succeeded — {} route(s) discovered",
                fetched.paths.size,
            )
        } else {
            // Set expiresAt to now so the first request triggers a background refresh immediately.
            lock.write {
                cache = cache.copy(expiresAt = Instant.now())
            }
            log.warn(
                "RoutesDiscoveryClient: initial fetch from {} failed — " +
                    "all routes treated as non-stateful until discovery succeeds",
                "$backendUrl/_engine/routes",
            )
        }
    }

    /**
     * Returns true if [path] is a stateful route owned by the Node engine.
     *
     * Cold cache (never successfully populated): performs a bounded BLOCKING fetch — capped
     * by the OkHttp connect/read timeout — before answering. This guarantees the first
     * owned-path request after the engine becomes reachable forwards correctly, instead of
     * falling through to Specmatic while an async refresh races to warm the cache.
     *
     * Warm cache: the read is non-blocking; a stale cache schedules a background refresh.
     */
    open fun isStateful(path: String): Boolean {
        if (!everPopulated.get()) {
            blockingColdFetchIfStale()
        } else {
            triggerRefreshIfStale()
        }
        return lock.read { cache.matcher.matches(path) }
    }

    /** Returns the current cached list of discovered route paths. */
    fun routes(): List<String> = lock.read { cache.paths }

    /**
     * Shuts down the background-refresh executor. Any in-flight refresh task is
     * cancelled immediately. Idempotent — safe to call more than once.
     */
    fun shutdown() {
        executor.shutdownNow()
    }

    /**
     * Forces an immediate synchronous refresh of the route cache.
     * Returns true if the cache was updated (i.e. the server returned new data).
     */
    fun forceRefresh(): Boolean {
        val etag = lock.read { cache.etag }
        val fetched = doFetch(currentEtag = etag) ?: return false
        lock.write { cache = fetched }
        if (fetched.paths.isNotEmpty()) everPopulated.set(true)
        return true
    }

    // ---- private helpers -----------------------------------------------------------------

    /**
     * Cold-cache path: synchronously fetch routes (bounded by the OkHttp timeout) if the cache
     * is stale and has never been populated. Serialised via [coldFetchLock] so concurrent
     * first-requests fan into one network call; latecomers re-check [everPopulated] after
     * acquiring the lock and skip the fetch once a peer has warmed the cache.
     *
     * Never throws — [doFetch] swallows all errors and returns null, preserving the
     * "never disrupt Specmatic" contract. On failure the cache stays empty and the next
     * request retries.
     */
    private fun blockingColdFetchIfStale() {
        val stale = lock.read { Instant.now().isAfter(cache.expiresAt) }
        if (!stale) return
        synchronized(coldFetchLock) {
            // A peer may have warmed the cache while we waited for the lock.
            if (everPopulated.get()) return
            if (lock.read { !Instant.now().isAfter(cache.expiresAt) }) return
            val etag = lock.read { cache.etag }
            val fetched = doFetch(currentEtag = etag)
            if (fetched != null) {
                lock.write { cache = fetched }
                if (fetched.paths.isNotEmpty()) {
                    everPopulated.set(true)
                    log.info(
                        "RoutesDiscoveryClient: cold-cache blocking fetch succeeded — {} route(s) discovered",
                        fetched.paths.size,
                    )
                }
            } else {
                // Back off briefly so a flood of cold requests doesn't each pay the timeout
                // while the engine is still unreachable. The next request after the back-off
                // re-attempts the blocking fetch.
                val backOffExpiry = Instant.now().plusMillis(refreshOnFailureMs)
                lock.write { cache = cache.copy(expiresAt = backOffExpiry) }
            }
        }
    }

    private fun triggerRefreshIfStale() {
        val stale = lock.read { Instant.now().isAfter(cache.expiresAt) }
        if (!stale) return
        // Only one background refresh in flight at a time.
        if (backgroundRefreshPending.compareAndSet(false, true)) {
            executor.submit {
                try {
                    val etag = lock.read { cache.etag }
                    val fetched = doFetch(currentEtag = etag)
                    if (fetched != null) {
                        lock.write { cache = fetched }
                        if (fetched.paths.isNotEmpty()) everPopulated.set(true)
                        log.debug(
                            "RoutesDiscoveryClient: background refresh succeeded — {} route(s)",
                            fetched.paths.size,
                        )
                    } else {
                        // Extend TTL to avoid hammering a failing endpoint.
                        val backOffExpiry = Instant.now().plusMillis(refreshOnFailureMs)
                        lock.write { cache = cache.copy(expiresAt = backOffExpiry) }
                        log.warn(
                            "RoutesDiscoveryClient: background refresh failed — " +
                                "backing off for {} ms, keeping stale route list",
                            refreshOnFailureMs,
                        )
                    }
                } finally {
                    backgroundRefreshPending.set(false)
                }
            }
        }
    }

    /**
     * Executes a GET /_engine/routes request. Sends [currentEtag] in `If-None-Match` if present.
     *
     * Returns a new [CacheState] if the server returned new data (200 OK).
     * Returns a [CacheState] with preserved paths if the server returned 304 Not Modified.
     * Returns null on any error (network failure, unexpected status code, parse error).
     * NEVER throws.
     */
    private fun doFetch(currentEtag: String?): CacheState? {
        val requestBuilder = Request.Builder()
            .url("$backendUrl/_engine/routes")
            .get()
        if (!currentEtag.isNullOrBlank()) {
            requestBuilder.header("If-None-Match", currentEtag)
        }
        val request = requestBuilder.build()

        return try {
            httpClient.newCall(request).execute().use { response ->
                when (response.code) {
                    304 -> {
                        // Paths unchanged; just reset the TTL and preserve existing state.
                        log.debug("RoutesDiscoveryClient: 304 Not Modified — paths unchanged, refreshing TTL")
                        val current = lock.read { cache }
                        current.copy(
                            expiresAt = computeExpiry(response.header("Cache-Control")),
                            // Keep existing etag (server may omit it on 304).
                            etag = response.header("ETag") ?: current.etag,
                        )
                    }
                    200 -> {
                        val bodyString = response.body?.string() ?: "{}"
                        val discovery = parseDiscoveryResponse(bodyString) ?: return null
                        val paths = discovery.paths
                        CacheState(
                            paths = paths,
                            matcher = PathMatcher(paths),
                            expiresAt = computeExpiry(response.header("Cache-Control")),
                            etag = response.header("ETag"),
                        )
                    }
                    else -> {
                        log.warn(
                            "RoutesDiscoveryClient: unexpected HTTP {} from {}/_engine/routes",
                            response.code,
                            backendUrl,
                        )
                        null
                    }
                }
            }
        } catch (e: IOException) {
            log.warn(
                "RoutesDiscoveryClient: IO error fetching routes from {}: {}",
                backendUrl,
                e.message,
            )
            null
        } catch (e: Exception) {
            log.warn(
                "RoutesDiscoveryClient: unexpected error fetching routes from {}: {}",
                backendUrl,
                e.message,
                e,
            )
            null
        }
    }

    private fun parseDiscoveryResponse(bodyString: String): DiscoveryResponse? {
        return try {
            mapper.readValue<DiscoveryResponse>(bodyString)
        } catch (e: Exception) {
            log.warn(
                "RoutesDiscoveryClient: failed to parse discovery response: {}",
                e.message,
            )
            null
        }
    }

    /**
     * Computes the cache expiry from a `Cache-Control: max-age=N` header value, falling back
     * to [defaultTtlSeconds] if the header is absent or not parseable.
     */
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
        val paths: List<String>,
        val matcher: PathMatcher,
        val expiresAt: Instant,
        val etag: String?,
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    private data class DiscoveryResponse(
        val paths: List<String> = emptyList(),
    )

    companion object {
        private val MAX_AGE_REGEX = Regex("""max-age=(\d+)""")
    }
}
