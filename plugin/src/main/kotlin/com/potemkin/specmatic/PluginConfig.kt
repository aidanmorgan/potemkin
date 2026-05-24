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
 */
data class PluginConfig(
    val backendUrl: String = "http://localhost:3000",
    val forwardTimeoutMs: Long = 5_000,
    val discoveryRefreshOnFailureMs: Long = 5_000,
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

            return PluginConfig(
                backendUrl = backendUrl,
                forwardTimeoutMs = forwardTimeoutMs,
                discoveryRefreshOnFailureMs = discoveryRefreshOnFailureMs,
            )
        }
    }
}
