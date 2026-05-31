package com.potemkin.specmatic

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Unit tests for [FixturesClient] using OkHttp [MockWebServer].
 *
 * Covers:
 * - Successful fetch and JSON deserialisation.
 * - ETag / 304 Not Modified cache hit.
 * - Failed fetch → empty list, no exception.
 * - [excludedPaths] reflects the paths recorded via [FixturesClient.recordPushedPaths].
 */
class FixturesClientTest {

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

    private fun testHttpClient() = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(2, TimeUnit.SECONDS)
        .build()

    private fun clientWithNoNetworkInit(): FixturesClient = FixturesClient(
        backendUrl = baseUrl(),
        refreshOnFailureMs = 500,
        defaultTtlSeconds = 3600,
        httpClient = testHttpClient(),
    )

    private fun fixturesResponse(
        vararg stubs: Pair<String, String>,   // method to path
        etag: String? = null,
        cacheControl: String? = null,
    ): MockResponse {
        val fixturesJson = stubs.joinToString(",") { (method, path) ->
            """{"httpRequest":{"method":"$method","path":"$path"},"httpResponse":{"status":200,"headers":{"Content-Type":"application/json"},"body":{"ok":true}},"source":{"boundary":"test","aggregateId":"agg1","contractPath":"/contracts/test.yaml"}}"""
        }
        val body = """{"engine":"potemkin","version":"1.0","generatedAt":"2024-01-01T00:00:00Z","checksum":"abc","fixtures":[$fixturesJson]}"""
        return MockResponse()
            .setResponseCode(200)
            .setBody(body)
            .apply {
                if (etag != null) addHeader("ETag", etag)
                if (cacheControl != null) addHeader("Cache-Control", cacheControl)
            }
    }

    // ---- successful fetch ---------------------------------------------------------------

    @Test
    fun `successful fetch returns parsed fixture list`() {
        server.enqueue(fixturesResponse("GET" to "/loans/{id}", "POST" to "/loans"))

        val client = clientWithNoNetworkInit()
        val fixtures = client.fetchFixtures()

        assertEquals(2, fixtures.size)
        assertEquals("GET", fixtures[0].httpRequest.method)
        assertEquals("/loans/{id}", fixtures[0].httpRequest.path)
        assertEquals("POST", fixtures[1].httpRequest.method)
        assertEquals("/loans", fixtures[1].httpRequest.path)
        assertEquals(200, fixtures[0].httpResponse.status)
    }

    @Test
    fun `successful fetch - fixture source fields are populated`() {
        server.enqueue(fixturesResponse("GET" to "/customers/{id}"))

        val client = clientWithNoNetworkInit()
        val fixtures = client.fetchFixtures()

        assertEquals(1, fixtures.size)
        val source = fixtures[0].source
        assertEquals("test", source.boundary)
        assertEquals("agg1", source.aggregateId)
        assertEquals("/contracts/test.yaml", source.contractPath)
    }

    @Test
    fun `successful fetch - empty fixtures list`() {
        val body = """{"engine":"potemkin","version":"1.0","generatedAt":"2024-01-01T00:00:00Z","checksum":"abc","fixtures":[]}"""
        server.enqueue(MockResponse().setResponseCode(200).setBody(body))

        val client = clientWithNoNetworkInit()
        val fixtures = client.fetchFixtures()

        assertTrue(fixtures.isEmpty())
    }

    // ---- ETag / 304 handling -----------------------------------------------------------

    @Test
    fun `ETag is sent as If-None-Match on second fetch`() {
        server.enqueue(fixturesResponse("GET" to "/loans", etag = "\"v1\""))
        server.enqueue(MockResponse().setResponseCode(304))

        val client = clientWithNoNetworkInit()
        client.fetchFixtures()          // populates ETag cache
        client.fetchFixtures()          // should send If-None-Match

        val firstReq = server.takeRequest(1, TimeUnit.SECONDS)
        val secondReq = server.takeRequest(1, TimeUnit.SECONDS)
        assertEquals(null, firstReq?.getHeader("If-None-Match"))
        assertEquals("\"v1\"", secondReq?.getHeader("If-None-Match"))
    }

    @Test
    fun `304 Not Modified - returns previously cached fixtures without throwing`() {
        server.enqueue(fixturesResponse("GET" to "/loans", etag = "\"v1\""))
        server.enqueue(MockResponse().setResponseCode(304))

        val client = clientWithNoNetworkInit()
        val firstResult = client.fetchFixtures()
        val secondResult = client.fetchFixtures()

        // On 304, the cached list should be returned unchanged.
        assertEquals(firstResult.size, secondResult.size)
        assertEquals(firstResult[0].httpRequest.path, secondResult[0].httpRequest.path)
    }

    @Test
    fun `304 response - server count is 2`() {
        server.enqueue(fixturesResponse("GET" to "/loans", etag = "\"v1\""))
        server.enqueue(MockResponse().setResponseCode(304))

        val client = clientWithNoNetworkInit()
        client.fetchFixtures()
        client.fetchFixtures()

        assertEquals(2, server.requestCount)
    }

    // ---- lastEtag -----------------------------------------------------------------------

    @Test
    fun `lastEtag is null before any fetch`() {
        val client = clientWithNoNetworkInit()
        assertEquals(null, client.lastEtag())
    }

    @Test
    fun `lastEtag returns the ETag from the last successful fetch`() {
        server.enqueue(fixturesResponse("GET" to "/loans", etag = "\"v1\""))

        val client = clientWithNoNetworkInit()
        client.fetchFixtures()

        assertEquals("\"v1\"", client.lastEtag())
    }

    @Test
    fun `lastEtag is null when server omits the ETag header`() {
        server.enqueue(fixturesResponse("GET" to "/loans"))   // no ETag header

        val client = clientWithNoNetworkInit()
        client.fetchFixtures()

        assertEquals(null, client.lastEtag())
    }

    @Test
    fun `lastEtag is preserved across a 304 Not Modified response`() {
        server.enqueue(fixturesResponse("GET" to "/loans", etag = "\"v1\""))
        server.enqueue(MockResponse().setResponseCode(304))

        val client = clientWithNoNetworkInit()
        client.fetchFixtures()
        client.fetchFixtures()

        assertEquals("\"v1\"", client.lastEtag())
    }

    @Test
    fun `lastEtag updates when the server returns a new ETag`() {
        server.enqueue(fixturesResponse("GET" to "/loans", etag = "\"v1\""))
        server.enqueue(fixturesResponse("GET" to "/loans", "POST" to "/loans", etag = "\"v2\""))

        val client = clientWithNoNetworkInit()
        client.fetchFixtures()
        assertEquals("\"v1\"", client.lastEtag())
        client.fetchFixtures()
        assertEquals("\"v2\"", client.lastEtag())
    }

    // ---- failure handling ---------------------------------------------------------------

    @Test
    fun `fetch failure - returns empty list without throwing`() {
        // Shut server so all requests fail with connection refused.
        server.shutdown()

        val client = FixturesClient(
            backendUrl = "http://127.0.0.1:1",   // nothing listening
            refreshOnFailureMs = 100,
            defaultTtlSeconds = 3600,
            httpClient = OkHttpClient.Builder()
                .connectTimeout(500, TimeUnit.MILLISECONDS)
                .readTimeout(500, TimeUnit.MILLISECONDS)
                .build(),
        )

        // Must not throw.
        val fixtures = client.fetchFixtures()
        assertTrue(fixtures.isEmpty(), "Expected empty list on fetch failure")
    }

    @Test
    fun `unexpected HTTP status - returns empty list without throwing`() {
        server.enqueue(MockResponse().setResponseCode(500).setBody("internal error"))

        val client = clientWithNoNetworkInit()
        val fixtures = client.fetchFixtures()

        assertTrue(fixtures.isEmpty())
    }

    @Test
    fun `malformed JSON response - returns empty list without throwing`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("not-json{{{"))

        val client = clientWithNoNetworkInit()
        val fixtures = client.fetchFixtures()

        assertTrue(fixtures.isEmpty())
    }

    // ---- excludedPaths ------------------------------------------------------------------

    @Test
    fun `excludedPaths is empty before any paths are recorded`() {
        val client = clientWithNoNetworkInit()
        assertTrue(client.excludedPaths().isEmpty())
    }

    @Test
    fun `recordPushedPaths - excludedPaths returns recorded set`() {
        val client = clientWithNoNetworkInit()
        val paths = setOf("GET" to "/loans", "POST" to "/loans", "GET" to "/customers/{id}")
        client.recordPushedPaths(paths)

        assertEquals(paths, client.excludedPaths())
    }

    @Test
    fun `recordPushedPaths - later call replaces earlier set`() {
        val client = clientWithNoNetworkInit()
        client.recordPushedPaths(setOf("GET" to "/old-path"))
        client.recordPushedPaths(setOf("POST" to "/new-path"))

        val excluded = client.excludedPaths()
        assertFalse(excluded.contains("GET" to "/old-path"))
        assertTrue(excluded.contains("POST" to "/new-path"))
    }

    // ---- concurrency tests --------------------------------------------------------------

    /**
     * Drives concurrent [FixturesClient.fetchFixtures], [recordPushedPaths], and
     * [excludedPaths] from many threads. The cache and pushed-paths set are guarded
     * by a ReentrantReadWriteLock; this asserts no exception escapes and reads always
     * return one of the consistent written values (never a torn/partial set).
     */
    @Test
    fun `concurrent fetch, record, and read are race-free`() {
        // A dispatcher that answers every request identically — supports unbounded concurrency.
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                val body = """{"engine":"potemkin","version":"1.0","generatedAt":"2024-01-01T00:00:00Z","checksum":"abc","fixtures":[{"httpRequest":{"method":"GET","path":"/loans"},"httpResponse":{"status":200,"headers":{},"body":{"ok":true}},"source":{"boundary":"b","aggregateId":"a","contractPath":"/c.yaml"}}]}"""
                return MockResponse().setResponseCode(200).setBody(body)
            }
        }
        val client = clientWithNoNetworkInit()
        val setA = setOf("GET" to "/a")
        val setB = setOf("POST" to "/b", "GET" to "/c")

        val threads = 16
        val iterations = 200
        val errors = java.util.concurrent.CopyOnWriteArrayList<Throwable>()
        val barrier = java.util.concurrent.CyclicBarrier(threads)
        val pool = java.util.concurrent.Executors.newFixedThreadPool(threads)
        repeat(threads) { t ->
            pool.submit {
                try {
                    barrier.await()
                    repeat(iterations) { i ->
                        when ((t + i) % 4) {
                            0 -> client.fetchFixtures()
                            1 -> client.recordPushedPaths(setA)
                            2 -> client.recordPushedPaths(setB)
                            else -> {
                                val read = client.excludedPaths()
                                // A read must always be exactly one of the written sets (or the initial empty).
                                assertTrue(
                                    read.isEmpty() || read == setA || read == setB,
                                    "torn read of pushed paths: $read",
                                )
                            }
                        }
                    }
                } catch (e: Throwable) {
                    errors.add(e)
                }
            }
        }
        pool.shutdown()
        assertTrue(pool.awaitTermination(30, TimeUnit.SECONDS), "threads did not finish")
        assertTrue(errors.isEmpty(), "concurrent fixtures ops threw: ${errors.map { "${it::class.simpleName}: ${it.message}" }}")
    }

    @Test
    fun `excludedPaths contains every pushed fixture after full fetch-and-record cycle`() {
        server.enqueue(fixturesResponse("GET" to "/loans/{id}", "DELETE" to "/loans/{id}"))

        val client = clientWithNoNetworkInit()
        val fixtures = client.fetchFixtures()

        // Simulate what PluginInitializer does after bridge registration.
        val pushed = fixtures
            .map { it.httpRequest.method.uppercase() to it.httpRequest.path }
            .toSet()
        client.recordPushedPaths(pushed)

        val excluded = client.excludedPaths()
        assertTrue(excluded.contains("GET" to "/loans/{id}"))
        assertTrue(excluded.contains("DELETE" to "/loans/{id}"))
        assertEquals(2, excluded.size)
    }
}
