package com.potemkin.specmatic

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RoutesDiscoveryClientTest {

    private lateinit var server: MockWebServer

    @BeforeEach
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @AfterEach
    fun tearDown() {
        server.shutdown()
    }

    // ---- helpers ------------------------------------------------------------------------

    private fun baseUrl() = "http://${server.hostName}:${server.port}"

    private fun routesResponse(vararg paths: String, etag: String? = null): MockResponse {
        val json = """{"paths":[${paths.joinToString(",") { "\"$it\"" }}]}"""
        return MockResponse()
            .setResponseCode(200)
            .setBody(json)
            .apply { if (etag != null) addHeader("ETag", etag) }
    }

    /**
     * Creates a discovery client with a fast-timeout OkHttpClient (avoids long test delays)
     * and a very large TTL so the cache doesn't expire mid-test unless we want it to.
     */
    private fun clientWithLongTtl(
        ttlSeconds: Long = 3600,
        refreshOnFailureMs: Long = 500,
    ): RoutesDiscoveryClient = RoutesDiscoveryClient(
        backendUrl = baseUrl(),
        refreshOnFailureMs = refreshOnFailureMs,
        defaultTtlSeconds = ttlSeconds,
        httpClient = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(2, TimeUnit.SECONDS)
            .build(),
    )

    /**
     * Creates a discovery client with an already-expired TTL so the first isStateful() call
     * triggers a background refresh.
     */
    private fun clientWithExpiredTtl(): RoutesDiscoveryClient = RoutesDiscoveryClient(
        backendUrl = baseUrl(),
        refreshOnFailureMs = 500,
        defaultTtlSeconds = 0,   // 0 s → cache immediately expired after construction fetch
        httpClient = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(2, TimeUnit.SECONDS)
            .build(),
    )

    // ---- initial fetch ------------------------------------------------------------------

    @Test
    fun `initial fetch on construction - populates cache with discovered paths`() {
        server.enqueue(routesResponse("/customers", "/customers/{id}", "/loans"))

        val client = clientWithLongTtl()

        assertEquals(listOf("/customers", "/customers/{id}", "/loans"), client.routes())
        // Verify the server received exactly one request.
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `initial fetch - isStateful returns true for discovered path`() {
        server.enqueue(routesResponse("/customers/{id}", "/loans"))

        val client = clientWithLongTtl()

        assertTrue(client.isStateful("/customers/abc"))
        assertTrue(client.isStateful("/loans"))
    }

    @Test
    fun `initial fetch - isStateful returns false for undiscovered path`() {
        server.enqueue(routesResponse("/customers/{id}"))

        val client = clientWithLongTtl()

        assertFalse(client.isStateful("/products/1"))
    }

    // ---- failed initial fetch -----------------------------------------------------------

    @Test
    fun `failed fetch on construction - client does not crash`() {
        // Shut down server before constructing — connection refused.
        server.shutdown()

        // Must not throw.
        val client = RoutesDiscoveryClient(
            backendUrl = "http://127.0.0.1:1",   // nothing listening
            refreshOnFailureMs = 500,
            defaultTtlSeconds = 3600,
            httpClient = OkHttpClient.Builder()
                .connectTimeout(500, TimeUnit.MILLISECONDS)
                .readTimeout(500, TimeUnit.MILLISECONDS)
                .build(),
        )

        // Routes should be empty; isStateful always false.
        assertTrue(client.routes().isEmpty())
        assertFalse(client.isStateful("/customers/1"))
    }

    // ---- cache TTL ----------------------------------------------------------------------

    @Test
    fun `within TTL - second call does not trigger another request`() {
        server.enqueue(routesResponse("/customers/{id}"))

        val client = clientWithLongTtl(ttlSeconds = 3600)

        // Two isStateful calls — cache still fresh.
        client.isStateful("/customers/1")
        client.isStateful("/customers/2")

        // Only the initial construction fetch should have been made.
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `after TTL expiry - background refresh is triggered`() {
        // Initial fetch (construction) uses a 0-second TTL response so it expires immediately.
        server.enqueue(routesResponse("/customers/{id}", etag = "\"v1\""))
        // Second fetch (background refresh).
        server.enqueue(routesResponse("/customers/{id}", "/loans", etag = "\"v2\""))

        val client = clientWithExpiredTtl()

        // Trigger the background refresh.
        client.isStateful("/customers/1")

        // Wait for the background refresh to complete (at most 3 s).
        val deadline = System.currentTimeMillis() + 3_000
        while (server.requestCount < 2 && System.currentTimeMillis() < deadline) {
            Thread.sleep(50)
        }

        assertEquals(2, server.requestCount, "Background refresh should have made a second request")
        // After refresh, new routes should be visible.
        val deadline2 = System.currentTimeMillis() + 1_000
        while (!client.routes().contains("/loans") && System.currentTimeMillis() < deadline2) {
            Thread.sleep(50)
        }
        assertTrue(client.routes().contains("/loans"), "Updated routes should include /loans")
    }

    // ---- ETag / 304 handling ------------------------------------------------------------

    @Test
    fun `ETag is sent in If-None-Match on refresh`() {
        server.enqueue(routesResponse("/customers/{id}", etag = "\"abc123\""))
        server.enqueue(MockResponse().setResponseCode(304))   // Not Modified

        val client = clientWithExpiredTtl()

        // Force the refresh so we can inspect the second request synchronously.
        client.forceRefresh()

        // The second request should carry the ETag from the first response.
        val refreshRequest = server.takeRequest(1, TimeUnit.SECONDS)   // construction request
        val secondRequest = server.takeRequest(1, TimeUnit.SECONDS)    // forceRefresh request
        assertEquals("\"abc123\"", secondRequest?.getHeader("If-None-Match"))
    }

    @Test
    fun `304 Not Modified - paths remain unchanged and cache TTL is updated`() {
        server.enqueue(routesResponse("/customers/{id}", etag = "\"v1\""))
        server.enqueue(MockResponse().setResponseCode(304))

        val client = clientWithExpiredTtl()
        val routesBefore = client.routes().toList()

        client.forceRefresh()

        // Paths must stay the same after a 304.
        assertEquals(routesBefore, client.routes())
    }

    // ---- forceRefresh -------------------------------------------------------------------

    @Test
    fun `forceRefresh triggers immediate refetch and returns true when updated`() {
        server.enqueue(routesResponse("/customers/{id}"))
        server.enqueue(routesResponse("/customers/{id}", "/loans"))

        val client = clientWithLongTtl()
        assertEquals(1, server.requestCount)   // only construction fetch

        val updated = client.forceRefresh()

        assertTrue(updated, "forceRefresh should return true when new data was fetched")
        assertEquals(2, server.requestCount)
        assertTrue(client.routes().contains("/loans"))
    }

    @Test
    fun `forceRefresh returns false when server is unreachable`() {
        server.enqueue(routesResponse("/customers/{id}"))

        val client = clientWithLongTtl()

        // Shut the server down so the force-refresh fetch fails.
        server.shutdown()

        val updated = client.forceRefresh()

        assertFalse(updated, "forceRefresh should return false on failure")
        // Existing routes should be preserved.
        assertTrue(client.routes().contains("/customers/{id}"))
    }

    // ---- thread safety ------------------------------------------------------------------

    @Test
    fun `concurrent isStateful calls do not deadlock`() {
        server.enqueue(routesResponse("/customers/{id}", "/loans"))

        val client = clientWithLongTtl()

        val threadCount = 20
        val latch = CountDownLatch(threadCount)
        val executor = Executors.newFixedThreadPool(threadCount)
        val errors = mutableListOf<Throwable>()

        repeat(threadCount) {
            executor.submit {
                try {
                    // Each thread makes multiple calls.
                    repeat(50) {
                        client.isStateful("/customers/abc")
                        client.isStateful("/products/1")
                    }
                } catch (e: Throwable) {
                    synchronized(errors) { errors.add(e) }
                } finally {
                    latch.countDown()
                }
            }
        }

        val finished = latch.await(10, TimeUnit.SECONDS)
        executor.shutdown()

        assertTrue(finished, "All threads should complete within 10 s (no deadlock)")
        assertTrue(errors.isEmpty(), "No errors expected; got: ${errors.map { it.message }}")
    }
}
