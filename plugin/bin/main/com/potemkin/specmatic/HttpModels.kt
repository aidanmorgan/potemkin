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
    val queryParams: Map<String, String> = emptyMap(),
)

/**
 * Matches the ForwardResponse shape returned by the Node engine's POST /_engine/forward endpoint.
 */
data class ForwardedResponse(
    val status: Int,
    val headers: Map<String, String> = emptyMap(),
    val body: Any? = null,
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
