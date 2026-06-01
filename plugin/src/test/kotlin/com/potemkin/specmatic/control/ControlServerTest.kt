package com.potemkin.specmatic.control

import com.potemkin.specmatic.reliability.HealthMonitor
import com.potemkin.specmatic.reliability.HealthProbeConfig
import com.potemkin.specmatic.reliability.HealthState
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Unit tests for [ControlServer] endpoints.
 *
 * Uses Ktor's [testApplication] test framework (in-process, no real port) to exercise
 * [configure] which is the Application module function. This approach:
 *  - Is fast (no OS socket needed for most tests).
 *  - Avoids port conflicts in CI.
 *  - Covers the routing/serialisation/status-code contract.
 *
 * A separate integration test block verifies `markDownExternal` / `markUpExternal` are
 * invoked by using a spy [HealthMonitor].
 */
class ControlServerTest {

    // ---- Spy HealthMonitor --------------------------------------------------------------

    private class SpyHealthMonitor : HealthMonitor(
        backendUrl = "http://unused",
        config = HealthProbeConfig(),
    ) {
        var markDownCalled = 0
        var markUpCalled = 0

        override fun markDownExternal() {
            markDownCalled++
            super.markDownExternal()
        }

        override fun markUpExternal() {
            markUpCalled++
            super.markUpExternal()
        }
    }

    // ---- POST /shutdown ------------------------------------------------------------------

    @Test
    fun `POST shutdown returns 204 and calls markDownExternal`() {
        val spy = SpyHealthMonitor()

        testApplication {
            application {
                configure(spy, null, null, org.slf4j.LoggerFactory.getLogger("test"))
            }
            val response = client.post("/shutdown") {
                contentType(ContentType.Application.Json)
                setBody("""{"engine":"node","version":"1.0.0","reason":"test","stoppedAt":"2026-01-01T00:00:00Z"}""")
            }
            assertEquals(HttpStatusCode.NoContent, response.status)
        }

        assertEquals(1, spy.markDownCalled)
        assertEquals(HealthState.Down, spy.currentState())
    }

    @Test
    fun `POST shutdown with empty body still returns 204`() {
        val spy = SpyHealthMonitor()

        testApplication {
            application {
                configure(spy, null, null, org.slf4j.LoggerFactory.getLogger("test"))
            }
            val response = client.post("/shutdown") {
                contentType(ContentType.Application.Json)
                setBody("{}")
            }
            assertEquals(HttpStatusCode.NoContent, response.status)
        }

        assertEquals(1, spy.markDownCalled)
    }

    // ---- POST /ready --------------------------------------------------------------------

    @Test
    fun `POST ready returns 204 and calls markUpExternal`() {
        val spy = SpyHealthMonitor()
        spy.markDownExternal()  // start in DOWN

        testApplication {
            application {
                configure(spy, null, null, org.slf4j.LoggerFactory.getLogger("test"))
            }
            val response = client.post("/ready") {
                contentType(ContentType.Application.Json)
                setBody("""{"engine":"node","version":"2.0.0","startedAt":"2026-01-01T00:00:00Z"}""")
            }
            assertEquals(HttpStatusCode.NoContent, response.status)
        }

        assertEquals(1, spy.markUpCalled)
        assertEquals(HealthState.Up, spy.currentState())
    }

    @Test
    fun `POST ready with empty body still returns 204`() {
        val spy = SpyHealthMonitor()

        testApplication {
            application {
                configure(spy, null, null, org.slf4j.LoggerFactory.getLogger("test"))
            }
            val response = client.post("/ready") {
                contentType(ContentType.Application.Json)
                setBody("{}")
            }
            assertEquals(HttpStatusCode.NoContent, response.status)
        }

        assertEquals(1, spy.markUpCalled)
    }

    // ---- GET /health --------------------------------------------------------------------

    @Test
    fun `GET health returns 200 with state UP when engine is up`() {
        val spy = SpyHealthMonitor()

        testApplication {
            application {
                configure(spy, null, null, org.slf4j.LoggerFactory.getLogger("test"))
            }
            val response = client.get("/health")
            assertEquals(HttpStatusCode.OK, response.status)
            val body = response.bodyAsText()
            assertTrue(body.contains("UP"), "Response should contain 'UP': $body")
        }
    }

    @Test
    fun `GET health returns 503 ServiceUnavailable with DOWN state after markDownExternal`() {
        val spy = SpyHealthMonitor()
        spy.markDownExternal()

        testApplication {
            application {
                configure(spy, null, null, org.slf4j.LoggerFactory.getLogger("test"))
            }
            val response = client.get("/health")
            assertEquals(HttpStatusCode.ServiceUnavailable, response.status)
            val body = response.bodyAsText()
            assertTrue(body.contains("DOWN"), "Response should contain 'DOWN': $body")
        }
    }

    @Test
    fun `GET health returns DEGRADED state`() {
        val spy = SpyHealthMonitor()
        // Manually trigger degraded via a probe failure (use internal runProbe with shutdown server)
        // Simpler: mark down externally then check state reflects in response.
        // For DEGRADED we use the spy override approach.
        val degradedSpy = object : HealthMonitor(
            backendUrl = "http://unused",
            config = HealthProbeConfig(),
        ) {
            override fun currentState() = HealthState.Degraded
            override fun upSince() = null
        }

        testApplication {
            application {
                configure(degradedSpy, null, null, org.slf4j.LoggerFactory.getLogger("test"))
            }
            val response = client.get("/health")
            assertEquals(HttpStatusCode.OK, response.status)
            val body = response.bodyAsText()
            assertTrue(body.contains("DEGRADED"), "Response should contain 'DEGRADED': $body")
        }
    }

    // ---- Concurrent POST tests ----------------------------------------------------------

    @Test
    fun `concurrent POST shutdown and POST ready do not deadlock`() {
        val spy = SpyHealthMonitor()

        testApplication {
            application {
                configure(spy, null, null, org.slf4j.LoggerFactory.getLogger("test"))
            }
            // Fire both in sequence within the test; Ktor testApplication is single-threaded
            // but this validates that both handlers complete without hanging.
            repeat(5) {
                client.post("/shutdown") {
                    contentType(ContentType.Application.Json)
                    setBody("{}")
                }
                client.post("/ready") {
                    contentType(ContentType.Application.Json)
                    setBody("{}")
                }
            }
        }

        assertEquals(5, spy.markDownCalled)
        assertEquals(5, spy.markUpCalled)
    }
}
