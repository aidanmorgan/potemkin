package com.potemkin.specmatic

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.core.value.StringValue
import io.specmatic.mock.ScenarioStub
import io.specmatic.stub.HttpStub
import org.slf4j.LoggerFactory

/**
 * Shim that registers [FixtureStub]s with Specmatic's [HttpStub] as dynamic expectations.
 *
 * ## Specmatic stub-registration API
 *
 * This bridge calls [HttpStub.setExpectation(ScenarioStub)] — the verified public API located in
 * `io.specmatic.stub.HttpStub`. It takes an `io.specmatic.mock.ScenarioStub` which wraps a
 * Specmatic [HttpRequest] and [HttpResponse].
 *
 * **Important constraint**: `setExpectation` requires at least one loaded contract (feature) whose
 * scenario matches the stub's request/response shape. If no contract matches, Specmatic throws
 * `io.specmatic.core.NoMatchingScenario`. Because the Node engine's DSL fixtures may not always
 * correspond to a loaded contract at the time of registration, every call to [registerStub] wraps
 * the Specmatic call in a try/catch and logs + returns false on any failure. This ensures plugin
 * boot never fails due to an unregisterable fixture.
 *
 * ## Body serialisation
 *
 * The fixture body (`Any?`) is serialised to a JSON string via Jackson and wrapped in a
 * Specmatic [StringValue]. Specmatic's own stub-matching treats JSON-string bodies as opaque
 * strings for exact matching, which is sufficient for DSL-derived fixtures.
 *
 * ## Testability
 *
 * [doSetExpectation] is `protected open` so tests can subclass the bridge and override it
 * to capture the [ScenarioStub] that would be passed to Specmatic, without needing a real
 * [HttpStub] instance (which is a final class requiring loaded contracts).
 */
open class SpecmaticStubBridge(private val httpStub: HttpStub?) {

    private val log = LoggerFactory.getLogger(SpecmaticStubBridge::class.java)
    private val mapper = jacksonObjectMapper()

    /**
     * Registers a single [fixture] with Specmatic as a dynamic expectation.
     *
     * Returns true on success. Catches ALL exceptions (including Specmatic's
     * `NoMatchingScenario`), logs them at WARN level, and returns false.
     * Never throws.
     */
    fun registerStub(fixture: FixtureStub): Boolean {
        return try {
            val specRequest = buildSpecmaticRequest(fixture.httpRequest)
            val specResponse = buildSpecmaticResponse(fixture.httpResponse)
            val scenarioStub = ScenarioStub(request = specRequest, response = specResponse)
            doSetExpectation(scenarioStub)
            log.debug(
                "SpecmaticStubBridge: registered fixture stub {} {} (source: {}/{})",
                fixture.httpRequest.method,
                fixture.httpRequest.path,
                fixture.source.boundary,
                fixture.source.aggregateId,
            )
            true
        } catch (e: Exception) {
            // io.specmatic.core.NoMatchingScenario is the most common failure — the fixture
            // doesn't match any loaded contract scenario. Log and continue; plugin boot must
            // not fail because of an unregisterable fixture.
            log.warn(
                "SpecmaticStubBridge: failed to register fixture stub {} {} (source: {}/{}): {}",
                fixture.httpRequest.method,
                fixture.httpRequest.path,
                fixture.source.boundary,
                fixture.source.aggregateId,
                e.message,
            )
            false
        }
    }

    /**
     * Calls [HttpStub.setExpectation]. Overridable in tests to avoid requiring a real [HttpStub].
     */
    protected open fun doSetExpectation(scenarioStub: ScenarioStub) {
        httpStub!!.setExpectation(scenarioStub)
    }

    // ---- internal helpers (internal for test inspection) --------------------------------

    internal fun buildSpecmaticRequest(req: FixtureHttpRequest): HttpRequest {
        return HttpRequest(
            method = req.method.uppercase(),
            path = req.path,
            headers = req.headers ?: emptyMap(),
            // QueryParameters constructor is internal in some Specmatic builds; omit for now
            // and rely on path-only matching which is the primary fixture use-case.
        )
    }

    internal fun buildSpecmaticResponse(resp: FixtureHttpResponse): HttpResponse {
        val bodyValue = when (val body = resp.body) {
            null -> StringValue("")
            is String -> StringValue(body)
            else -> {
                // Serialize maps, lists, numbers, booleans to their JSON representation.
                StringValue(mapper.writeValueAsString(body))
            }
        }
        return HttpResponse(
            status = resp.status,
            headers = resp.headers,
            body = bodyValue,
        )
    }
}
