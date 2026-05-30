package com.potemkin.specmatic

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.specmatic.core.overlay.Overlay
import io.specmatic.core.overlay.OverlayMerger
import io.specmatic.core.overlay.OverlayParser
import org.slf4j.LoggerFactory

/**
 * Translates `overlay.patches` (RFC 6902 patches against the OpenAPI spec
 * document) into Specmatic's Overlay vocabulary and applies them to a spec via
 * Specmatic's [OverlayMerger] (E5).
 *
 * Translation mirrors the engine's `translateOverlayPatches`
 * (`src/dsl/forwardBlocks.ts`): each patch becomes an `{ target, update }` or
 * `{ target, remove: true }` action keyed by a JSONPath derived from the patch's
 * RFC 6901 pointer. `move`/`copy` are unrolled into remove + add.
 *
 * The merged spec string ([applyTo]) is what Specmatic should serve. Specmatic
 * loads its features during `HttpStub` construction (before this plugin's
 * `initialize` runs), so re-seating the merged spec into the already-loaded
 * features is not a publicly supported operation; producing the overlaid spec
 * here is the documented, testable unit, and wiring it into the live stub is the
 * e2e seam (the parent wires Specmatic to read the overlaid spec).
 *
 * Dependencies are injected so the applier holds no static state.
 */
class OverlayApplier(
    private val merger: OverlayMerger = OverlayMerger(),
    // JSON is a subset of YAML, and OverlayParser parses with a YAML-capable
    // ObjectMapper, so a JSON overlay document parses correctly — this avoids a
    // separate jackson-dataformat-yaml dependency.
    private val mapper: ObjectMapper = jacksonObjectMapper(),
) {
    private val log = LoggerFactory.getLogger(OverlayApplier::class.java)

    /** A translated overlay action: `{ target, update }` or `{ target, remove: true }`. */
    data class OverlayAction(
        val target: String,
        val update: Any? = null,
        val remove: Boolean = false,
    )

    /**
     * Translate patches into overlay actions.
     *
     * `add`/`replace` follow OpenAPI Overlay (OAS) `update` semantics: the action
     * targets the leaf's PARENT object with a single-key update object
     * `{ <leaf>: value }`. Specmatic's OverlayMerger merges that object into the
     * target, which both creates a new field and overwrites an existing one —
     * unlike a leaf-targeted `set`, which silently no-ops when the leaf is
     * absent. `remove` targets the leaf directly; `move`/`copy` unroll into
     * remove + add.
     */
    fun translate(patches: List<Patch>): List<OverlayAction> {
        val out = mutableListOf<OverlayAction>()
        for (p in patches) {
            when (p) {
                is Patch.Add -> out += updateAction(p.path, p.value)
                is Patch.Replace -> out += updateAction(p.path, p.value)
                is Patch.Remove -> out += OverlayAction(pointerToJsonPath(p.path), remove = true)
                is Patch.Move -> {
                    out += OverlayAction(pointerToJsonPath(p.from), remove = true)
                    out += updateAction(p.path, null)
                }
                is Patch.Copy -> out += updateAction(p.path, null)
                else -> throw IllegalArgumentException(
                    "Overlay translation only supports RFC 6902 ops; got '${p.op}'",
                )
            }
        }
        return out
    }

    /** An update action targeting the leaf's parent with `{ leaf: value }`. */
    private fun updateAction(pointer: String, value: Any?): OverlayAction {
        val segs = PatchApplier.parsePointer(pointer)
        require(segs.isNotEmpty()) { "Overlay update cannot target the document root" }
        val leaf = segs.last()
        val parent = if (segs.size == 1) "$" else "$." + segs.dropLast(1).joinToString(".")
        return OverlayAction(parent, update = mapOf(leaf to value))
    }

    /** Build the Specmatic [Overlay] object from translated actions. */
    fun toOverlay(patches: List<Patch>): Overlay {
        val actions = translate(patches)
        val doc = mapOf(
            "overlay" to "1.0.0",
            "actions" to actions.map { action ->
                if (action.remove) {
                    mapOf("target" to action.target, "remove" to true)
                } else {
                    mapOf("target" to action.target, "update" to action.update)
                }
            },
        )
        val overlayDoc = mapper.writeValueAsString(doc)
        return OverlayParser.parse(overlayDoc)
    }

    /**
     * Apply the translated overlay to [specYaml] and return the rewritten spec.
     * AC-E5.1 (translated output applied via Specmatic Overlay), AC-E5.2 (the
     * overlay-modified spec is what Specmatic should serve).
     */
    fun applyTo(specYaml: String, patches: List<Patch>): String {
        if (patches.isEmpty()) return specYaml
        val overlay = toOverlay(patches)
        val merged = merger.merge(specYaml, overlay)
        log.info("OverlayApplier: applied {} overlay patch(es) to spec", patches.size)
        return merged
    }

    private fun pointerToJsonPath(pointer: String): String {
        val segs = PatchApplier.parsePointer(pointer)
        if (segs.isEmpty()) return "$"
        return "$." + segs.joinToString(".")
    }
}
