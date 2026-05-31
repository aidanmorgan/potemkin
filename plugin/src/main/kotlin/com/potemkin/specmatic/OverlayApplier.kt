package com.potemkin.specmatic

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.specmatic.core.overlay.Overlay
import io.specmatic.core.overlay.OverlayMerger
import io.specmatic.core.overlay.OverlayParser
import org.slf4j.LoggerFactory
import org.yaml.snakeyaml.Yaml

/**
 * Translates `overlay.patches` (RFC 6902 patches against the OpenAPI spec
 * document) into Specmatic's Overlay vocabulary and applies them to a spec via
 * Specmatic's [OverlayMerger] (E5).
 *
 * Translation mirrors the engine's `translateOverlayPatches`
 * (`src/dsl/forwardBlocks.ts`): each patch becomes an `{ target, update }` or
 * `{ target, remove: true }` action keyed by a JSONPath derived from the patch's
 * RFC 6901 pointer. `move` is unrolled into remove + add; `copy` resolves the
 * source value from the spec (see below).
 *
 * The merged spec string ([applyTo]) is the e2e seam: the launcher writes the
 * overlay to a file and points Specmatic's `overlayFilePath` env var at it, so
 * Specmatic applies the overlay at `HttpStub` construction. Specmatic loads its
 * features during construction (before this plugin's `initialize` runs), so
 * re-seating a merged spec into the already-loaded features is not a publicly
 * supported operation — [applyTo] exists as the documented, testable unit that
 * proves the overlay translation is correct.
 *
 * ## copy semantics (verified against specmatic-2.46.2.jar)
 *
 * `OverlayParser.parseAndReturnUpdateMap` keys an update action only on
 * `target != null && action.containsKey("update")` — the `update` VALUE is added
 * to the per-target list even when it is null (no value-presence guard).
 * `OverlayMerger.merge` then, for an update whose value is a `Map`, MERGES that
 * map's entries into the existing node, so an action `{ <leaf>: null }` writes a
 * literal null at `<leaf>` rather than copying the source value. A null update is
 * therefore unsafe for `copy`: it would null out the destination leaf, not
 * duplicate the source. The engine's TS translator emits this null only as a
 * placeholder ("Stage 4 plugin translator can swap in a richer strategy that
 * reads the spec doc"); this Kotlin applier IS that translator. [applyTo]
 * resolves the `copy` source value from the parsed spec and emits it as the
 * update; spec-free [translate]/[toOverlay] reject `copy` because the source
 * cannot be resolved without the spec.
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
     * Translate patches into overlay actions WITHOUT a source spec.
     *
     * `add`/`replace` follow OpenAPI Overlay (OAS) `update` semantics: the action
     * targets the leaf's PARENT object with a single-key update object
     * `{ <leaf>: value }`. Specmatic's OverlayMerger merges that object into the
     * target, which both creates a new field and overwrites an existing one —
     * unlike a leaf-targeted `set`, which silently no-ops when the leaf is
     * absent. `remove` targets the leaf directly; `move` unrolls into remove +
     * add.
     *
     * `copy` is REJECTED here: resolving the copied value requires reading the
     * source node out of the spec, which this overload does not have. Use
     * [applyTo] (spec-aware) when patches may contain `copy`.
     */
    fun translate(patches: List<Patch>): List<OverlayAction> = translate(patches, sourceDoc = null)

    /**
     * Translate patches into overlay actions, optionally resolving `copy` source
     * values against [sourceDoc] (the spec parsed into a JSON-shaped model). When
     * [sourceDoc] is null, `copy` is rejected because its value cannot be resolved.
     */
    private fun translate(patches: List<Patch>, sourceDoc: Any?): List<OverlayAction> {
        val out = mutableListOf<OverlayAction>()
        for (p in patches) {
            when (p) {
                is Patch.Add -> out += updateAction(p.path, p.value)
                is Patch.Replace -> out += updateAction(p.path, p.value)
                is Patch.Remove -> out += OverlayAction(pointerToJsonPath(p.path), remove = true)
                is Patch.Move -> {
                    out += OverlayAction(pointerToJsonPath(p.from), remove = true)
                    out += updateAction(p.path, resolveSource(sourceDoc, p.from, "move"))
                }
                is Patch.Copy -> out += updateAction(p.path, resolveSource(sourceDoc, p.from, "copy"))
                else -> throw IllegalArgumentException(
                    "Overlay translation only supports RFC 6902 ops; got '${p.op}'",
                )
            }
        }
        return out
    }

    /**
     * Resolve the value at the RFC 6901 [pointer] within [doc] so a `move`/`copy`
     * destination receives the actual source value (a null update would null the
     * leaf, not duplicate it — see the class doc). Throws when no spec is
     * available or the source pointer is absent, so an unresolvable copy fails
     * loudly instead of silently writing null.
     */
    private fun resolveSource(doc: Any?, pointer: String, op: String): Any? {
        if (doc == null) {
            throw IllegalArgumentException(
                "Overlay '$op' requires the source spec to resolve '$pointer'; " +
                    "call applyTo(specYaml, patches) instead of the spec-free translate/toOverlay",
            )
        }
        val segs = PatchApplier.parsePointer(pointer)
        var cur: Any? = doc
        for (seg in segs) {
            cur = when (cur) {
                is Map<*, *> -> {
                    if (!cur.containsKey(seg)) {
                        throw IllegalArgumentException("Overlay '$op' source not found in spec: '$pointer'")
                    }
                    cur[seg]
                }
                is List<*> -> {
                    val idx = seg.toIntOrNull()
                        ?: throw IllegalArgumentException("Overlay '$op' source index '$seg' is not an integer: '$pointer'")
                    if (idx < 0 || idx >= cur.size) {
                        throw IllegalArgumentException("Overlay '$op' source index out of range at '$seg': '$pointer'")
                    }
                    cur[idx]
                }
                else -> throw IllegalArgumentException("Overlay '$op' source traverses a non-container at '$seg': '$pointer'")
            }
        }
        return cur
    }

    /** An update action targeting the leaf's parent with `{ leaf: value }`. */
    private fun updateAction(pointer: String, value: Any?): OverlayAction {
        val segs = PatchApplier.parsePointer(pointer)
        require(segs.isNotEmpty()) { "Overlay update cannot target the document root" }
        val leaf = segs.last()
        val parent = if (segs.size == 1) "$" else "$." + segs.dropLast(1).joinToString(".")
        return OverlayAction(parent, update = mapOf(leaf to value))
    }

    /**
     * Build the Specmatic [Overlay] object from translated actions, WITHOUT a
     * source spec. Rejects `copy` (see [translate]); use [applyTo] when patches
     * may contain `copy`.
     */
    fun toOverlay(patches: List<Patch>): Overlay = buildOverlay(translate(patches, sourceDoc = null))

    private fun buildOverlay(actions: List<OverlayAction>): Overlay {
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
     * The spec is parsed first so `move`/`copy` source values can be resolved and
     * emitted as the overlay update (a null update would null the destination
     * leaf rather than copy the source — see the class doc).
     */
    fun applyTo(specYaml: String, patches: List<Patch>): String {
        if (patches.isEmpty()) return specYaml
        val sourceDoc: Any? = Yaml().load<Any?>(specYaml)
        val overlay = buildOverlay(translate(patches, sourceDoc))
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
