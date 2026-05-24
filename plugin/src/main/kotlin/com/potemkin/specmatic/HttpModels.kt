package com.potemkin.specmatic

import com.fasterxml.jackson.annotation.JsonAnyGetter
import com.fasterxml.jackson.annotation.JsonAnySetter

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
