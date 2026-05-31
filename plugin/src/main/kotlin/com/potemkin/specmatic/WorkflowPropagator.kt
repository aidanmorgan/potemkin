package com.potemkin.specmatic

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import org.slf4j.LoggerFactory
import java.util.concurrent.ConcurrentHashMap

/**
 * Workflow id-propagation across a request sequence (E6 / AC-G6.2).
 *
 * Specmatic's `workflow` is a TEST-mode-only construct: `io.specmatic.core.Workflow`
 * is referenced only by `Feature.scenarioAsTest` / `generateContractTests` (verified
 * against specmatic-2.46.2.jar), never in stub mode, and `getWorkflowDetails()`
 * resolves from the *test* service config. The stub therefore cannot express
 * workflow chaining through Specmatic config; this propagator implements it in the
 * plugin forward path instead (the sanctioned fallback).
 *
 * Per `workflow.ids` entry `{ extract, use }` (mirroring Specmatic's own
 * `WorkflowIDOperation` vocabulary):
 *  - `extract` reads a value out of a create response. `BODY.<field>` (or the
 *    equivalent JSONPath `$.<field>`) reads the top-level `<field>` from the JSON
 *    response body. The value is stored under the id NAME.
 *  - `use` declares where the stored value is substituted into a later request.
 *    `PATH.<param>` (or JSONPath `$.<param>`) substitutes the `{<name>}` placeholder
 *    in the request path with the stored value.
 *
 * So a sequence `POST /leads` → `GET /leads/{leadId}` propagates the created id
 * automatically: the create response's `id` is captured under `leadId`, and the
 * subsequent request's `/leads/{leadId}` placeholder resolves to that id before
 * forwarding — the caller never has to thread the id by hand.
 *
 * State (the captured ids) is per-instance — one propagator is created per plugin
 * boot and injected into [StatefulRequestHandler]; there is no static/global state.
 */
class WorkflowPropagator(
    private val block: WorkflowBlock,
    private val mapper: ObjectMapper = jacksonObjectMapper(),
) {
    private val log = LoggerFactory.getLogger(WorkflowPropagator::class.java)

    /** name -> last extracted id value. */
    private val captured = ConcurrentHashMap<String, String>()

    /** name -> the response-body field to extract (the leaf of `extract`). */
    private val extractField: Map<String, String>
    /** name -> the path placeholder token to substitute (the leaf of `use`). */
    private val useToken: Map<String, String>

    init {
        val ef = LinkedHashMap<String, String>()
        val ut = LinkedHashMap<String, String>()
        for ((name, entry) in block.ids) {
            ef[name] = leafOf(entry.extract)
            ut[name] = leafOf(entry.use)
        }
        extractField = ef
        useToken = ut
    }

    /** True when at least one workflow id is configured. */
    val isActive: Boolean get() = block.ids.isNotEmpty()

    /**
     * Substitute captured ids into [request]'s path. Any path segment of the form
     * `{name}` whose `name` matches a configured `use` token (or id name) and has a
     * captured value is replaced with that value. Returns the request unchanged
     * when nothing matches.
     */
    fun applyToRequest(request: HttpRequest): HttpRequest {
        if (!isActive) return request
        val path = request.path ?: return request
        if (!path.contains('{')) return request
        var rewritten = path
        for ((name, token) in useToken) {
            val value = captured[name] ?: continue
            // Accept either the id NAME or the `use` leaf token as the placeholder.
            rewritten = rewritten
                .replace("{$name}", value)
                .replace("{$token}", value)
        }
        if (rewritten == path) return request
        log.debug("WorkflowPropagator: rewrote path '{}' -> '{}'", path, rewritten)
        return request.copy(path = rewritten)
    }

    /**
     * Capture ids from a create [response] for [request]. Only 2xx responses with a
     * JSON object body contribute. For each configured id, the response-body field
     * named by `extract` is stored under the id name.
     */
    fun observeResponse(request: HttpRequest, response: HttpResponse) {
        if (!isActive) return
        if (response.status !in 200..299) return
        val bodyText = response.body.toStringLiteral()
        if (bodyText.isBlank()) return
        val parsed: Any? = try {
            mapper.readValue(bodyText, Any::class.java)
        } catch (e: Exception) {
            return
        }
        if (parsed !is Map<*, *>) return
        for ((name, field) in extractField) {
            val value = parsed[field]
            if (value is String && value.isNotEmpty()) {
                captured[name] = value
                log.debug("WorkflowPropagator: captured {}='{}' from {} {}", name, value, request.method, request.path)
            }
        }
    }

    companion object {
        /**
         * The leaf of an extract/use expression: the last `.`-delimited segment,
         * with a leading `$` (JSONPath root) stripped. `BODY.id` -> `id`,
         * `PATH.leadId` -> `leadId`, `$.id` -> `id`, `$` -> `$`.
         */
        internal fun leafOf(expr: String): String {
            val trimmed = expr.removePrefix("$").removePrefix(".")
            val segs = trimmed.split('.').filter { it.isNotEmpty() }
            return segs.lastOrNull() ?: expr
        }
    }
}
