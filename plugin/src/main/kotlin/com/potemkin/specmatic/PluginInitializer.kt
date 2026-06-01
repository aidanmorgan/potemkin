package com.potemkin.specmatic

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.potemkin.specmatic.control.ControlServer
import com.potemkin.specmatic.control.ControlServerConfig
import com.potemkin.specmatic.reliability.FixtureLifecycleManager
import com.potemkin.specmatic.reliability.HealthMonitor
import com.potemkin.specmatic.reliability.HealthProbeConfig
import com.potemkin.specmatic.reliability.ResilienceConfig
import com.potemkin.specmatic.reliability.ResilientForwarder
import io.specmatic.core.Feature
import io.specmatic.core.HttpRequest
import io.specmatic.core.SpecmaticConfig
import io.specmatic.core.WorkflowConfiguration
import io.specmatic.core.value.JSONObjectValue
import io.specmatic.stub.HttpStub
import io.specmatic.stub.RequestContext
import io.specmatic.stub.StubInitializer
import org.slf4j.LoggerFactory

/**
 * SPI entry point for the Potemkin stateful plugin.
 *
 * Specmatic discovers this class via Java [java.util.ServiceLoader] using the file
 * `META-INF/services/io.specmatic.stub.StubInitializer` inside the plugin JAR.
 *
 * [initialize] is called once during [HttpStub] construction, before the HTTP server starts,
 * so [StatefulRequestHandler] is registered before any requests are served.
 *
 * Reliability components initialised here:
 *  - [HealthMonitor] — adaptive coroutine probe of `/_engine/health`
 *  - [ResilientForwarder] — resilience4j retry + circuit breaker around [CqrsBackendClient]
 *  - [FixtureLifecycleManager] — subscribes to health transitions; manages fixture push/clear
 *  - [ControlServer] — Ktor/Netty server receiving `/ready` and `/shutdown` from the Node engine
 */
class PluginInitializer : StubInitializer {

    private val log = LoggerFactory.getLogger(PluginInitializer::class.java)

    override fun initialize(specmaticConfig: SpecmaticConfig, httpStub: HttpStub) {
        log.info("Potemkin plugin initialising…")

        // Refuse to boot if another plugin already registered a request
        // handler — Potemkin assumes sole RequestHandler ownership.
        val existingHandlers = runCatching { httpStub.requestHandlers }.getOrNull()
        if (existingHandlers != null && existingHandlers.isNotEmpty()) {
            val classes = existingHandlers.joinToString(", ") { it::class.java.name }
            throw IllegalStateException(
                "BOOT_ERR_HANDLER_CONFLICT: another plugin already registered: $classes",
            )
        }

        val config = PluginConfig.load()
        log.info(
            "Potemkin plugin config: backendUrl={}, forwardTimeoutMs={}, discoveryRefreshOnFailureMs={}, controlPort={}",
            config.backendUrl,
            config.forwardTimeoutMs,
            config.discoveryRefreshOnFailureMs,
            config.controlPort,
        )

        val backendClient = CqrsBackendClient(config.backendUrl, config.forwardTimeoutMs)
        val resilient = ResilientForwarder(backendClient, ResilienceConfig.from(config))
        val discovery = RoutesDiscoveryClient(config.backendUrl, config.discoveryRefreshOnFailureMs)
        val fixturesClient = FixturesClient(config.backendUrl, config.discoveryRefreshOnFailureMs)
        val bridge = SpecmaticStubBridge(httpStub)

        val health = HealthMonitor(
            backendUrl = config.backendUrl,
            config = HealthProbeConfig.from(config),
        )
        val lifecycle = FixtureLifecycleManager(health, fixturesClient, bridge)
        val control = ControlServer(
            config = ControlServerConfig(port = config.controlPort),
            healthMonitor = health,
            routes = discovery,
            fixtures = fixturesClient,
        )

        health.addListener(lifecycle)
        health.start()
        lifecycle.start()

        try {
            control.start()
        } catch (e: Exception) {
            log.warn("ControlServer failed to start on port {}: {} — continuing without control server", config.controlPort, e.message)
        }

        Runtime.getRuntime().addShutdownHook(Thread {
            try { health.stop() } catch (e: Exception) { log.warn("Shutdown hook: HealthMonitor.stop() failed: {}", e.message) }
            try { lifecycle.stop() } catch (e: Exception) { log.warn("Shutdown hook: FixtureLifecycleManager.stop() failed: {}", e.message) }
            try { control.stop() } catch (e: Exception) { log.warn("Shutdown hook: ControlServer.stop() failed: {}", e.message) }
            try { discovery.shutdown() } catch (e: Exception) { log.warn("Shutdown hook: RoutesDiscoveryClient.shutdown() failed: {}", e.message) }
        })

        // Forward-blocks → live components. The overlay is NOT applied by this
        // plugin at runtime: it is written to a file by the test launcher, which
        // points Specmatic's `overlayFilePath` env var at it so Specmatic applies
        // it at HttpStub construction (before this `initialize` runs). Here the
        // plugin only derives the runtime behaviours that ride on top of the
        // already-overlaid spec:
        //  - A [DeprecationPolicy] so deprecated operations carry `Deprecation:true`
        //    (Specmatic emits no Deprecation header for `deprecated:true` operations).
        //  - A [WorkflowPropagator] that chains ids across the forward path
        //    (Specmatic's workflow is contract-test-mode-only; see applyForwardBlocks).
        val blocks = config.forwardBlocks
        val deprecationPolicy = DeprecationPolicy.fromOverlayPatches(blocks.overlay.patches)
        val workflowPropagator = WorkflowPropagator(blocks.workflow)

        val handler = StatefulRequestHandler(
            discovery, backendClient, fixturesClient, resilient, workflowPropagator,
        )
        httpStub.registerHandler(handler)
        val jwksProvider: JwksProvider = when {
            config.auth.jwks.isNotEmpty() -> JwksProvider { config.auth.jwks }
            config.auth.jwksUrl != null -> HttpJwksProvider(config.auth.jwksUrl)
            else -> JwksProvider { config.auth.jwks }
        }
        httpStub.registerRequestInterceptor(
            PotemkinRequestInterceptor(config.auth, JwtVerifier(config.auth, jwksProvider)),
        )
        httpStub.registerResponseInterceptor(PotemkinResponseInterceptor(deprecationPolicy))

        // Apply workflow/governance merge logging + register seed expectations.
        applyForwardBlocks(config, specmaticConfig, bridge, httpStub)
        log.info(
            "Potemkin StatefulRequestHandler registered — routes discovered via {}/_engine/routes, control server on port {}",
            config.backendUrl,
            config.controlPort,
        )
    }

    /**
     * Forward-block application map — where each block actually takes effect.
     *
     * | block      | applied where                          | mechanism                                  |
     * |------------|----------------------------------------|--------------------------------------------|
     * | seeds      | here, at `initialize`                  | [SeedApplier] -> `httpStub.setExpectation` |
     * | overlay    | Specmatic, at `HttpStub` construction  | overlay FILE via `overlayFilePath` env var |
     * | workflow   | plugin forward path, per request       | [WorkflowPropagator] (id-propagation)      |
     * | governance | here, merged + logged only             | [SpecmaticConfigMerger] (diagnostics)      |
     *
     * This method only handles the blocks that are realised at boot: it registers
     * seed expectations and merges+logs workflow/governance for diagnostics. It
     * does NOT apply the overlay — that is done out-of-process (see below).
     *
     * ## Specmatic 2.46.2 limitations that force the file-based design
     * (verified against specmatic-2.46.2.jar by decompilation + a boot experiment)
     *
     * Seeds: `HttpStub.setExpectation(ScenarioStub)` IS a public runtime API,
     * so seeds are applied directly here.
     *
     * Overlay: `SpecmaticConfig` exposes NO runtime overlay setter. The overlay
     * is read once at HttpStub CONSTRUCTION via `SpecmaticConfig.getStubOverlayFilePath`,
     * which reads `System.getenv("overlayFilePath")` (system-property fallback) —
     * confirmed by booting `stub` with that env var and observing the overlay applied
     * to the served spec. Because construction precedes this `initialize`, the plugin
     * cannot re-seat an overlaid spec into the already-loaded features. The launcher
     * therefore translates `overlay.patches` to a Specmatic overlay file (the unit
     * proven by [OverlayApplier.applyTo]) and sets the env var before Specmatic starts.
     * Specmatic emits no `Deprecation` header for `deprecated:true` operations, so
     * [DeprecationPolicy] + [PotemkinResponseInterceptor] add it on the response path.
     *
     * Workflow: `SpecmaticConfig` exposes no runtime workflow setter either, and
     * `io.specmatic.core.Workflow` is referenced ONLY by `Feature.scenarioAsTest` /
     * `generateContractTests` (TEST-mode contract-test chaining); `getWorkflowDetails()`
     * resolves from the *test* service config and stub mode never consults it. Workflow
     * id-propagation is therefore implemented in the plugin forward path via
     * [WorkflowPropagator]; the merge below is for diagnostics only.
     */
    private fun applyForwardBlocks(
        config: PluginConfig,
        specmaticConfig: SpecmaticConfig,
        bridge: SpecmaticStubBridge,
        httpStub: HttpStub,
    ) {
        val blocks = config.forwardBlocks

        // Workflow + governance merged for diagnostics only. The live
        // id-propagation runs in WorkflowPropagator (stub mode never reads
        // Specmatic's test-mode workflow); governance is not enforced by Specmatic
        // in stub mode, so we only record what was requested.
        val merger = SpecmaticConfigMerger()
        if (blocks.workflow.ids.isNotEmpty()) {
            val existing = (specmaticConfig.getWorkflowDetails() as? WorkflowConfiguration)?.ids ?: emptyMap()
            val mergedWorkflow = merger.mergeWorkflow(existing, blocks.workflow)
            log.info("Forward-blocks: merged {} workflow id-operation(s) for diagnostics (live propagation via WorkflowPropagator)", mergedWorkflow.ids.size)
        }
        if (blocks.governance.report != null || blocks.governance.successCriterion != null) {
            val mergedGovernance = merger.mergeGovernance(emptyMap(), blocks.governance)
            log.info("Forward-blocks: merged governance keys {} for diagnostics", mergedGovernance.keys)
        }

        // Overlay is applied by Specmatic from the launcher-written file
        // (overlayFilePath); nothing to do here. Translation/merge is exercised by
        // OverlayApplier's tests, not at boot.

        // Seeds are applied directly via the public setExpectation API.
        // `base: contract` seeds need the contract-generated body for their target,
        // so we wire a resolver backed by the loaded Specmatic features.
        if (blocks.seeds.isNotEmpty()) {
            val resolver = SpecmaticContractBaseResolver(httpStub)
            SeedApplier(bridge, resolver::resolve).applyAll(blocks.seeds)
        }
    }
}

/**
 * Resolves the `contract`-base body for a seed by asking the loaded Specmatic
 * features for the body they would generate for the seed's target request.
 *
 * For each seed `{ method, path }` it builds a bare [HttpRequest] and calls
 * [Feature.stubResponse], which performs Specmatic's own request→scenario
 * matching (including path-template matching, e.g. `/loans/L-1` →
 * `/loans/(id:string)`) and returns a [io.specmatic.core.ResponseBuilder] for the
 * best-matching scenario. Building it generates the contract example/response body,
 * which is parsed back into a `Map<String, Any?>` for [PatchApplier].
 *
 * The loaded features are read from [HttpStub] via reflection: Specmatic 2.46.2
 * keeps them in the private `features: List<Feature>` field and exposes no public
 * accessor at runtime (verified by decompiling specmatic-2.46.2.jar).
 *
 * Fail-loud contract: if no feature can generate a body for the target — no
 * matching scenario, a non-JSON-object body, or the features field is
 * inaccessible — [resolve] throws [IllegalStateException]. A `base: contract` seed
 * that silently compiled from `{}` would drop every contract-derived field, so we
 * refuse rather than ship an empty body.
 */
class SpecmaticContractBaseResolver(private val httpStub: HttpStub) {

    private val log = LoggerFactory.getLogger(SpecmaticContractBaseResolver::class.java)
    private val mapper = jacksonObjectMapper()

    @Suppress("UNCHECKED_CAST")
    private val features: List<Feature> by lazy {
        val field = httpStub.javaClass.getDeclaredField("features")
        field.isAccessible = true
        (field.get(httpStub) as? List<Feature>)
            ?: throw IllegalStateException(
                "SpecmaticContractBaseResolver: HttpStub.features was null — cannot resolve contract bodies.",
            )
    }

    /** Resolver entry point passed to [SeedApplier]. */
    @Suppress("UNCHECKED_CAST")
    fun resolve(request: SeedRequestMatcher): Map<String, Any?> {
        val specRequest = HttpRequest(method = request.method.uppercase(), path = request.path)
        for (feature in features) {
            val (builder, results) = feature.stubResponse(specRequest)
            if (!results.success() || builder == null) continue
            val response = try {
                builder.build(RequestContext(specRequest))
            } catch (e: Exception) {
                log.debug(
                    "SpecmaticContractBaseResolver: {} {} matched a scenario but body generation failed: {}",
                    request.method, request.path, e.message,
                )
                continue
            } ?: continue
            val body = response.body
            if (body is JSONObjectValue) {
                return mapper.readValue(body.toStringLiteral(), Map::class.java) as Map<String, Any?>
            }
            throw IllegalStateException(
                "SpecmaticContractBaseResolver: seed ${request.method} ${request.path} base: contract " +
                    "resolved to a non-object body (${body::class.java.simpleName}); only JSON objects are supported.",
            )
        }
        throw IllegalStateException(
            "SpecmaticContractBaseResolver: no loaded contract scenario matches seed ${request.method} " +
                "${request.path} — cannot produce a contract body for base: contract.",
        )
    }
}
