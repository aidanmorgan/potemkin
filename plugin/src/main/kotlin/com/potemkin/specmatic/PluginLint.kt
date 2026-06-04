package com.potemkin.specmatic

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import okhttp3.OkHttpClient
import okhttp3.Request
import org.slf4j.LoggerFactory

/**
 * Strict lint service for the plugin side, plus a combined [engine]/[plugin]
 * report.
 *
 * [selfLint] validates the plugin's own configuration; the plugin refuses to boot
 * (and therefore to serve) when it returns findings. [fetchEngineReport] reads the
 * engine's GET /_engine/lint so its findings can be surfaced alongside the
 * plugin's in one located report.
 *
 * Collaborators (HTTP client, JSON mapper) are injected so the service is
 * testable in isolation.
 */
class PluginLint(
    private val httpClient: OkHttpClient = OkHttpClient(),
    private val mapper: ObjectMapper = jacksonObjectMapper(),
) {
    private val log = LoggerFactory.getLogger(PluginLint::class.java)

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class EngineFinding(val code: String = "", val message: String = "", val boundary: String? = null, val file: String? = null, val pointer: String? = null)

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class EngineLintReport(val passed: Boolean = true, val errors: List<EngineFinding> = emptyList(), val warnings: List<EngineFinding> = emptyList())

    /** Validate the plugin configuration. Returns located error strings (empty = OK). */
    fun selfLint(config: PluginConfig): List<String> {
        val errors = mutableListOf<String>()
        val url = config.backendUrl
        if (url.isBlank() || !(url.startsWith("http://") || url.startsWith("https://"))) {
            errors.add("[plugin] potemkin.yaml plugin.engine.url '$url' is not a valid http(s) URL")
        }
        if (config.controlPort < 0 || config.controlPort > 65535) {
            errors.add("[plugin] potemkin.yaml plugin.controlPort ${config.controlPort} is out of range 0..65535")
        }
        if (config.forwardTimeoutMs <= 0) {
            errors.add("[plugin] potemkin.yaml plugin.engine.timeoutMs (${config.forwardTimeoutMs}) must be > 0")
        }
        return errors
    }

    /** Fetch the engine's lint report; null when the engine is not (yet) reachable. */
    fun fetchEngineReport(backendUrl: String): EngineLintReport? {
        return try {
            val req = Request.Builder().url("$backendUrl/_engine/lint").get().build()
            httpClient.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return null
                mapper.readValue<EngineLintReport>(resp.body?.string() ?: "{}")
            }
        } catch (e: Exception) {
            log.debug("PluginLint: engine lint report unavailable: {}", e.message)
            null
        }
    }

    /** Build one combined, located report from the plugin self-lint + the engine report. */
    fun combinedReport(selfErrors: List<String>, engine: EngineLintReport?): String {
        val lines = mutableListOf<String>()
        for (e in selfErrors) lines.add("  $e")
        if (engine != null) {
            for (e in engine.errors) lines.add("  [engine] ${e.code}${locator(e)}: ${e.message}")
            for (w in engine.warnings) lines.add("  [engine] (warning) ${w.code}${locator(w)}: ${w.message}")
        } else {
            lines.add("  [engine] lint report unavailable (engine not reachable)")
        }
        return lines.joinToString("\n")
    }

    private fun locator(f: EngineFinding): String {
        val parts = listOfNotNull(f.file, f.boundary?.let { "boundary '$it'" }, f.pointer)
        return if (parts.isEmpty()) "" else " (${parts.joinToString(", ")})"
    }
}
