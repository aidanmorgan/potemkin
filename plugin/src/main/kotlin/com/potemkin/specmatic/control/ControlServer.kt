package com.potemkin.specmatic.control

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.potemkin.specmatic.FixturesClient
import com.potemkin.specmatic.RoutesDiscoveryClient
import com.potemkin.specmatic.reliability.HealthMonitor
import com.potemkin.specmatic.reliability.HealthState
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.jackson.jackson
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import org.slf4j.LoggerFactory
import java.time.Instant

/**
 * Ktor/Netty HTTP server that receives lifecycle notifications from the Node CQRS engine.
 *
 * Endpoints:
 *  - `POST /shutdown` — signals engine is stopping; calls [HealthMonitor.markDownExternal].
 *  - `POST /ready`    — signals engine is ready; calls [HealthMonitor.markUpExternal],
 *                       then triggers a forced refresh of routes + fixtures.
 *  - `GET  /health`   — returns current [HealthState] as JSON.
 *
 * The server starts on [ControlServerConfig.port] (default 9090) using Netty.
 * [start] blocks until the server is listening; [stop] shuts it down gracefully.
 *
 * JSON serialisation uses Jackson (content-negotiation plugin).
 */
class ControlServer(
    private val config: ControlServerConfig = ControlServerConfig(),
    private val healthMonitor: HealthMonitor,
    private val routes: RoutesDiscoveryClient? = null,
    private val fixtures: FixturesClient? = null,
) {
    private val log = LoggerFactory.getLogger(ControlServer::class.java)

    private val engine = embeddedServer(
        factory = Netty,
        port = config.port,
        module = {
            configure(healthMonitor, routes, fixtures, log)
        },
    )

    fun start() {
        log.info("ControlServer: starting on port {}", config.port)
        engine.start(wait = false)
        log.info("ControlServer: listening on port {}", config.port)
    }

    fun stop() {
        log.info("ControlServer: stopping")
        engine.stop(gracePeriodMillis = 500, timeoutMillis = 2_000)
    }
}

internal fun Application.configure(
    healthMonitor: HealthMonitor,
    routes: RoutesDiscoveryClient?,
    fixtures: FixturesClient?,
    log: org.slf4j.Logger,
) {
    install(ContentNegotiation) {
        jackson()
    }

    routing {
        post("/shutdown") {
            val notification = runCatching { call.receive<ShutdownNotification>() }.getOrNull()
            log.info(
                "ControlServer: POST /shutdown received — engine={} version={} reason={}",
                notification?.engine,
                notification?.version,
                notification?.reason,
            )
            healthMonitor.markDownExternal()
            call.respond(HttpStatusCode.NoContent)
        }

        post("/ready") {
            val notification = runCatching { call.receive<ReadyNotification>() }.getOrNull()
            log.info(
                "ControlServer: POST /ready received — engine={} version={}",
                notification?.engine,
                notification?.version,
            )
            healthMonitor.markUpExternal()
            // Trigger a forced refresh of routes and fixtures so new contract paths
            // and stubs are picked up immediately. FixturesClient has no forceRefresh;
            // fetchFixtures() performs the same conditional GET + cache update.
            routes?.forceRefresh()
            fixtures?.fetchFixtures()
            call.respond(HttpStatusCode.NoContent)
        }

        // Plugin-process health endpoint — independent of the Node engine.
        // Returns the current health state so operators / CI can scrape it.
        // Exposed at both /health (legacy) and /_potemkin/health (canonical).
        get("/health") { respondHealth(call, healthMonitor) }
        get("/_potemkin/health") { respondHealth(call, healthMonitor) }
    }
}

private suspend fun respondHealth(
    call: io.ktor.server.application.ApplicationCall,
    healthMonitor: com.potemkin.specmatic.reliability.HealthMonitor,
) {
    val current = healthMonitor.currentState()
    val since = healthMonitor.upSince()
    val status = when (current) {
        HealthState.Down -> HttpStatusCode.ServiceUnavailable
        else -> HttpStatusCode.OK
    }
    call.respond(
        status,
        HealthStatusResponse(
            state = current.toString(),
            since = since?.toString() ?: Instant.now().toString(),
        ),
    )
}

// ---- Request / response models -----------------------------------------------------------

@JsonIgnoreProperties(ignoreUnknown = true)
data class ShutdownNotification(
    val engine: String? = null,
    val version: String? = null,
    val reason: String? = null,
    val stoppedAt: String? = null,
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class ReadyNotification(
    val engine: String? = null,
    val version: String? = null,
    val startedAt: String? = null,
    val contractPaths: List<String>? = null,
    val routesChecksum: String? = null,
    val fixturesChecksum: String? = null,
)

data class HealthStatusResponse(
    val state: String,
    val since: String,
)
