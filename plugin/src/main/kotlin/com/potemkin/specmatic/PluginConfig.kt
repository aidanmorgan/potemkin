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
 *  4. Built-in defaults (safe: no paths intercepted)
 *
 * @param backendUrl Base URL of the Node CQRS engine, e.g. "http://localhost:3000".
 * @param pathPatterns Path patterns to intercept. Empty list means nothing is intercepted (safe default).
 *   Supported syntax: "/loans/STARSTAR" (multi-segment), "/items/STAR" (single segment), "/customers/{id}" (named).
 * @param forwardTimeoutMs Timeout for calls to the Node engine in milliseconds.
 */
data class PluginConfig(
    val backendUrl: String = "http://localhost:3000",
    val pathPatterns: List<String> = emptyList(),
    val forwardTimeoutMs: Long = 5_000,
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
                "No Potemkin plugin config file found; using defaults (no paths intercepted). " +
                    "Create potemkin-plugin.yaml in the working directory to configure interception.",
            )
            return PluginConfig()
        }

        @Suppress("UNCHECKED_CAST")
        internal fun parseYaml(text: String): PluginConfig {
            val raw = Yaml().load<Map<String, Any>>(text) ?: emptyMap<String, Any>()

            val backendUrl = raw["backendUrl"] as? String ?: "http://localhost:3000"
            val forwardTimeoutMs = (raw["forwardTimeoutMs"] as? Number)?.toLong() ?: 5_000L

            val patterns: List<String> = when (val p = raw["pathPatterns"]) {
                is List<*> -> p.filterIsInstance<String>()
                else -> emptyList()
            }

            return PluginConfig(
                backendUrl = backendUrl,
                pathPatterns = patterns,
                forwardTimeoutMs = forwardTimeoutMs,
            )
        }
    }
}
