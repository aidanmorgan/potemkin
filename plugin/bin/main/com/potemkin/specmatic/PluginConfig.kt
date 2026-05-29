package com.potemkin.specmatic

import org.slf4j.LoggerFactory
import org.yaml.snakeyaml.Yaml
import java.io.File

/**
 * Configuration for the Potemkin Specmatic plugin.
 *
 * Resolved in priority order:
 *  1. POTEMKIN_PLUGIN_CONFIG env var (path to a YAML or JSON file)
 *  2. ./potemkin-plugin.yaml in the current working directory
 *  3. ./potemkin-plugin.json in the current working directory
 *  4. Built-in defaults
 *
 * Routes to intercept are no longer configured statically via `pathPatterns`. Instead the plugin
 * discovers them at runtime by calling GET /_engine/routes on the Node engine.
 *
 * @param backendUrl Base URL of the Node CQRS engine, e.g. "http://localhost:3000".
 * @param forwardTimeoutMs Timeout for calls to the Node engine in milliseconds.
 * @param discoveryRefreshOnFailureMs Back-off interval (ms) before retrying route discovery
 *   after a failed fetch (default 5 s).
 * @param controlPort TCP port for the Ktor control server that receives ready/shutdown
 *   notifications from the Node engine (default 9090).
 * @param healthProbeInitialMs Probe interval when engine is DOWN, in ms (default 250).
 * @param healthProbeStableMs  Probe interval when engine has been UP for >5 min, in ms (default 30 000).
 * @param forwarderMaxRetries  Total forward attempts including the initial try (default 3).
 * @param forwarderBackoffMs   Initial retry backoff in ms; grows exponentially (default 50).
 * @param circuitBreakerFailureRate Failure rate % that opens the circuit (default 50).
 * @param circuitBreakerWaitMs      Time in open state before transitioning to half-open, ms (default 10 000).
 */
data class PluginConfig(
    val backendUrl: String = "http://localhost:3000",
    val forwardTimeoutMs: Long = 5_000,
    val discoveryRefreshOnFailureMs: Long = 5_000,
    // Reliability layer
    val controlPort: Int = 9090,
    val healthProbeInitialMs: Long = 250L,
    val healthProbeStableMs: Long = 30_000L,
    val forwarderMaxRetries: Int = 3,
    val forwarderBackoffMs: Long = 50L,
    val circuitBreakerFailureRate: Int = 50,
    val circuitBreakerWaitMs: Long = 10_000L,
) {
    companion object {
        private val log = LoggerFactory.getLogger(PluginConfig::class.java)

        fun load(): PluginConfig {
            val envPath = System.getenv("POTEMKIN_PLUGIN_CONFIG")
            if (!envPath.isNullOrBlank()) {
                val file = File(envPath)
                if (file.exists()) {
                    log.info("Loading Potemkin plugin config from env path: {}", file.absolutePath)
                    return parseYaml(file.readText())
                } else {
                    log.warn(
                        "POTEMKIN_PLUGIN_CONFIG points to non-existent file '{}'; falling through to defaults",
                        envPath,
                    )
                }
            }

            val yamlFile = File("potemkin-plugin.yaml")
            if (yamlFile.exists()) {
                log.info("Loading Potemkin plugin config from {}", yamlFile.absolutePath)
                return parseYaml(yamlFile.readText())
            }

            val jsonFile = File("potemkin-plugin.json")
            if (jsonFile.exists()) {
                log.info("Loading Potemkin plugin config from {}", jsonFile.absolutePath)
                return parseYaml(jsonFile.readText())  // SnakeYAML is a superset of JSON
            }

            log.info(
                "No Potemkin plugin config file found; using defaults. " +
                    "Create potemkin-plugin.yaml in the working directory to configure the backend URL.",
            )
            return PluginConfig()
        }

        @Suppress("UNCHECKED_CAST")
        internal fun parseYaml(text: String): PluginConfig {
            val raw = Yaml().load<Map<String, Any>>(text) ?: emptyMap<String, Any>()

            val backendUrl = raw["backendUrl"] as? String ?: "http://localhost:3000"
            val forwardTimeoutMs = (raw["forwardTimeoutMs"] as? Number)?.toLong() ?: 5_000L
            val discoveryRefreshOnFailureMs =
                (raw["discoveryRefreshOnFailureMs"] as? Number)?.toLong() ?: 5_000L

            if (raw.containsKey("pathPatterns")) {
                log.warn(
                    "potemkin-plugin config: 'pathPatterns' is no longer used — routes are " +
                        "discovered at runtime via GET /_engine/routes. Remove 'pathPatterns' from " +
                        "your config file to suppress this warning.",
                )
            }

            val controlPort = (raw["controlPort"] as? Number)?.toInt() ?: 9090
            val healthProbeInitialMs = (raw["healthProbeInitialMs"] as? Number)?.toLong() ?: 250L
            val healthProbeStableMs = (raw["healthProbeStableMs"] as? Number)?.toLong() ?: 30_000L
            val forwarderMaxRetries = (raw["forwarderMaxRetries"] as? Number)?.toInt() ?: 3
            val forwarderBackoffMs = (raw["forwarderBackoffMs"] as? Number)?.toLong() ?: 50L
            val circuitBreakerFailureRate = (raw["circuitBreakerFailureRate"] as? Number)?.toInt() ?: 50
            val circuitBreakerWaitMs = (raw["circuitBreakerWaitMs"] as? Number)?.toLong() ?: 10_000L

            return PluginConfig(
                backendUrl = backendUrl,
                forwardTimeoutMs = forwardTimeoutMs,
                discoveryRefreshOnFailureMs = discoveryRefreshOnFailureMs,
                controlPort = controlPort,
                healthProbeInitialMs = healthProbeInitialMs,
                healthProbeStableMs = healthProbeStableMs,
                forwarderMaxRetries = forwarderMaxRetries,
                forwarderBackoffMs = forwarderBackoffMs,
                circuitBreakerFailureRate = circuitBreakerFailureRate,
                circuitBreakerWaitMs = circuitBreakerWaitMs,
            )
        }
    }
}
