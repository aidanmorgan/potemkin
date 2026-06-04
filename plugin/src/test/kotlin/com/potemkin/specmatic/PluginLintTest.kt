package com.potemkin.specmatic

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PluginLintTest {

    @Test
    fun `default config passes self-lint`() {
        assertEquals(emptyList(), PluginLint().selfLint(PluginConfig()))
    }

    @Test
    fun `invalid backend url, control port and timeout are each flagged`() {
        val errors = PluginLint().selfLint(PluginConfig(backendUrl = "localhost:3000", controlPort = -5, forwardTimeoutMs = 0))
        assertEquals(3, errors.size)
        assertTrue(errors.any { it.contains("engine.url") })
        assertTrue(errors.any { it.contains("controlPort") })
        assertTrue(errors.any { it.contains("timeoutMs") })
        assertTrue(errors.all { it.startsWith("[plugin]") })
    }

    @Test
    fun `combined report tags engine and plugin findings`() {
        val report = PluginLint().combinedReport(
            selfErrors = listOf("[plugin] potemkin.yaml plugin.engine.url 'x' is not a valid http(s) URL"),
            engine = PluginLint.EngineLintReport(
                passed = false,
                errors = listOf(PluginLint.EngineFinding(code = "MASK_FIELD_UNKNOWN", message = "no such field", boundary = "cust")),
            ),
        )
        assertTrue(report.contains("[plugin]"))
        assertTrue(report.contains("[engine] MASK_FIELD_UNKNOWN (boundary 'cust'): no such field"))
    }

    @Test
    fun `combined report notes an unavailable engine`() {
        val report = PluginLint().combinedReport(emptyList(), null)
        assertTrue(report.contains("engine not reachable"))
    }
}
