package com.potemkin.specmatic

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

/**
 * Unit tests for [PluginConfig.parseYaml].
 */
class PluginConfigTest {

    @Test
    fun `minimal config without pathPatterns parses successfully`() {
        val yaml = """
            backendUrl: "http://localhost:4000"
            forwardTimeoutMs: 3000
        """.trimIndent()

        val config = PluginConfig.parseYaml(yaml)

        assertEquals("http://localhost:4000", config.backendUrl)
        assertEquals(3000L, config.forwardTimeoutMs)
        assertEquals(5_000L, config.discoveryRefreshOnFailureMs)
    }

    @Test
    fun `config with discoveryRefreshOnFailureMs parses correctly`() {
        val yaml = """
            backendUrl: "http://engine:3000"
            forwardTimeoutMs: 10000
            discoveryRefreshOnFailureMs: 15000
        """.trimIndent()

        val config = PluginConfig.parseYaml(yaml)

        assertEquals("http://engine:3000", config.backendUrl)
        assertEquals(10_000L, config.forwardTimeoutMs)
        assertEquals(15_000L, config.discoveryRefreshOnFailureMs)
    }

    @Test
    fun `pathPatterns if present is silently ignored (does not fail parsing)`() {
        // Old-style config with pathPatterns — must parse without error.
        val yaml = """
            backendUrl: "http://localhost:3000"
            forwardTimeoutMs: 5000
            pathPatterns:
              - "/loans/**"
              - "/customers/{id}"
        """.trimIndent()

        // Must not throw.
        val config = PluginConfig.parseYaml(yaml)

        // Core fields still parsed correctly.
        assertEquals("http://localhost:3000", config.backendUrl)
        assertEquals(5_000L, config.forwardTimeoutMs)
        // No pathPatterns field on the data class — the old values are simply dropped.
    }

    @Test
    fun `empty YAML uses defaults`() {
        val config = PluginConfig.parseYaml("")

        assertEquals("http://localhost:3000", config.backendUrl)
        assertEquals(5_000L, config.forwardTimeoutMs)
        assertEquals(5_000L, config.discoveryRefreshOnFailureMs)
    }

    @Test
    fun `default PluginConfig values are sensible`() {
        val config = PluginConfig()

        assertEquals("http://localhost:3000", config.backendUrl)
        assertEquals(5_000L, config.forwardTimeoutMs)
        assertEquals(5_000L, config.discoveryRefreshOnFailureMs)
    }
}
