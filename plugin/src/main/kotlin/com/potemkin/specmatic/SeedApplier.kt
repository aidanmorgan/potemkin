package com.potemkin.specmatic

import org.slf4j.LoggerFactory

/**
 * Compiles `seeds[]` from potemkin.yaml and registers them with Specmatic as
 * dynamic expectations via [SpecmaticStubBridge] (which calls
 * `httpStub.setExpectation(ScenarioStub)`).
 *
 * Kotlin port of the engine's seed compiler (`src/dsl/seedCompiler.ts`): each
 * seed body starts from its `base` (the contract-generated body for
 * [SeedBase.CONTRACT], or an empty object for [SeedBase.EMPTY]) and the seed's
 * `patches` are applied via [PatchApplier].
 *
 * Dependencies are injected (rule: no static lifecycle state):
 *  - [bridge]: registers compiled seeds with Specmatic.
 *  - [contractBaseResolver]: supplies the `contract`-base body for a seed request.
 *    The plugin can wire this to query Specmatic for the matching scenario's
 *    generated body; when unavailable it returns an empty object — the same
 *    fallback the TS compiler documents (`() => ({})`).
 */
class SeedApplier(
    private val bridge: SpecmaticStubBridge,
    private val contractBaseResolver: (SeedRequestMatcher) -> Map<String, Any?> = { emptyMap() },
) {
    private val log = LoggerFactory.getLogger(SeedApplier::class.java)

    /**
     * Compile a single seed: apply its patches on top of its base body.
     * Throws [PatchApplyException] if a patch op fails (the seed is invalid).
     */
    fun compile(seed: SeedDeclaration): CompiledSeed {
        val base: Map<String, Any?> = when (seed.base) {
            SeedBase.CONTRACT -> contractBaseResolver(seed.request)
            SeedBase.EMPTY -> emptyMap()
        }
        val body = PatchApplier.apply(base, seed.patches)
        return CompiledSeed(seed.request, body, seed.description)
    }

    /** Convert a compiled seed into the [FixtureStub] the bridge registers. */
    fun toFixture(compiled: CompiledSeed): FixtureStub = FixtureStub(
        httpRequest = FixtureHttpRequest(
            method = compiled.request.method,
            path = compiled.request.path,
        ),
        httpResponse = FixtureHttpResponse(
            status = 200,
            headers = mapOf("Content-Type" to "application/json"),
            body = compiled.body,
        ),
        source = FixtureSource(
            boundary = "seed",
            aggregateId = compiled.description ?: compiled.request.path,
            contractPath = compiled.request.path,
        ),
    )

    /**
     * Compile and register every seed. Returns the number of seeds successfully
     * registered with Specmatic. Compilation failures are logged and skipped so
     * one bad seed never aborts plugin boot.
     */
    fun applyAll(seeds: List<SeedDeclaration>): Int {
        var registered = 0
        for (seed in seeds) {
            val compiled = try {
                compile(seed)
            } catch (e: PatchApplyException) {
                log.warn(
                    "SeedApplier: seed {} {} patch[{}] '{}' at {} failed: {} — skipping",
                    seed.request.method, seed.request.path, e.patchIndex, e.op, e.path, e.message,
                )
                continue
            }
            if (bridge.registerStub(toFixture(compiled))) registered++
        }
        log.info("SeedApplier: registered {}/{} seed expectation(s)", registered, seeds.size)
        return registered
    }
}

/** A seed compiled to a response body, ready to register as an expectation. */
data class CompiledSeed(
    val request: SeedRequestMatcher,
    val body: Any?,
    val description: String? = null,
)
