package com.potemkin.specmatic

import io.specmatic.core.Feature
import io.specmatic.stub.ThreadSafeListOfStubs
import org.junit.jupiter.api.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Tests the boot-time reflection contract without constructing HttpStub.
 *
 * A real HttpStub needs a loaded contract and a server-oriented constructor.
 * The validator intentionally accepts a Class so an absent or changed member
 * can be tested before any runtime field value exists.
 */
class SpecmaticReflectionContractTest {

    @Test
    fun `the Specmatic 2 46 2 class layout passes without a populated stub`() {
        SpecmaticReflectionContract.validate(io.specmatic.stub.HttpStub::class.java)
    }

    @Test
    fun `canonical expectation layout is validated without reading its value`() {
        // The fields are deliberately uninitialised: boot validation checks
        // the current Specmatic shape before any expectation list is populated.
        SpecmaticReflectionContract.validate(CanonicalLayout::class.java)
    }

    @Test
    fun `missing httpExpectations fails the boot guard with an actionable error`() {
        val error = assertFailsWith<PluginBootException> {
            SpecmaticReflectionContract.validate(MissingRemovalFieldLayout::class.java)
        }

        assertTrue(error.message!!.startsWith("BOOT_ERR_SPECMATIC_REFLECTION:"))
        assertTrue(error.message!!.contains("httpExpectations"))
    }

    @Test
    fun `changed expectation partition type fails the boot guard`() {
        val error = assertFailsWith<PluginBootException> {
            SpecmaticReflectionContract.validate(ChangedRemoveSignatureLayout::class.java)
        }

        assertTrue(error.message!!.contains("dynamic"))
        assertTrue(error.message!!.contains(String::class.java.name))
    }

    @Test
    fun `missing expectation partition fails the boot guard`() {
        val error = assertFailsWith<PluginBootException> {
            SpecmaticReflectionContract.validate(MissingPartitionLayout::class.java)
        }

        assertTrue(error.message!!.contains("dynamic"))
    }

    @Test
    fun `missing features fails before a resolver can be used`() {
        val error = assertFailsWith<PluginBootException> {
            SpecmaticReflectionContract.validate(MissingFeaturesLayout::class.java)
        }

        assertTrue(error.message!!.contains("features"))
        assertTrue(error.message!!.contains("contract feature discovery"))
    }

    private class CanonicalLayout {
        @Suppress("unused")
        private val features: List<Feature> = emptyList()

        @Suppress("unused")
        private lateinit var httpExpectations: CanonicalExpectations
    }

    private class CanonicalExpectations {
        @Suppress("unused")
        private lateinit var static: ThreadSafeListOfStubs

        @Suppress("unused")
        private lateinit var transient: ThreadSafeListOfStubs

        @Suppress("unused")
        private lateinit var dynamic: ThreadSafeListOfStubs
    }

    private class MissingRemovalFieldLayout {
        @Suppress("unused")
        private val features: List<Feature> = emptyList()
    }

    private class ChangedRemoveSignatureLayout {
        @Suppress("unused")
        private val features: List<Feature> = emptyList()

        @Suppress("unused")
        private lateinit var httpExpectations: ChangedExpectations
    }

    private class ChangedExpectations {
        @Suppress("unused")
        private lateinit var static: ThreadSafeListOfStubs

        @Suppress("unused")
        private lateinit var transient: ThreadSafeListOfStubs

        @Suppress("unused")
        private lateinit var dynamic: String
    }

    private class MissingPartitionLayout {
        @Suppress("unused")
        private val features: List<Feature> = emptyList()

        @Suppress("unused")
        private lateinit var httpExpectations: MissingPartitionExpectations
    }

    private class MissingPartitionExpectations {
        @Suppress("unused")
        private lateinit var static: ThreadSafeListOfStubs

        @Suppress("unused")
        private lateinit var transient: ThreadSafeListOfStubs
    }

    private class MissingFeaturesLayout {
        @Suppress("unused")
        private lateinit var httpExpectations: CanonicalExpectations
    }
}
