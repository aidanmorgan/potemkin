package com.potemkin.specmatic

import io.specmatic.core.Feature
import io.specmatic.stub.HttpStub
import io.specmatic.stub.HttpStubData
import io.specmatic.stub.ThreadSafeListOfStubs
import java.lang.reflect.Field

/**
 * The small part of Specmatic's private implementation that the plugin has to
 * reach for fixture removal and contract-based seed bodies.
 *
 * These checks deliberately inspect class metadata only. In particular, they
 * do not read the expectation lists from an HttpStub instance: those values
 * can be null or empty while Specmatic is starting.
 *
 * The plugin has one explicit reflection contract: Specmatic 2.46.2 stores
 * its three expectation lists below `HttpStub.httpExpectations`. Any other
 * shape fails before the plugin starts serving traffic.
 */
internal object SpecmaticReflectionContract {

    private const val FEATURES_FIELD = "features"
    private const val EXPECTATIONS_FIELD = "httpExpectations"
    private const val REMOVE_METHOD = "remove"
    private val EXPECTATION_PARTITIONS = listOf("static", "transient", "dynamic")

    /**
     * Validates the reflective members required by the plugin at boot.
     *
     * [httpStubType] is a parameter rather than an HttpStub instance so tests
     * can model an upgraded or incomplete Specmatic class without constructing
     * a server or loading a contract.
     */
    fun validate(httpStubType: Class<*>) {
        declaredFieldOrFail(
            owner = httpStubType,
            name = FEATURES_FIELD,
            purpose = "contract feature discovery",
            expected = "a declared HttpStub.features field",
        )

        validateHttpExpectationsLayout(httpStubType)
    }

    /**
     * Reads the already-validated feature field for contract-based seeds.
     * This is intentionally eager at resolver construction rather than lazy at
     * the first seed request, so an incompatible Specmatic shape cannot appear
     * half-way through a run.
     */
    @Suppress("UNCHECKED_CAST")
    fun readFeatures(httpStub: HttpStub): List<Feature> {
        val field = declaredFieldOrFail(
            owner = httpStub.javaClass,
            name = FEATURES_FIELD,
            purpose = "contract feature discovery",
            expected = "a declared HttpStub.features field",
        )
        try {
            field.isAccessible = true
            return (field.get(httpStub) as? List<Feature>)
                ?: fail(
                    httpStub.javaClass,
                    "declared field '$FEATURES_FIELD' was null or not a List<Feature>",
                )
        } catch (e: PluginBootException) {
            throw e
        } catch (e: Exception) {
            fail(
                httpStub.javaClass,
                "declared field '$FEATURES_FIELD' could not be read: ${e.message ?: e::class.java.name}",
                e,
            )
        }
    }

    /** Remove dynamic fixture expectations through the canonical Specmatic layout. */
    fun removeExpectations(httpStub: HttpStub, registered: Collection<HttpStubData>) {
        if (registered.isEmpty()) return
        val expectationsField = declaredFieldOrFail(
            owner = httpStub.javaClass,
            name = EXPECTATIONS_FIELD,
            purpose = "fixture expectation removal",
            expected = "a declared HttpStub.httpExpectations field",
        )
        val expectations = try {
            expectationsField.isAccessible = true
            expectationsField.get(httpStub)
                ?: fail(httpStub.javaClass, "declared field '$EXPECTATIONS_FIELD' was null")
        } catch (e: PluginBootException) {
            throw e
        } catch (e: Exception) {
            fail(
                httpStub.javaClass,
                "declared field '$EXPECTATIONS_FIELD' could not be read: " +
                    (e.message ?: e::class.java.name),
                e,
            )
        }

        for (partition in EXPECTATION_PARTITIONS) {
            val partitionField = declaredFieldOrFail(
                owner = expectations.javaClass,
                name = partition,
                purpose = "fixture expectation removal",
                expected = "a declared HttpExpectations.$partition field",
            )
            try {
                partitionField.isAccessible = true
                val list = partitionField.get(expectations)
                    ?: fail(
                        httpStub.javaClass,
                        "declared field '$EXPECTATIONS_FIELD.$partition' was null",
                    )
                val remove = list.javaClass.getMethod(REMOVE_METHOD, HttpStubData::class.java)
                for (stubData in registered) remove.invoke(list, stubData)
            } catch (e: PluginBootException) {
                throw e
            } catch (e: Exception) {
                fail(
                    httpStub.javaClass,
                    "could not remove fixture expectations from " +
                        "'$EXPECTATIONS_FIELD.$partition': " +
                        (e.message ?: e::class.java.name),
                    e,
                )
            }
        }
    }

    private fun validateHttpExpectationsLayout(httpStubType: Class<*>) {
        val expectations = declaredFieldOrFail(
            owner = httpStubType,
            name = EXPECTATIONS_FIELD,
            purpose = "fixture expectation removal",
            expected = "a declared HttpStub.httpExpectations field",
        )
        val expectationsType = expectations.type

        for (partition in EXPECTATION_PARTITIONS) {
            val partitionField = declaredFieldOrFail(
                owner = expectationsType,
                name = partition,
                purpose = "fixture expectation removal",
                expected = "a declared HttpExpectations.$partition field of type " +
                    ThreadSafeListOfStubs::class.java.name,
            )
            if (partitionField.type != ThreadSafeListOfStubs::class.java) {
                fail(
                    httpStubType,
                    "declared field '$EXPECTATIONS_FIELD.$partition' has type " +
                        "${partitionField.type.name}, expected ${ThreadSafeListOfStubs::class.java.name}",
                )
            }
        }

        try {
            ThreadSafeListOfStubs::class.java.getMethod(REMOVE_METHOD, HttpStubData::class.java)
        } catch (e: Exception) {
            fail(
                httpStubType,
                "${ThreadSafeListOfStubs::class.java.name} is missing public " +
                    "${REMOVE_METHOD}(${HttpStubData::class.java.name}) required for fixture removal",
                e,
            )
        }
    }

    private fun declaredFieldOrFail(
        owner: Class<*>,
        name: String,
        purpose: String,
        expected: String,
    ): Field {
        return try {
            owner.getDeclaredField(name)
        } catch (e: Exception) {
            fail(
                owner,
                "missing declared field '$name' for $purpose; expected $expected",
                e,
            )
        }
    }

    private fun fail(owner: Class<*>, detail: String, cause: Throwable? = null): Nothing {
        throw PluginBootException(
            "BOOT_ERR_SPECMATIC_REFLECTION: incompatible Specmatic reflection contract on " +
                "${owner.name}: $detail. Verify the Specmatic runtime version and the plugin " +
                "supported Specmatic reflection contract before starting the stub.",
            cause,
        )
    }
}
