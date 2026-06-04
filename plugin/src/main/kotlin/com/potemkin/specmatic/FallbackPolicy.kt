package com.potemkin.specmatic

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import io.specmatic.core.HttpResponse
import io.specmatic.core.value.StringValue
import io.specmatic.stub.HttpStubResponse
import okhttp3.OkHttpClient
import okhttp3.Request
import org.slf4j.LoggerFactory
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Applies the engine's `fallback:` policy to requests that match no boundary,
 * so the SAME static response is served through the Specmatic stub as on the
 * direct engine — instead of letting Specmatic generate an example.
 *
 * Fetches the compiled rules + contract paths from GET /_engine/fallback once
 * (cached). For an unmatched request the first matching rule wins; else the
 * configured default; else the zero-config default (501 for a declared contract
 * path, 404 otherwise). Mirrors src/http/fallback.ts exactly.
 */
open class FallbackPolicy(
    private val backendUrl: String,
    private val httpClient: OkHttpClient,
) {
    private val log = LoggerFactory.getLogger(FallbackPolicy::class.java)
    private val mapper = jacksonObjectMapper()
    private val fetched = AtomicBoolean(false)

    @Volatile private var rules: List<CompiledRule> = emptyList()
    @Volatile private var defaultResp: RespDto? = null
    @Volatile private var contractMatchers: List<Regex> = emptyList()

    private data class CompiledRule(val pathRe: Regex?, val method: String?, val inContract: Boolean?, val respond: RespDto)

    @JsonIgnoreProperties(ignoreUnknown = true)
    private data class FallbackDto(
        val rules: List<RuleDto> = emptyList(),
        val default: RespDto? = null,
        val contractPaths: List<String> = emptyList(),
    )

    @JsonIgnoreProperties(ignoreUnknown = true)
    private data class RuleDto(val match: MatchDto = MatchDto(), val respond: RespDto = RespDto())

    @JsonIgnoreProperties(ignoreUnknown = true)
    private data class MatchDto(val path: String? = null, val method: String? = null, val inContract: Boolean? = null)

    @JsonIgnoreProperties(ignoreUnknown = true)
    private data class RespDto(val status: Int = 0, val body: Any? = null)

    private fun ensureFetched() {
        if (fetched.get()) return
        synchronized(this) {
            if (fetched.get()) return
            try {
                val req = Request.Builder().url("$backendUrl/_engine/fallback").get().build()
                httpClient.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return
                    val dto = mapper.readValue<FallbackDto>(resp.body?.string() ?: "{}")
                    rules = dto.rules.map {
                        CompiledRule(
                            pathRe = it.match.path?.let(::compilePattern),
                            method = it.match.method?.uppercase(),
                            inContract = it.match.inContract,
                            respond = it.respond,
                        )
                    }
                    defaultResp = dto.default
                    contractMatchers = dto.contractPaths.map(::compilePattern)
                    fetched.set(true)
                    log.info("FallbackPolicy: loaded {} rule(s), {} contract path(s)", rules.size, contractMatchers.size)
                }
            } catch (e: Exception) {
                log.debug("FallbackPolicy: fetch failed ({}); deferring", e.message)
            }
        }
    }

    /** Resolve the static response for an unmatched request. Never null. */
    open fun evaluate(method: String, path: String): HttpStubResponse {
        ensureFetched()
        val m = method.uppercase()
        val inContract = contractMatchers.any { it.matches(path) }
        for (rule in rules) {
            if (rule.method != null && rule.method != m) continue
            if (rule.inContract != null && rule.inContract != inContract) continue
            if (rule.pathRe != null && !rule.pathRe.matches(path)) continue
            return toResponse(rule.respond.status, rule.respond.body, path)
        }
        defaultResp?.let { return toResponse(it.status, it.body, path) }
        return if (inContract) toResponse(501, null, path) else toResponse(404, null, path)
    }

    private fun toResponse(status: Int, body: Any?, path: String): HttpStubResponse {
        val resolved: Any = body ?: defaultBody(status, path)
        val bodyString = if (resolved is String) resolved else mapper.writeValueAsString(resolved)
        return HttpStubResponse(
            response = HttpResponse(
                status = status,
                headers = mapOf("Content-Type" to "application/json"),
                body = StringValue(bodyString),
            ),
        )
    }

    private fun defaultBody(status: Int, path: String): Map<String, String> = when (status) {
        501 -> mapOf("error" to "NOT_IMPLEMENTED", "path" to path)
        404 -> mapOf("error" to "NO_ROUTE", "path" to path)
        else -> mapOf("error" to "UNHANDLED", "path" to path)
    }

    companion object {
        /** Compile an OpenAPI path template / glob to a matching regex. Mirrors fallback.ts. */
        fun compilePattern(pattern: String): Regex {
            val sb = StringBuilder("^")
            var i = 0
            while (i < pattern.length) {
                val c = pattern[i]
                if (c == '{') {
                    val close = pattern.indexOf('}', i)
                    if (close > i) { sb.append("[^/]+"); i = close + 1; continue }
                }
                if (c == '*') {
                    if (i + 1 < pattern.length && pattern[i + 1] == '*') { sb.append(".*"); i += 2; continue }
                    sb.append("[^/]*"); i += 1; continue
                }
                if (c in ".\\+?[^]$(){}=!<>|:#-".toSet()) sb.append('\\')
                sb.append(c)
                i++
            }
            sb.append('$')
            return Regex(sb.toString())
        }
    }
}
