package com.potemkin.specmatic

import io.specmatic.core.WorkflowConfiguration
import io.specmatic.core.WorkflowIDOperation
import org.slf4j.LoggerFactory

/**
 * Merges the `workflow` and `governance` forward-blocks into the running
 * SpecmaticConfig representation (E6).
 *
 * Precedence (AC-E6.3), mirroring the engine's `mergeForwardBlock`
 * (`src/dsl/forwardBlocks.ts`):
 *  - scalars: the potemkin value overrides the specmatic value;
 *  - lists: concatenate (specmatic entries first, then potemkin);
 *  - objects: merge per key recursively.
 *
 * Binding note: `io.specmatic.core.SpecmaticConfig` is an opaque interface in
 * Specmatic 2.46.2 exposing only getters (`getWorkflowDetails`, `getReport`) —
 * it has no public setter or `copy`. This merger therefore produces the merged
 * [WorkflowConfiguration] (the concrete `WorkflowDetails` type Specmatic
 * instantiates) and the merged governance/report map; the parent wires these
 * into the SpecmaticConfig at the point Specmatic constructs it (the e2e seam,
 * AC-E6.4). The merge precedence — the load-bearing logic — is fully
 * implemented and unit-tested here (AC-E6.4).
 */
class SpecmaticConfigMerger {
    private val log = LoggerFactory.getLogger(SpecmaticConfigMerger::class.java)

    /**
     * Merge the existing workflow id-operations (from SpecmaticConfig) with the
     * potemkin `workflow.ids`. Object-merge semantics: per-key, the potemkin
     * entry overrides on conflict.
     */
    fun mergeWorkflow(
        existing: Map<String, WorkflowIDOperation>,
        block: WorkflowBlock,
    ): WorkflowConfiguration {
        val merged = LinkedHashMap(existing)
        for ((name, entry) in block.ids) {
            merged[name] = WorkflowIDOperation(extract = entry.extract, use = entry.use)
        }
        return WorkflowConfiguration(ids = merged)
    }

    /**
     * Merge an existing governance/report representation (as a generic map) with
     * the potemkin `governance` block, honouring the scalar/list/object
     * precedence rules.
     */
    fun mergeGovernance(
        existing: Map<String, Any?>,
        block: GovernanceBlock,
    ): Map<String, Any?> {
        val potemkin = LinkedHashMap<String, Any?>()
        block.report?.let { potemkin["report"] = it }
        block.successCriterion?.let { potemkin["successCriterion"] = it }
        return mergeForwardBlock(existing, potemkin)
    }

    companion object {
        /**
         * Precedence merge of two generic maps. Scalars from [potemkin] override
         * those in [specmatic]; lists concatenate (specmatic first); nested maps
         * merge recursively. Pure function — the testable core of AC-E6.3.
         */
        @Suppress("UNCHECKED_CAST")
        fun mergeForwardBlock(
            specmatic: Map<String, Any?>,
            potemkin: Map<String, Any?>,
        ): Map<String, Any?> {
            val result = LinkedHashMap<String, Any?>(specmatic)
            for ((k, v) in potemkin) {
                val existing = result[k]
                result[k] = when {
                    existing is List<*> && v is List<*> -> existing + v
                    existing is Map<*, *> && v is Map<*, *> ->
                        mergeForwardBlock(existing as Map<String, Any?>, v as Map<String, Any?>)
                    else -> v
                }
            }
            return result
        }
    }
}
