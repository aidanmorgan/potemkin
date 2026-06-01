package com.potemkin.specmatic

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import org.slf4j.LoggerFactory
import java.util.Collections
import java.util.LinkedHashMap
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
 * ## Concurrency / isolation
 *
 * A single propagator instance is created per plugin boot and shared across all
 * concurrent requests (Specmatic dispatches requests in parallel). The captured
 * ids are therefore NOT a flat `name -> value` map — that would let one chain's
 * `leadId` overwrite another's under Specmatic's parallel dispatch (last writer
 * wins), substituting the wrong chain's id into a later path.
 *
 * Instead captured ids are namespaced by a per-chain **session key** derived from
 * the request itself ([sessionKeyOf]). Specmatic's `RequestHandler.handleRequest`
 * receives ONLY the [HttpRequest] (verified against specmatic-2.46.2.jar:
 * `handleRequest(HttpRequest): HttpStubResponse` — no connection/scenario id, and
 * `HttpRequestMetadata` carries only `securityHeaderNames`), so the chain must be
 * correlated from request data. Resolution order:
 *
 *  1. The JWT subject (`sub`) from the verified claims in the
 *     [PotemkinHeaders.JWT_CLAIMS] header (set by [PotemkinRequestInterceptor]).
 *  2. An explicit [PotemkinHeaders.WORKFLOW_SESSION] correlation header.
 *  3. Otherwise a single shared default namespace.
 *
 * Two interleaved chains that carry distinct subjects (or session headers) each
 * extract and substitute their OWN value for the same id name. Chains that supply
 * no correlation share the default namespace — the documented single-session
 * fallback (callers wanting isolation must supply (1) or (2)).
 *
 * Both [applyToRequest] and [observeResponse] derive the key from the request they
 * are given, so capture and substitution always target the same namespace.
 */
class WorkflowPropagator(
    private val block: WorkflowBlock,
    private val mapper: ObjectMapper = jacksonObjectMapper(),
    private val maxSessions: Int = MAX_SESSIONS,
) {
    private val log = LoggerFactory.getLogger(WorkflowPropagator::class.java)

    /**
     * session key -> (id name -> last extracted value).
     *
     * Bounded by [maxSessions] using an LRU eviction policy so long-running processes
     * do not accumulate unbounded entries for every distinct JWT subject or workflow
     * session header ever seen. The map is wrapped in [Collections.synchronizedMap] so
     * concurrent reads/writes are safe; the inner [ConcurrentHashMap] per session is
     * lock-free for individual id captures within a session.
     */
    private val capturedBySession: MutableMap<String, ConcurrentHashMap<String, String>> =
        Collections.synchronizedMap(
            object : LinkedHashMap<String, ConcurrentHashMap<String, String>>(
                maxSessions + 1, 0.75f, /* accessOrder= */ true,
            ) {
                override fun removeEldestEntry(
                    eldest: Map.Entry<String, ConcurrentHashMap<String, String>>,
                ): Boolean = size > maxSessions
            },
        )

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
        val captured = capturedBySession[sessionKeyOf(request)] ?: return request
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
        val key = sessionKeyOf(request)
        val captured = capturedBySession.computeIfAbsent(key) { ConcurrentHashMap() }
        for ((name, field) in extractField) {
            val value = parsed[field]
            if (value is String && value.isNotEmpty()) {
                captured[name] = value
                log.debug("WorkflowPropagator: captured {}='{}' (session={}) from {} {}", name, value, key, request.method, request.path)
            }
        }
    }

    /**
     * The session namespace for [request]. Prefers the verified JWT subject, then
     * an explicit [PotemkinHeaders.WORKFLOW_SESSION] header, else the shared
     * default. See the class doc for the isolation guarantee this provides.
     */
    private fun sessionKeyOf(request: HttpRequest): String {
        jwtSubject(request)?.let { return "sub:$it" }
        header(request, PotemkinHeaders.WORKFLOW_SESSION)?.let { return "ws:$it" }
        return DEFAULT_SESSION
    }

    private fun jwtSubject(request: HttpRequest): String? {
        val claimsJson = header(request, PotemkinHeaders.JWT_CLAIMS) ?: return null
        return try {
            val claims = mapper.readValue(claimsJson, Map::class.java)
            (claims["sub"] as? String)?.takeIf { it.isNotEmpty() }
        } catch (e: Exception) {
            null
        }
    }

    private fun header(request: HttpRequest, name: String): String? =
        request.headers.entries
            .firstOrNull { it.key.equals(name, ignoreCase = true) }
            ?.value
            ?.takeIf { it.isNotEmpty() }

    companion object {
        /**
         * Maximum number of concurrent session namespaces retained by [capturedBySession].
         * When the cap is exceeded, the least-recently-used session entry is evicted.
         * 1 000 covers large parallel test suites with hundreds of distinct JWT subjects.
         */
        internal const val MAX_SESSIONS = 1_000

        /**
         * Shared namespace used when a request carries neither a JWT subject nor a
         * [PotemkinHeaders.WORKFLOW_SESSION] header — the single-session fallback.
         */
        internal const val DEFAULT_SESSION = "__default__"

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
