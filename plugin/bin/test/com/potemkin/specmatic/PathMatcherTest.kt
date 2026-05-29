package com.potemkin.specmatic

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PathMatcherTest {

    // ---- compile() unit tests -----------------------------------------------------------

    @Test
    fun `exact path matches identical input`() {
        val m = PathMatcher(listOf("/admin/health"))
        assertTrue(m.matches("/admin/health"))
    }

    @Test
    fun `exact path does not match different path`() {
        val m = PathMatcher(listOf("/admin/health"))
        assertFalse(m.matches("/admin/other"))
    }

    @Test
    fun `exact path does not match path with extra segment`() {
        val m = PathMatcher(listOf("/admin/health"))
        assertFalse(m.matches("/admin/health/deep"))
    }

    @Test
    fun `single star matches one segment`() {
        val m = PathMatcher(listOf("/items/*"))
        assertTrue(m.matches("/items/123"))
        assertTrue(m.matches("/items/abc-def"))
    }

    @Test
    fun `single star does not match zero extra segments`() {
        val m = PathMatcher(listOf("/items/*"))
        assertFalse(m.matches("/items"))
        assertFalse(m.matches("/items/"))
    }

    @Test
    fun `single star does not match multiple extra segments`() {
        val m = PathMatcher(listOf("/items/*"))
        assertFalse(m.matches("/items/123/detail"))
    }

    @Test
    fun `double star matches one segment`() {
        val m = PathMatcher(listOf("/loans/**"))
        assertTrue(m.matches("/loans/123"))
    }

    @Test
    fun `double star matches multiple segments`() {
        val m = PathMatcher(listOf("/loans/**"))
        assertTrue(m.matches("/loans/123/repayments"))
        assertTrue(m.matches("/loans/123/repayments/456"))
    }

    @Test
    fun `double star matches base path with no trailing segment`() {
        val m = PathMatcher(listOf("/loans/**"))
        assertTrue(m.matches("/loans"))
    }

    @Test
    fun `named variable segment matches one segment`() {
        val m = PathMatcher(listOf("/customers/{id}"))
        assertTrue(m.matches("/customers/abc"))
        assertTrue(m.matches("/customers/123"))
    }

    @Test
    fun `named variable segment does not match multiple segments`() {
        val m = PathMatcher(listOf("/customers/{id}"))
        assertFalse(m.matches("/customers/abc/orders"))
    }

    @Test
    fun `named variable segment does not match parent path`() {
        val m = PathMatcher(listOf("/customers/{id}"))
        assertFalse(m.matches("/customers"))
    }

    @Test
    fun `mixed named captures and literals match correctly`() {
        val m = PathMatcher(listOf("/accounts/{id}/transactions"))
        assertTrue(m.matches("/accounts/42/transactions"))
        assertFalse(m.matches("/accounts/42/balances"))
        assertFalse(m.matches("/accounts/transactions"))
    }

    @Test
    fun `multiple patterns - first matches`() {
        val m = PathMatcher(listOf("/loans/**", "/customers/{id}"))
        assertTrue(m.matches("/loans/anything"))
    }

    @Test
    fun `multiple patterns - second matches`() {
        val m = PathMatcher(listOf("/loans/**", "/customers/{id}"))
        assertTrue(m.matches("/customers/99"))
    }

    @Test
    fun `multiple patterns - neither matches`() {
        val m = PathMatcher(listOf("/loans/**", "/customers/{id}"))
        assertFalse(m.matches("/products/1"))
    }

    @Test
    fun `null path returns false`() {
        val m = PathMatcher(listOf("/loans/**"))
        assertFalse(m.matches(null))
    }

    @Test
    fun `empty pattern list matches nothing`() {
        val m = PathMatcher(emptyList())
        assertFalse(m.matches("/anything"))
    }

    @Test
    fun `trailing slash on input is normalised`() {
        val m = PathMatcher(listOf("/admin/health"))
        assertTrue(m.matches("/admin/health/"))
    }

    // ---- compile() regex unit tests -----------------------------------------------------

    @Test
    fun `compile exact produces anchored regex`() {
        val re = PathMatcher.compile("/admin/health")
        assertTrue(re.matches("/admin/health"))
        assertFalse(re.matches("/admin/health/x"))
    }

    @Test
    fun `compile double-star at end allows optional tail`() {
        val re = PathMatcher.compile("/loans/**")
        assertTrue(re.matches("/loans"))
        assertTrue(re.matches("/loans/123"))
        assertTrue(re.matches("/loans/123/sub"))
    }
}
