package com.potemkin.specmatic

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.specmatic.core.HttpRequest
import io.specmatic.core.HttpResponse
import io.specmatic.core.value.StringValue
import io.specmatic.mock.ScenarioStub
import io.specmatic.stub.HttpStub
import io.specmatic.stub.HttpStubData
import org.slf4j.LoggerFactory
import java.util.concurrent.CopyOnWriteArrayList

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
 * ## Clearing registered stubs
 *
 * [clearExpectations] removes all stubs previously registered via [registerStub] from Specmatic's
 * internal `threadSafeHttpStubs` list via [ThreadSafeListOfStubs.remove]. The stubs are tracked
 * in [registeredStubData] (the `List<HttpStubData>` returned by each [setExpectation] call).
 * Specmatic does not expose a `clearAll` API, so we use the tracked handles.
 *
 * ## Body serialisation
 *
 * The fixture body (`Any?`) is serialised to a JSON string via Jackson and wrapped in a
 * Specmatic [StringValue]. Specmatic's own stub-matching treats JSON-string bodies as opaque
 * strings for exact matching, which is sufficient for DSL-derived fixtures.
 *
 * ## Testability
 *
 * [doSetExpectation] and [doClearExpectations] are `protected open` so tests can subclass the
 * bridge and override them to capture the [ScenarioStub] that would be passed to Specmatic,
 * without needing a real [HttpStub] instance (which is a final class requiring loaded contracts).
 */
open class SpecmaticStubBridge(private val httpStub: HttpStub?) {

    private val log = LoggerFactory.getLogger(SpecmaticStubBridge::class.java)
    private val mapper = jacksonObjectMapper()

    /** Tracks HttpStubData objects returned by setExpectation so we can remove them later. */
    private val registeredStubData = CopyOnWriteArrayList<HttpStubData>()

    /**
     * Registers a single [fixture] with Specmatic as a dynamic expectation.
     *
     * Returns true on success. Catches ALL exceptions (including Specmatic's
     * `NoMatchingScenario`), logs them at WARN level, and returns false.
     * Never throws.
     */
    open fun registerStub(fixture: FixtureStub): Boolean {
        return try {
            val specRequest = buildSpecmaticRequest(fixture.httpRequest)
            val specResponse = buildSpecmaticResponse(fixture.httpResponse)
            val scenarioStub = ScenarioStub(request = specRequest, response = specResponse)
            val stubDatas = doSetExpectation(scenarioStub)
            if (stubDatas != null) {
                registeredStubData.addAll(stubDatas)
            }
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
     * Unregisters all dynamic expectations previously registered via [registerStub].
     *
     * Called by [com.potemkin.specmatic.reliability.FixtureLifecycleManager] when the engine
     * transitions to DOWN and on hot-reload (before pushing the new fixture set).
     *
     * Uses the [HttpStubData] handles returned by [setExpectation] to call
     * [ThreadSafeListOfStubs.remove] for each registered stub. This approach avoids
     * clearing stubs that were registered by other means (e.g. static contract stubs).
     *
     * Never throws — any exception is caught and logged.
     */
    open fun clearExpectations() {
        try {
            doClearExpectations()
            log.debug("SpecmaticStubBridge: cleared {} registered expectation(s)", registeredStubData.size)
            registeredStubData.clear()
        } catch (e: Exception) {
            log.warn("SpecmaticStubBridge: failed to clear expectations: {}", e.message)
        }
    }

    /**
     * Removes all tracked [HttpStubData] from Specmatic's internal stub list via reflection.
     *
     * Overridable in tests to avoid requiring a real [HttpStub].
     */
    protected open fun doClearExpectations() {
        if (httpStub == null || registeredStubData.isEmpty()) return
        // Access the private threadSafeHttpStubs field via reflection.
        // Specmatic (2.6.0) stores registered stubs in HttpStub.threadSafeHttpStubs:ThreadSafeListOfStubs.
        // ThreadSafeListOfStubs.remove(HttpStubData) is the public per-stub remove API.
        try {
            val field = httpStub.javaClass.getDeclaredField("threadSafeHttpStubs")
            field.isAccessible = true
            val threadSafeStubs = field.get(httpStub)
            val removeMethod = threadSafeStubs.javaClass.getMethod("remove", HttpStubData::class.java)
            for (stubData in registeredStubData) {
                try {
                    removeMethod.invoke(threadSafeStubs, stubData)
                } catch (e: Exception) {
                    log.debug("SpecmaticStubBridge: could not remove stub data: {}", e.message)
                }
            }
        } catch (e: Exception) {
            log.warn("SpecmaticStubBridge: reflection-based clear failed: {} — stubs may persist", e.message)
        }
    }

    /**
     * Calls [HttpStub.setExpectation]. Overridable in tests to avoid requiring a real [HttpStub].
     * Returns the list of [HttpStubData] objects registered, or null if none.
     */
    protected open fun doSetExpectation(scenarioStub: ScenarioStub): List<HttpStubData>? {
        return httpStub!!.setExpectation(scenarioStub)
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
