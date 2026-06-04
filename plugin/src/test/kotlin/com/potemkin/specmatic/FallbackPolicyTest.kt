package com.potemkin.specmatic

import org.junit.jupiter.api.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Unit tests for the pure path-template compiler used by the fallback policy.
 *  The HTTP fetch + end-to-end behaviour is covered by the example harness tests. */
class FallbackPolicyTest {

    @Test
    fun `compilePattern matches templates, single-segment and double-star globs`() {
        assertTrue(FallbackPolicy.compilePattern("/v1/customers/{customer}").matches("/v1/customers/cus_1"))
        assertFalse(FallbackPolicy.compilePattern("/v1/customers/{customer}").matches("/v1/customers"))

        val seg = FallbackPolicy.compilePattern("/v1/*")
        assertTrue(seg.matches("/v1/payouts"))
        assertFalse(seg.matches("/v1/payouts/po_1")) // * is single-segment

        val deep = FallbackPolicy.compilePattern("/internal/**")
        assertTrue(deep.matches("/internal/a/b/c"))
        assertFalse(deep.matches("/public/a"))
    }
}
