package com.potemkin.specmatic

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Unit tests for [PluginConfig.parsePotemkinYaml] — the sole config parser.
 *
 * Covers the `plugin:` block and the four forward-blocks (seeds / workflow /
 * overlay / governance) parsed into typed [ForwardBlocks] (E3).
 */
class PluginConfigTest {

    @Test
    fun `plugin engine block parses backend url and timeout`() {
        val yaml = """
            plugin:
              engine:
                url: "http://engine:4000"
                timeoutMs: 3000
        """.trimIndent()

        val config = PluginConfig.parsePotemkinYaml(yaml)

        assertEquals("http://engine:4000", config.backendUrl)
        assertEquals(3000L, config.forwardTimeoutMs)
    }

    @Test
    fun `empty YAML uses defaults and empty forward blocks`() {
        val config = PluginConfig.parsePotemkinYaml("")

        assertEquals("http://localhost:3000", config.backendUrl)
        assertEquals(5_000L, config.forwardTimeoutMs)
        assertEquals(ForwardBlocks.EMPTY, config.forwardBlocks)
    }

    @Test
    fun `default PluginConfig values are sensible`() {
        val config = PluginConfig()

        assertEquals("http://localhost:3000", config.backendUrl)
        assertEquals(5_000L, config.forwardTimeoutMs)
        assertEquals(5_000L, config.discoveryRefreshOnFailureMs)
    }

    // ---- E3: missing blocks default to empty (AC-E3.2) ----------------------

    @Test
    fun `missing forward blocks default to empty`() {
        val config = PluginConfig.parsePotemkinYaml(
            """
            plugin:
              engine:
                url: "http://localhost:3000"
            """.trimIndent(),
        )

        val blocks = config.forwardBlocks
        assertTrue(blocks.seeds.isEmpty())
        assertTrue(blocks.workflow.ids.isEmpty())
        assertTrue(blocks.overlay.patches.isEmpty())
        assertEquals(GovernanceBlock(), blocks.governance)
    }

    // ---- E3: seeds block (AC-E3.1, AC-E3.4) ---------------------------------

    @Test
    fun `seeds block parses request matcher base and patches`() {
        val yaml = """
            seeds:
              - description: "one active loan"
                request:
                  method: GET
                  path: /loans/L-1
                base: contract
                patches:
                  - op: replace
                    path: /status
                    value: ACTIVE
                  - op: increment
                    path: /version
                    by: 1
        """.trimIndent()

        val blocks = PluginConfig.parsePotemkinYaml(yaml).forwardBlocks

        assertEquals(1, blocks.seeds.size)
        val seed = blocks.seeds[0]
        assertEquals("one active loan", seed.description)
        assertEquals("GET", seed.request.method)
        assertEquals("/loans/L-1", seed.request.path)
        assertEquals(SeedBase.CONTRACT, seed.base)
        assertEquals(2, seed.patches.size)
        assertTrue(seed.patches[0] is Patch.Replace)
        assertTrue(seed.patches[1] is Patch.Increment)
    }

    @Test
    fun `seed base empty parses to EMPTY`() {
        val yaml = """
            seeds:
              - request: { method: POST, path: /leads }
                base: empty
                patches: []
        """.trimIndent()

        val seed = PluginConfig.parsePotemkinYaml(yaml).forwardBlocks.seeds[0]
        assertEquals(SeedBase.EMPTY, seed.base)
    }

    // ---- E3: workflow block (AC-E3.1) ---------------------------------------

    @Test
    fun `workflow block parses id operations`() {
        val yaml = """
            workflow:
              ids:
                leadId:
                  extract: ${'$'}.id
                  use: ${'$'}.leadId
        """.trimIndent()

        val workflow = PluginConfig.parsePotemkinYaml(yaml).forwardBlocks.workflow

        assertEquals(1, workflow.ids.size)
        assertEquals(WorkflowIdEntry("\$.id", "\$.leadId"), workflow.ids["leadId"])
    }

    // ---- E3: overlay block (AC-E3.1) ----------------------------------------

    @Test
    fun `overlay block parses patches`() {
        val yaml = """
            overlay:
              patches:
                - op: replace
                  path: /paths/~1leads/get/deprecated
                  value: true
        """.trimIndent()

        val overlay = PluginConfig.parsePotemkinYaml(yaml).forwardBlocks.overlay

        assertEquals(1, overlay.patches.size)
        val patch = overlay.patches[0] as Patch.Replace
        assertEquals("/paths/~1leads/get/deprecated", patch.path)
        assertEquals(true, patch.value)
    }

    // ---- E3: governance block (AC-E3.1) -------------------------------------

    @Test
    fun `governance block parses report and successCriterion`() {
        val yaml = """
            governance:
              successCriterion: "minCoverage>=80"
              report:
                successCriteria:
                  minCoverage: 80
                  excludedEndpoints:
                    - /health
        """.trimIndent()

        val governance = PluginConfig.parsePotemkinYaml(yaml).forwardBlocks.governance

        assertEquals("minCoverage>=80", governance.successCriterion)
        assertTrue(governance.report != null)
        @Suppress("UNCHECKED_CAST")
        val criteria = governance.report!!["successCriteria"] as Map<String, Any?>
        assertEquals(80, criteria["minCoverage"])
    }

    // ---- E3: malformed YAML throws BOOT_ERR_INVALID_YAML (AC-E3.3) ----------

    @Test
    fun `malformed YAML throws BOOT_ERR_INVALID_YAML with file and line`() {
        val badYaml = """
            seeds:
              - request: { method: GET
        """.trimIndent()

        val ex = assertThrows<PluginBootException> {
            PluginConfig.parsePotemkinYaml(badYaml, source = "config.yaml")
        }
        assertTrue(ex.message!!.startsWith("BOOT_ERR_INVALID_YAML"), "code prefix: ${ex.message}")
        assertTrue(ex.message!!.contains("config.yaml:"), "file:line locator: ${ex.message}")
    }

    @Test
    fun `structurally invalid seed throws BOOT_ERR_INVALID_YAML`() {
        val yaml = """
            seeds:
              - request: { method: GET, path: /x }
                base: nonsense
                patches: []
        """.trimIndent()

        val ex = assertThrows<PluginBootException> {
            PluginConfig.parsePotemkinYaml(yaml)
        }
        assertTrue(ex.message!!.startsWith("BOOT_ERR_INVALID_YAML"))
    }
}
