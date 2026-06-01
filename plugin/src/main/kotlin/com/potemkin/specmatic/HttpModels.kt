package com.potemkin.specmatic

import com.fasterxml.jackson.annotation.JsonProperty

/**
 * Matches the ForwardRequest shape expected by the Node engine's POST /_engine/forward endpoint.
 */
data class ForwardedRequest(
    val method: String,
    val path: String,
    val headers: Map<String, String> = emptyMap(),
    val body: Any? = null,
    // The Node engine's POST /_engine/forward contract names this field `query`
    // (src/forwarding/types.ts ForwardedRequest). Serialise to that name so the
    // engine accepts the request instead of rejecting it as malformed.
    // The TS type is Record<string, string | string[]>: a single value serialises as
    // a plain JSON string; multiple values for the same key serialise as a JSON array.
    @JsonProperty("query") val query: Map<String, Any> = emptyMap(),
)

/**
 * Matches the ForwardResponse shape returned by the Node engine's POST /_engine/forward endpoint.
 */
data class ForwardedResponse(
    val status: Int,
    val headers: Map<String, String> = emptyMap(),
    val body: Any? = null,
    // Response-mutation patches (HATEOAS/mask/etc.) the engine reports out-of-band
    // (src/forwarding/types.ts ForwardedResponse._patches). The plugin re-embeds
    // them into the served body so PotemkinResponseInterceptor can re-apply them.
    @JsonProperty("_patches") val patches: List<Any?>? = null,
)

// ---- Fixture models (GET /_engine/fixtures) -----------------------------------------------

/**
 * Top-level response from the Node engine's GET /_engine/fixtures endpoint.
 */
data class FixturesResponse(
    val engine: String = "",
    val version: String = "",
    val generatedAt: String = "",
    val checksum: String = "",
    val fixtures: List<FixtureStub> = emptyList(),
)

/**
 * A single DSL-derived fixture stub: an HTTP request/response pair plus provenance metadata.
 */
data class FixtureStub(
    @JsonProperty("httpRequest") val httpRequest: FixtureHttpRequest,
    @JsonProperty("httpResponse") val httpResponse: FixtureHttpResponse,
    val source: FixtureSource,
)

/** The request side of a fixture stub. */
data class FixtureHttpRequest(
    val method: String,
    val path: String,
    val headers: Map<String, String>? = null,
    val queryParameters: Map<String, Any>? = null,
)

/** The response side of a fixture stub. */
data class FixtureHttpResponse(
    val status: Int,
    val headers: Map<String, String> = emptyMap(),
    val body: Any? = null,
)

/** Provenance information for a fixture stub. */
data class FixtureSource(
    val boundary: String,
    val aggregateId: String,
    val contractPath: String,
)
