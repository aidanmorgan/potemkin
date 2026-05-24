package com.potemkin.specmatic.control

/**
 * Configuration for the [ControlServer] Ktor HTTP server.
 *
 * @param port TCP port to listen on. Default 9090.
 */
data class ControlServerConfig(
    val port: Int = 9090,
)
