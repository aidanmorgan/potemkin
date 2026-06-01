package com.potemkin.specmatic

import io.specmatic.core.WorkflowIDOperation
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

/**
 * Unit tests for [SpecmaticConfigMerger]:
 *  - workflow ids reach a WorkflowConfiguration
 *  - governance values are merged
 *  - precedence: scalars override, lists concat, objects merge
 */
class SpecmaticConfigMergerTest {

    private val merger = SpecmaticConfigMerger()

    @Test
    fun `workflow ids are merged into a WorkflowConfiguration`() {
        val existing = mapOf("orderId" to WorkflowIDOperation("\$.orderId", "\$.id"))
        val block = WorkflowBlock(
            ids = mapOf("leadId" to WorkflowIdEntry(extract = "\$.id", use = "\$.leadId")),
        )

        val config = merger.mergeWorkflow(existing, block)

        assertEquals(2, config.ids.size)
        assertEquals(WorkflowIDOperation("\$.orderId", "\$.id"), config.ids["orderId"])
        assertEquals(WorkflowIDOperation("\$.id", "\$.leadId"), config.ids["leadId"])
    }

    @Test
    fun `workflow potemkin entry overrides on key conflict`() {
        val existing = mapOf("id" to WorkflowIDOperation("old-extract", "old-use"))
        val block = WorkflowBlock(ids = mapOf("id" to WorkflowIdEntry("new-extract", "new-use")))

        val config = merger.mergeWorkflow(existing, block)

        assertEquals(WorkflowIDOperation("new-extract", "new-use"), config.ids["id"])
    }

    @Test
    fun `governance scalar and report object are merged`() {
        val existing = mapOf("successCriterion" to "old", "report" to mapOf("a" to 1))
        val block = GovernanceBlock(
            report = mapOf("b" to 2),
            successCriterion = "new",
        )

        val merged = merger.mergeGovernance(existing, block)

        assertEquals("new", merged["successCriterion"]) // scalar overrides
        @Suppress("UNCHECKED_CAST")
        val report = merged["report"] as Map<String, Any?>
        assertEquals(mapOf("a" to 1, "b" to 2), report) // objects merge
    }

    // ---- mergeForwardBlock precedence (AC-E6.3 / AC-E6.4) -------------------

    @Test
    fun `scalars override`() {
        val result = SpecmaticConfigMerger.mergeForwardBlock(
            mapOf("x" to 1, "y" to "keep"),
            mapOf("x" to 2),
        )
        assertEquals(2, result["x"])
        assertEquals("keep", result["y"])
    }

    @Test
    fun `lists concatenate with specmatic entries first`() {
        val result = SpecmaticConfigMerger.mergeForwardBlock(
            mapOf("items" to listOf("a", "b")),
            mapOf("items" to listOf("c")),
        )
        assertEquals(listOf("a", "b", "c"), result["items"])
    }

    @Test
    fun `objects merge recursively`() {
        val result = SpecmaticConfigMerger.mergeForwardBlock(
            mapOf("meta" to mapOf("a" to 1, "nested" to mapOf("x" to 0))),
            mapOf("meta" to mapOf("b" to 2, "nested" to mapOf("y" to 9))),
        )
        @Suppress("UNCHECKED_CAST")
        val meta = result["meta"] as Map<String, Any?>
        assertEquals(1, meta["a"])
        assertEquals(2, meta["b"])
        @Suppress("UNCHECKED_CAST")
        val nested = meta["nested"] as Map<String, Any?>
        assertEquals(mapOf("x" to 0, "y" to 9), nested)
    }

    @Test
    fun `potemkin-only keys are added`() {
        val result = SpecmaticConfigMerger.mergeForwardBlock(emptyMap(), mapOf("k" to "v"))
        assertEquals("v", result["k"])
    }
}
