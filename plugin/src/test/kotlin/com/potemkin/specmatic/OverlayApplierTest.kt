package com.potemkin.specmatic

import org.junit.jupiter.api.Test
import org.yaml.snakeyaml.Yaml
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Tests for [OverlayApplier] (E5):
 *  - add/replace/remove patches translate to Specmatic Overlay actions
 *  - move/copy resolve their source value from the spec (a null update would
 *    null the destination leaf, not copy the source — see the class doc)
 *  - the overlay-merged spec reflects the change
 */
class OverlayApplierTest {

    private val applier = OverlayApplier()

    private val spec = """
        openapi: 3.0.0
        info:
          title: Leads
          version: 1.0.0
          description: original
        paths:
          /leads:
            get:
              responses:
                '200':
                  description: ok
    """.trimIndent()

    @Test
    fun `replace patch sets operation deprecated true in the merged spec`() {
        val patches = listOf(
            Patch.Replace("/paths/~1leads/get/deprecated", true),
        )

        val merged = applier.applyTo(spec, patches)

        assertTrue(merged.contains("deprecated"), "merged spec should contain 'deprecated':\n$merged")
        assertTrue(
            Regex("deprecated:\\s*true").containsMatchIn(merged) || merged.contains("\"deprecated\":true"),
            "deprecated should be true:\n$merged",
        )
    }

    @Test
    fun `add patch translates to a parent-targeted update action (OAS overlay merge)`() {
        val actions = applier.translate(listOf(Patch.Add("/info/description", "added")))
        assertEquals(1, actions.size)
        assertEquals("$.info", actions[0].target)
        assertEquals(mapOf("description" to "added"), actions[0].update)
        assertEquals(false, actions[0].remove)
    }

    @Test
    fun `replace patch translates to a parent-targeted update action`() {
        val actions = applier.translate(listOf(Patch.Replace("/info/version", "2.0.0")))
        assertEquals(1, actions.size)
        assertEquals("$.info", actions[0].target)
        assertEquals(mapOf("version" to "2.0.0"), actions[0].update)
        assertEquals(false, actions[0].remove)
    }

    @Test
    fun `remove patch translates to a remove action`() {
        val actions = applier.translate(listOf(Patch.Remove("/paths/~1leads/get")))
        assertEquals(1, actions.size)
        assertEquals("$.paths./leads.get", actions[0].target)
        assertTrue(actions[0].remove)
    }

    @Test
    fun `copy is rejected by spec-free translate because the source value is unresolvable`() {
        val e = assertFailsWith<IllegalArgumentException> {
            applier.translate(listOf(Patch.Copy(from = "/info/description", path = "/info/summary")))
        }
        assertTrue(e.message!!.contains("requires the source spec"), e.message!!)
    }

    @Test
    fun `move is rejected by spec-free translate because the source value is unresolvable`() {
        val e = assertFailsWith<IllegalArgumentException> {
            applier.translate(listOf(Patch.Move(from = "/info/description", path = "/info/summary")))
        }
        assertTrue(e.message!!.contains("requires the source spec"), e.message!!)
    }

    @Test
    fun `copy emits the resolved source value as the destination update in the merged spec`() {
        // Copy /info/description ("original") into /info/summary.
        val merged = applier.applyTo(
            spec,
            listOf(Patch.Copy(from = "/info/description", path = "/info/summary")),
        )

        @Suppress("UNCHECKED_CAST")
        val doc = Yaml().load<Map<String, Any?>>(merged)
        val info = doc["info"] as Map<*, *>
        assertEquals("original", info["summary"], "copy must duplicate the source value, not write null:\n$merged")
        // The source is unchanged (copy, not move).
        assertEquals("original", info["description"])
    }

    @Test
    fun `move removes the source and writes the resolved value at the destination`() {
        val merged = applier.applyTo(
            spec,
            listOf(Patch.Move(from = "/info/description", path = "/info/summary")),
        )

        @Suppress("UNCHECKED_CAST")
        val doc = Yaml().load<Map<String, Any?>>(merged)
        val info = doc["info"] as Map<*, *>
        assertEquals("original", info["summary"], "move must write the source value at the destination:\n$merged")
        assertEquals(false, info.containsKey("description"), "move must remove the source key:\n$merged")
    }

    @Test
    fun `copy of a missing source pointer fails loudly instead of writing null`() {
        val e = assertFailsWith<IllegalArgumentException> {
            applier.applyTo(spec, listOf(Patch.Copy(from = "/info/nope", path = "/info/summary")))
        }
        assertTrue(e.message!!.contains("source not found"), e.message!!)
    }

    @Test
    fun `Potemkin extension ops are rejected for overlay translation`() {
        val e = assertFailsWith<IllegalArgumentException> {
            applier.translate(listOf(Patch.Increment("/x", 1.0)))
        }
        assertTrue(e.message!!.contains("RFC 6902"))
    }

    @Test
    fun `empty patches returns the spec unchanged`() {
        assertEquals(spec, applier.applyTo(spec, emptyList()))
    }
}
