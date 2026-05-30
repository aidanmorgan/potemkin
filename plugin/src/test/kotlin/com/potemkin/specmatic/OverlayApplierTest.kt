package com.potemkin.specmatic

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Integration tests for [OverlayApplier] (E5):
 *  - patches translate to Specmatic Overlay actions (AC-E5.1)
 *  - the overlay-merged spec reflects the change (AC-E5.2, AC-E5.3)
 */
class OverlayApplierTest {

    private val applier = OverlayApplier()

    private val spec = """
        openapi: 3.0.0
        info:
          title: Leads
          version: 1.0.0
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

        // The merged spec must now mark the operation deprecated.
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
    fun `remove patch translates to a remove action`() {
        val actions = applier.translate(listOf(Patch.Remove("/paths/~1leads/get")))
        assertEquals(1, actions.size)
        assertEquals("$.paths./leads.get", actions[0].target)
        assertTrue(actions[0].remove)
    }

    @Test
    fun `move patch unrolls into remove plus parent-targeted add`() {
        val actions = applier.translate(listOf(Patch.Move("/a/b", "/c/d")))
        assertEquals(2, actions.size)
        assertTrue(actions[0].remove)
        assertEquals("$.a.b", actions[0].target)
        assertEquals("$.c", actions[1].target)
        assertEquals(mapOf("d" to null), actions[1].update)
    }

    @Test
    fun `Potemkin extension ops are rejected for overlay translation`() {
        try {
            applier.translate(listOf(Patch.Increment("/x", 1.0)))
            assertTrue(false, "expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("RFC 6902"))
        }
    }

    @Test
    fun `empty patches returns the spec unchanged`() {
        assertEquals(spec, applier.applyTo(spec, emptyList()))
    }
}
