package com.potemkin.specmatic

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Parity tests for [PatchApplier] against the TS `applyPatches` fixtures in
 * `tests/unit/dsl/patches.test.ts`. Each test mirrors a TS case: same input
 * state, same patch list, same expected output (E1.4).
 */
class PatchApplierTest {

    private fun obj(vararg pairs: Pair<String, Any?>): MutableMap<String, Any?> =
        linkedMapOf(*pairs)

    private fun arr(vararg items: Any?): MutableList<Any?> = mutableListOf(*items)

    // ---- RFC 6902 ops -------------------------------------------------------

    @Test
    fun `add inserts a new object property`() {
        val state = obj("a" to 1L)
        val result = PatchApplier.apply(state, listOf(Patch.Add("/b", 2L)))
        assertEquals(obj("a" to 1L, "b" to 2L), result)
        assertEquals(obj("a" to 1L), state) // input never mutated
    }

    @Test
    fun `replace overwrites an existing property`() {
        val result = PatchApplier.apply(obj("a" to 1L, "b" to 2L), listOf(Patch.Replace("/a", 99L)))
        assertEquals(obj("a" to 99L, "b" to 2L), result)
    }

    @Test
    fun `replace fails when target is missing`() {
        assertThrows<PatchApplyException> {
            PatchApplier.apply(obj("a" to 1L), listOf(Patch.Replace("/missing", 0L)))
        }
    }

    @Test
    fun `remove deletes an existing key`() {
        val result = PatchApplier.apply(obj("a" to 1L, "b" to 2L), listOf(Patch.Remove("/a")))
        assertEquals(obj("b" to 2L), result)
    }

    @Test
    fun `remove fails when target is missing`() {
        assertThrows<PatchApplyException> {
            PatchApplier.apply(obj(), listOf(Patch.Remove("/x")))
        }
    }

    @Test
    fun `move relocates a value`() {
        val state = obj("a" to obj("x" to 1L), "b" to obj())
        val result = PatchApplier.apply(state, listOf(Patch.Move("/a/x", "/b/x")))
        assertEquals(obj("a" to obj(), "b" to obj("x" to 1L)), result)
    }

    @Test
    fun `copy duplicates a value`() {
        val result = PatchApplier.apply(obj("a" to 1L), listOf(Patch.Copy("/a", "/b")))
        assertEquals(obj("a" to 1L, "b" to 1L), result)
    }

    @Test
    fun `add into an array at index inserts does not replace`() {
        val state = obj("items" to arr(10L, 20L))
        val result = PatchApplier.apply(state, listOf(Patch.Add("/items/1", 15L)))
        assertEquals(obj("items" to arr(10L, 15L, 20L)), result)
    }

    @Test
    fun `add at array-end sentinel appends`() {
        val state = obj("items" to arr(1L, 2L))
        val result = PatchApplier.apply(state, listOf(Patch.Add("/items/-", 3L)))
        assertEquals(obj("items" to arr(1L, 2L, 3L)), result)
    }

    // ---- Potemkin extensions ------------------------------------------------

    @Test
    fun `append pushes to an array`() {
        val result = PatchApplier.apply(obj("items" to arr(1L, 2L)), listOf(Patch.Append("/items", 3L)))
        assertEquals(obj("items" to arr(1L, 2L, 3L)), result)
    }

    @Test
    fun `prepend inserts at front`() {
        val result = PatchApplier.apply(obj("items" to arr(2L, 3L)), listOf(Patch.Prepend("/items", 1L)))
        assertEquals(obj("items" to arr(1L, 2L, 3L)), result)
    }

    @Test
    fun `append fails when target is not an array`() {
        assertThrows<PatchApplyException> {
            PatchApplier.apply(obj("x" to 1L), listOf(Patch.Append("/x", 1L)))
        }
    }

    @Test
    fun `increment adds to a numeric field`() {
        val result = PatchApplier.apply(obj("count" to 5L), listOf(Patch.Increment("/count", 3.0)))
        assertEquals(obj("count" to 8L), result)
    }

    @Test
    fun `increment fails on non-numeric target`() {
        assertThrows<PatchApplyException> {
            PatchApplier.apply(obj("x" to "str"), listOf(Patch.Increment("/x", 1.0)))
        }
    }

    @Test
    fun `merge shallow overrides per-key`() {
        val state = obj("meta" to obj("a" to 1L, "b" to obj("x" to 0L)))
        val result = PatchApplier.apply(
            state,
            listOf(Patch.Merge("/meta", mapOf("b" to mapOf("y" to 9L), "c" to 3L))),
        )
        assertEquals(obj("meta" to obj("a" to 1L, "b" to obj("y" to 9L), "c" to 3L)), result)
    }

    @Test
    fun `merge deep recurses into nested objects`() {
        val state = obj("meta" to obj("a" to 1L, "b" to obj("x" to 0L)))
        val result = PatchApplier.apply(
            state,
            listOf(Patch.Merge("/meta", mapOf("b" to mapOf("y" to 9L), "c" to 3L), deep = true)),
        )
        assertEquals(obj("meta" to obj("a" to 1L, "b" to obj("x" to 0L, "y" to 9L), "c" to 3L)), result)
    }

    @Test
    fun `upsert by key updates an existing entry`() {
        val state = obj("lineItems" to arr(obj("id" to "a", "qty" to 1L), obj("id" to "b", "qty" to 2L)))
        val result = PatchApplier.apply(
            state,
            listOf(Patch.Upsert("/lineItems", "id", mapOf("id" to "a", "qty" to 9L))),
        )
        assertEquals(
            obj("lineItems" to arr(obj("id" to "a", "qty" to 9L), obj("id" to "b", "qty" to 2L))),
            result,
        )
    }

    @Test
    fun `upsert by key appends when no match`() {
        val state = obj("lineItems" to arr(obj("id" to "a")))
        val result = PatchApplier.apply(
            state,
            listOf(Patch.Upsert("/lineItems", "id", mapOf("id" to "b"))),
        )
        assertEquals(obj("lineItems" to arr(obj("id" to "a"), obj("id" to "b"))), result)
    }

    // ---- atomicity ----------------------------------------------------------

    @Test
    fun `input state is never mutated even after multiple ops`() {
        val state = obj(
            "items" to arr(obj("id" to "a", "v" to 1L)),
            "meta" to obj("hits" to 0L),
        )
        PatchApplier.apply(
            state,
            listOf(
                Patch.Append("/items", mapOf("id" to "b", "v" to 2L)),
                Patch.Increment("/meta/hits", 1.0),
            ),
        )
        @Suppress("UNCHECKED_CAST")
        assertEquals(1, (state["items"] as List<Any?>).size)
        @Suppress("UNCHECKED_CAST")
        assertEquals(0L, (state["meta"] as Map<String, Any?>)["hits"])
    }

    @Test
    fun `a mid-sequence failure throws and the original state is unchanged`() {
        val state = obj("a" to 1L)
        assertThrows<PatchApplyException> {
            PatchApplier.apply(
                state,
                listOf(Patch.Add("/b", 2L), Patch.Remove("/missing")),
            )
        }
        assertEquals(obj("a" to 1L), state)
    }

    @Test
    fun `failure carries patch index path and op`() {
        val ex = assertThrows<PatchApplyException> {
            PatchApplier.apply(obj("a" to 1L), listOf(Patch.Add("/b", 2L), Patch.Remove("/missing")))
        }
        assertEquals(1, ex.patchIndex)
        assertEquals("/missing", ex.path)
        assertEquals("remove", ex.op)
    }

    // ---- pointer parsing ----------------------------------------------------

    @Test
    fun `parsePointer round-trips simple paths`() {
        assertEquals("/a/b/c", PatchApplier.joinPointer(PatchApplier.parsePointer("/a/b/c")))
    }

    @Test
    fun `parsePointer handles RFC 6901 escapes`() {
        assertEquals(listOf("a/b", "c~d"), PatchApplier.parsePointer("/a~1b/c~0d"))
        assertEquals("/a~1b/c~0d", PatchApplier.joinPointer(listOf("a/b", "c~d")))
    }

    @Test
    fun `parsePointer empty pointer parses to empty list`() {
        assertTrue(PatchApplier.parsePointer("").isEmpty())
    }

    @Test
    fun `parsePointer rejects pointers that do not start with slash`() {
        assertThrows<IllegalArgumentException> { PatchApplier.parsePointer("a/b") }
    }

    // ---- wire-format decode (Patch.from) ------------------------------------

    @Test
    fun `Patch from decodes every op`() {
        assertTrue(Patch.from(mapOf("op" to "add", "path" to "/x", "value" to 1)) is Patch.Add)
        assertTrue(Patch.from(mapOf("op" to "remove", "path" to "/x")) is Patch.Remove)
        assertTrue(Patch.from(mapOf("op" to "replace", "path" to "/x", "value" to 1)) is Patch.Replace)
        assertTrue(Patch.from(mapOf("op" to "move", "from" to "/a", "path" to "/b")) is Patch.Move)
        assertTrue(Patch.from(mapOf("op" to "copy", "from" to "/a", "path" to "/b")) is Patch.Copy)
        assertTrue(Patch.from(mapOf("op" to "append", "path" to "/x", "value" to 1)) is Patch.Append)
        assertTrue(Patch.from(mapOf("op" to "prepend", "path" to "/x", "value" to 1)) is Patch.Prepend)
        assertTrue(Patch.from(mapOf("op" to "increment", "path" to "/x", "by" to 2)) is Patch.Increment)
        assertTrue(Patch.from(mapOf("op" to "merge", "path" to "/x", "value" to mapOf("a" to 1))) is Patch.Merge)
        assertTrue(Patch.from(mapOf("op" to "upsert", "path" to "/x", "key" to "id", "value" to mapOf("id" to 1))) is Patch.Upsert)
    }

    @Test
    fun `Patch from rejects unknown op`() {
        assertThrows<IllegalArgumentException> { Patch.from(mapOf("op" to "frobnicate", "path" to "/x")) }
    }
}
