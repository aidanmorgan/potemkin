package com.potemkin.specmatic

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import okhttp3.OkHttpClient
import okhttp3.Request
import org.slf4j.LoggerFactory
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Client for the engine's GET /_engine/form-fields metadata endpoint.
 *
 * Lets the plugin coerce x-www-form-urlencoded request fields (which Specmatic
 * parses as strings) to the contract's declared types (integer/number/boolean)
 * before forwarding to the engine as JSON. The engine stays JSON-only and never
 * decodes form bodies — this is the HTTP/contract adapter doing its job.
 *
 * Fetched lazily on first use and cached for the process lifetime; a failed fetch
 * leaves coercion disabled (fields pass through as strings) and is retried later.
 */
open class FormFieldIndex(
    private val backendUrl: String,
    private val httpClient: OkHttpClient,
) {
    private val log = LoggerFactory.getLogger(FormFieldIndex::class.java)
    private val mapper = jacksonObjectMapper()
    private val fetched = AtomicBoolean(false)

    @Volatile
    private var operations: List<CompiledOp> = emptyList()

    private data class CompiledOp(val method: String, val regex: Regex, val fields: Map<String, String>)

    @JsonIgnoreProperties(ignoreUnknown = true)
    private data class FormFieldsResponse(val operations: List<OpDto> = emptyList())

    @JsonIgnoreProperties(ignoreUnknown = true)
    private data class OpDto(
        val method: String = "",
        val pathPattern: String = "",
        val fields: Map<String, String> = emptyMap(),
    )

    private fun ensureFetched() {
        if (fetched.get()) return
        synchronized(this) {
            if (fetched.get()) return
            try {
                val req = Request.Builder().url("$backendUrl/_engine/form-fields").get().build()
                httpClient.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return
                    val body = resp.body?.string() ?: "{}"
                    val parsed = mapper.readValue<FormFieldsResponse>(body)
                    operations = parsed.operations.map {
                        CompiledOp(it.method.uppercase(), compilePattern(it.pathPattern), it.fields)
                    }
                    fetched.set(true)
                    log.info("FormFieldIndex: loaded {} form operation(s)", operations.size)
                }
            } catch (e: Exception) {
                log.debug("FormFieldIndex: fetch failed ({}); form coercion deferred", e.message)
            }
        }
    }

    /** Declared coercible type for a form field on the operation serving (method, path), or null. */
    open fun typeFor(method: String, path: String, field: String): String? {
        ensureFetched()
        val m = method.uppercase()
        for (op in operations) {
            if (op.method == m && op.regex.matches(path)) return op.fields[field]
        }
        return null
    }

    /** Coerce a raw form value to the contract type declared for (method, path, field). */
    fun coerce(method: String, path: String, field: String, value: String): Any? =
        coerceValue(value, typeFor(method, path, field))

    companion object {
        /** Coerce a string form value to its declared primitive type; unknown/string passes through. */
        fun coerceValue(value: String, type: String?): Any? = when (type) {
            "integer" -> value.toLongOrNull() ?: value
            "number" -> value.toDoubleOrNull() ?: value
            "boolean" -> when (value) {
                "true" -> true
                "false" -> false
                else -> value
            }
            else -> value
        }

        /** Compile an OpenAPI path template (/v1/customers/{id}) to a matching regex. */
        fun compilePattern(pattern: String): Regex {
            val sb = StringBuilder("^")
            var i = 0
            while (i < pattern.length) {
                val c = pattern[i]
                if (c == '{') {
                    val close = pattern.indexOf('}', i)
                    if (close > i) {
                        sb.append("[^/]+")
                        i = close + 1
                        continue
                    }
                }
                if (c in ".\\+*?[^]$(){}=!<>|:-#/".toSet() && c != '/') sb.append('\\')
                sb.append(c)
                i++
            }
            sb.append('$')
            return Regex(sb.toString())
        }
    }
}
