package com.potemkin.specmatic

import org.junit.jupiter.api.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Unit tests for [DeprecationPolicy]: overlay patches that flip an operation to
 * `deprecated:true` make the matching `(method, path)` deprecated; path templates
 * match concrete request paths.
 */
class DeprecationPolicyTest {

    @Test
    fun `add deprecated true on a templated path matches a concrete request`() {
        val policy = DeprecationPolicy.fromOverlayPatches(
            listOf(Patch.Add("/paths/~1leads~1{id}/get/deprecated", true)),
        )
        assertTrue(policy.isDeprecated("GET", "/leads/123e4567-e89b-12d3-a456-426614174000"))
        assertTrue(policy.isDeprecated("get", "/leads/abc"))
    }

    @Test
    fun `deprecation is scoped to the patched method`() {
        val policy = DeprecationPolicy.fromOverlayPatches(
            listOf(Patch.Replace("/paths/~1leads~1{id}/get/deprecated", true)),
        )
        assertTrue(policy.isDeprecated("GET", "/leads/x"))
        assertFalse(policy.isDeprecated("PATCH", "/leads/x"))
    }

    @Test
    fun `deprecation is scoped to the patched path`() {
        val policy = DeprecationPolicy.fromOverlayPatches(
            listOf(Patch.Add("/paths/~1leads~1{id}/get/deprecated", true)),
        )
        assertFalse(policy.isDeprecated("GET", "/campaigns/x"))
        assertFalse(policy.isDeprecated("GET", "/leads"))
    }

    @Test
    fun `string true is treated as truthy and false is ignored`() {
        val truthy = DeprecationPolicy.fromOverlayPatches(
            listOf(Patch.Add("/paths/~1leads/get/deprecated", "true")),
        )
        assertTrue(truthy.isDeprecated("GET", "/leads"))

        val falsy = DeprecationPolicy.fromOverlayPatches(
            listOf(Patch.Add("/paths/~1leads/get/deprecated", false)),
        )
        assertFalse(falsy.isDeprecated("GET", "/leads"))
    }

    @Test
    fun `non-deprecation overlay patches do not mark anything deprecated`() {
        val policy = DeprecationPolicy.fromOverlayPatches(
            listOf(
                Patch.Add("/paths/~1leads/get/summary", "List leads"),
                Patch.Remove("/paths/~1leads/get/deprecated"),
            ),
        )
        assertFalse(policy.isDeprecated("GET", "/leads"))
    }

    @Test
    fun `empty overlay yields a policy that deprecates nothing`() {
        val policy = DeprecationPolicy.fromOverlayPatches(emptyList())
        assertFalse(policy.isDeprecated("GET", "/leads"))
        assertFalse(policy.isDeprecated(null, null))
    }
}
