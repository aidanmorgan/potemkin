package com.potemkin.specmatic

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.specmatic.mock.ScenarioStub
import io.specmatic.stub.HttpStubData
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Integration tests for [SeedApplier] (E4):
 *  - seeds compiled (base + patches via [PatchApplier]) and pushed to
 *    httpStub.setExpectation (AC-E4.1, AC-E4.3)
 *  - the registered ScenarioStub carries the compiled seed body.
 */
class SeedApplierTest {

    private val mapper = jacksonObjectMapper()

    /** Capturing bridge: records the ScenarioStub instead of calling a real HttpStub. */
    private class CapturingBridge : SpecmaticStubBridge(null) {
        val captured = mutableListOf<ScenarioStub>()
        override fun doSetExpectation(scenarioStub: ScenarioStub): List<HttpStubData>? {
            captured.add(scenarioStub)
            return null
        }
    }

    private fun seed(
        path: String = "/loans/L-1",
        method: String = "GET",
        base: SeedBase = SeedBase.EMPTY,
        patches: List<Patch>,
    ) = SeedDeclaration(
        request = SeedRequestMatcher(method, path),
        base = base,
        patches = patches,
    )

    @Test
    fun `seed is pushed to setExpectation at apply`() {
        val bridge = CapturingBridge()
        val count = SeedApplier(bridge).applyAll(
            listOf(seed(patches = listOf(Patch.Add("/status", "ACTIVE")))),
        )

        assertEquals(1, count)
        assertEquals(1, bridge.captured.size)
        val stub = bridge.captured[0]
        assertEquals("GET", stub.request.method)
        assertEquals("/loans/L-1", stub.request.path)
    }

    @Test
    fun `compiled seed body reflects applied patches`() {
        val bridge = CapturingBridge()
        SeedApplier(bridge).applyAll(
            listOf(
                seed(
                    patches = listOf(
                        Patch.Add("/id", "L-1"),
                        Patch.Add("/balance", 100),
                        Patch.Increment("/balance", 5.0),
                    ),
                ),
            ),
        )

        val body = bridge.captured[0].response.body.toStringLiteral()
        @Suppress("UNCHECKED_CAST")
        val parsed = mapper.readValue(body, Map::class.java) as Map<String, Any?>
        assertEquals("L-1", parsed["id"])
        assertEquals(105, parsed["balance"])
    }

    @Test
    fun `contract base resolver supplies the starting body`() {
        val bridge = CapturingBridge()
        val applier = SeedApplier(bridge, contractBaseResolver = { mapOf("id" to "from-contract", "status" to "NEW") })
        applier.applyAll(
            listOf(seed(base = SeedBase.CONTRACT, patches = listOf(Patch.Replace("/status", "ACTIVE")))),
        )

        @Suppress("UNCHECKED_CAST")
        val parsed = mapper.readValue(bridge.captured[0].response.body.toStringLiteral(), Map::class.java) as Map<String, Any?>
        assertEquals("from-contract", parsed["id"])
        assertEquals("ACTIVE", parsed["status"])
    }

    @Test
    fun `a seed with a failing patch is skipped without aborting the rest`() {
        val bridge = CapturingBridge()
        val count = SeedApplier(bridge).applyAll(
            listOf(
                seed(path = "/bad", patches = listOf(Patch.Replace("/missing", 1))), // fails
                seed(path = "/good", patches = listOf(Patch.Add("/ok", true))),
            ),
        )

        assertEquals(1, count)
        assertEquals(1, bridge.captured.size)
        assertEquals("/good", bridge.captured[0].request.path)
    }

    @Test
    fun `response status defaults to 200 with json content type`() {
        val bridge = CapturingBridge()
        SeedApplier(bridge).applyAll(listOf(seed(patches = listOf(Patch.Add("/x", 1)))))
        val resp = bridge.captured[0].response
        assertEquals(200, resp.status)
        assertTrue(resp.headers["Content-Type"]?.contains("json") == true)
    }
}
