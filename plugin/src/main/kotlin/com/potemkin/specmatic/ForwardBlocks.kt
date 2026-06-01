package com.potemkin.specmatic

/**
 * Typed Kotlin structures for the forward-blocks the plugin reads out of
 * potemkin.yaml: `seeds`, `workflow`, `overlay`, and `governance`.
 *
 * Shapes mirror the TS definitions in `src/dsl/configSchema.ts` and
 * `src/dsl/forwardBlocks.ts` exactly, so the plugin and engine agree on the
 * wire contract. Missing blocks default to empty.
 */

/** A seed request matcher: `{ method, path }`. */
data class SeedRequestMatcher(
    val method: String,
    val path: String,
)

/**
 * A single `seeds[]` entry: a request matcher, a base (`contract` or `empty`),
 * and the patches applied on top of the base to produce the seed body.
 */
data class SeedDeclaration(
    val description: String? = null,
    val request: SeedRequestMatcher,
    val base: SeedBase,
    val patches: List<Patch> = emptyList(),
)

/** Base for a seed body: the contract example/generated body, or an empty object. */
enum class SeedBase {
    CONTRACT,
    EMPTY,
    ;

    companion object {
        fun from(raw: String): SeedBase = when (raw) {
            "contract" -> CONTRACT
            "empty" -> EMPTY
            else -> throw IllegalArgumentException("seed base must be 'contract' or 'empty', got '$raw'")
        }
    }
}

/** A workflow id-operation: `{ extract, use }` JSONPath strings. */
data class WorkflowIdEntry(
    val extract: String,
    val use: String,
)

/** `workflow: { ids: { name: { extract, use } } }`. */
data class WorkflowBlock(
    val ids: Map<String, WorkflowIdEntry> = emptyMap(),
)

/** `overlay: { patches: Patch[] }`. */
data class OverlayBlock(
    val patches: List<Patch> = emptyList(),
)

/** `governance: { report?, successCriterion? }`. */
data class GovernanceBlock(
    val report: Map<String, Any?>? = null,
    val successCriterion: String? = null,
)

/**
 * The four forward-blocks parsed out of potemkin.yaml, exposed to
 * [PluginInitializer]. Each block defaults to empty when absent.
 */
data class ForwardBlocks(
    val seeds: List<SeedDeclaration> = emptyList(),
    val workflow: WorkflowBlock = WorkflowBlock(),
    val overlay: OverlayBlock = OverlayBlock(),
    val governance: GovernanceBlock = GovernanceBlock(),
) {
    companion object {
        val EMPTY = ForwardBlocks()

        /**
         * Parse the forward-blocks from a decoded potemkin.yaml root map.
         * Throws [IllegalArgumentException] on a malformed block shape; the
         * caller ([PluginConfig.parsePotemkinYaml]) wraps that into a
         * BOOT_ERR_INVALID_YAML diagnostic.
         */
        @Suppress("UNCHECKED_CAST")
        fun parse(root: Map<String, Any?>): ForwardBlocks {
            return ForwardBlocks(
                seeds = parseSeeds(root["seeds"]),
                workflow = parseWorkflow(root["workflow"]),
                overlay = parseOverlay(root["overlay"]),
                governance = parseGovernance(root["governance"]),
            )
        }

        @Suppress("UNCHECKED_CAST")
        private fun parseSeeds(raw: Any?): List<SeedDeclaration> {
            if (raw == null) return emptyList()
            if (raw !is List<*>) throw IllegalArgumentException("seeds: must be a list")
            return raw.mapIndexed { i, entry ->
                if (entry !is Map<*, *>) {
                    throw IllegalArgumentException("seeds[$i]: must be an object")
                }
                val seed = entry as Map<String, Any?>
                val requestRaw = seed["request"] as? Map<String, Any?>
                    ?: throw IllegalArgumentException("seeds[$i].request: must be an object")
                val method = requestRaw["method"] as? String
                    ?: throw IllegalArgumentException("seeds[$i].request.method: must be a string")
                val path = requestRaw["path"] as? String
                    ?: throw IllegalArgumentException("seeds[$i].request.path: must be a string")
                val baseRaw = seed["base"] as? String
                    ?: throw IllegalArgumentException("seeds[$i].base: must be 'contract' or 'empty'")
                val patches = parsePatches(seed["patches"], "seeds[$i].patches")
                SeedDeclaration(
                    description = seed["description"] as? String,
                    request = SeedRequestMatcher(method, path),
                    base = SeedBase.from(baseRaw),
                    patches = patches,
                )
            }
        }

        @Suppress("UNCHECKED_CAST")
        private fun parseWorkflow(raw: Any?): WorkflowBlock {
            if (raw == null) return WorkflowBlock()
            if (raw !is Map<*, *>) throw IllegalArgumentException("workflow: must be an object")
            val workflow = raw as Map<String, Any?>
            val idsRaw = workflow["ids"] ?: return WorkflowBlock()
            if (idsRaw !is Map<*, *>) throw IllegalArgumentException("workflow.ids: must be an object")
            val out = LinkedHashMap<String, WorkflowIdEntry>()
            for ((k, v) in idsRaw as Map<String, Any?>) {
                if (v !is Map<*, *>) {
                    throw IllegalArgumentException("workflow.ids.$k: must be { extract, use }")
                }
                val entry = v as Map<String, Any?>
                val extract = entry["extract"] as? String
                    ?: throw IllegalArgumentException("workflow.ids.$k.extract: must be a JSONPath string")
                val use = entry["use"] as? String
                    ?: throw IllegalArgumentException("workflow.ids.$k.use: must be a JSONPath string")
                out[k] = WorkflowIdEntry(extract, use)
            }
            return WorkflowBlock(out)
        }

        @Suppress("UNCHECKED_CAST")
        private fun parseOverlay(raw: Any?): OverlayBlock {
            if (raw == null) return OverlayBlock()
            if (raw !is Map<*, *>) throw IllegalArgumentException("overlay: must be an object")
            val overlay = raw as Map<String, Any?>
            return OverlayBlock(parsePatches(overlay["patches"], "overlay.patches"))
        }

        @Suppress("UNCHECKED_CAST")
        private fun parseGovernance(raw: Any?): GovernanceBlock {
            if (raw == null) return GovernanceBlock()
            if (raw !is Map<*, *>) throw IllegalArgumentException("governance: must be an object")
            val governance = raw as Map<String, Any?>
            val report = governance["report"]?.let {
                if (it !is Map<*, *>) throw IllegalArgumentException("governance.report: must be an object")
                it as Map<String, Any?>
            }
            val successCriterion = governance["successCriterion"]?.let {
                if (it !is String) throw IllegalArgumentException("governance.successCriterion: must be a string")
                it
            }
            return GovernanceBlock(report = report, successCriterion = successCriterion)
        }

        @Suppress("UNCHECKED_CAST")
        private fun parsePatches(raw: Any?, where: String): List<Patch> {
            if (raw == null) return emptyList()
            if (raw !is List<*>) throw IllegalArgumentException("$where: must be a list")
            return raw.mapIndexed { i, entry ->
                if (entry !is Map<*, *>) {
                    throw IllegalArgumentException("$where[$i]: must be a patch object")
                }
                try {
                    Patch.from(entry as Map<String, Any?>)
                } catch (e: IllegalArgumentException) {
                    throw IllegalArgumentException("$where[$i]: ${e.message}")
                }
            }
        }
    }
}
