package com.potemkin.specmatic

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Unit tests for [FormFieldIndex] coercion + path-template matching (the pure
 * companion helpers). The HTTP fetch + end-to-end forwarding is covered by the
 * Stripe consumer example tests.
 */
class FormFieldIndexTest {

    @Test
    fun `coerceValue parses integers, numbers and booleans, leaves strings`() {
        assertEquals(2000L, FormFieldIndex.coerceValue("2000", "integer"))
        assertEquals(9.99, FormFieldIndex.coerceValue("9.99", "number"))
        assertEquals(true, FormFieldIndex.coerceValue("true", "boolean"))
        assertEquals(false, FormFieldIndex.coerceValue("false", "boolean"))
        assertEquals("acme@example.com", FormFieldIndex.coerceValue("acme@example.com", null))
        assertEquals("hello", FormFieldIndex.coerceValue("hello", "string"))
    }

    @Test
    fun `coerceValue leaves non-numeric strings untouched even when type is integer`() {
        // Defensive: a malformed value is passed through rather than dropped.
        assertEquals("N/A", FormFieldIndex.coerceValue("N/A", "integer"))
    }

    @Test
    fun `compilePattern matches concrete paths for templated routes`() {
        val collection = FormFieldIndex.compilePattern("/v1/customers")
        assertTrue(collection.matches("/v1/customers"))
        assertFalse(collection.matches("/v1/customers/cus_123"))

        val byId = FormFieldIndex.compilePattern("/v1/customers/{customer}")
        assertTrue(byId.matches("/v1/customers/cus_123"))
        assertFalse(byId.matches("/v1/customers"))
        assertFalse(byId.matches("/v1/customers/cus_123/extra"))

        val sub = FormFieldIndex.compilePattern("/v1/payment_intents/{id}/confirm")
        assertTrue(sub.matches("/v1/payment_intents/pi_9/confirm"))
        assertFalse(sub.matches("/v1/payment_intents/pi_9/cancel"))
    }

    @Test
    fun `typeFor returns null when nothing has been fetched`() {
        // No engine reachable at this URL → operations stay empty → null (string passthrough).
        val idx = FormFieldIndex("http://127.0.0.1:1", okhttp3.OkHttpClient())
        assertNull(idx.typeFor("POST", "/v1/customers", "balance"))
    }
}
