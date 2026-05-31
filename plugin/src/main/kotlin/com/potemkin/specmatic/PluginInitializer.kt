package com.potemkin.specmatic

import com.potemkin.specmatic.control.ControlServer
import com.potemkin.specmatic.control.ControlServerConfig
import com.potemkin.specmatic.reliability.FixtureLifecycleManager
import com.potemkin.specmatic.reliability.HealthMonitor
import com.potemkin.specmatic.reliability.HealthProbeConfig
import com.potemkin.specmatic.reliability.ResilienceConfig
import com.potemkin.specmatic.reliability.ResilientForwarder
import io.specmatic.core.SpecmaticConfig
import io.specmatic.core.WorkflowConfiguration
import io.specmatic.stub.HttpStub
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

        // Forward-blocks → live components. The overlay file itself is loaded by
        // Specmatic at HttpStub construction (the `overlayFilePath` env var the
        // launcher sets); here the plugin derives the runtime behaviours that ride
        // on top of the overlaid spec:
        //  - E5: a [DeprecationPolicy] so deprecated operations carry `Deprecation:true`.
        //  - E6: a [WorkflowPropagator] that chains ids across the forward path.
        val blocks = config.forwardBlocks
        val deprecationPolicy = DeprecationPolicy.fromOverlayPatches(blocks.overlay.patches)
        val workflowPropagator = WorkflowPropagator(blocks.workflow)

        val handler = StatefulRequestHandler(
            discovery, backendClient, fixturesClient, resilient, workflowPropagator,
        )
        httpStub.registerHandler(handler)
        httpStub.registerRequestInterceptor(
            PotemkinRequestInterceptor(config.auth, JwtVerifier(config.auth)),
        )
        httpStub.registerResponseInterceptor(PotemkinResponseInterceptor(deprecationPolicy))

        // Apply workflow/governance merge logging + register seed expectations.
        applyForwardBlocks(config, specmaticConfig, bridge)
        log.info(
            "Potemkin StatefulRequestHandler registered — routes discovered via {}/_engine/routes, control server on port {}",
            config.backendUrl,
            config.controlPort,
        )
    }

    /**
     * Apply the parsed forward-blocks at boot:
     *  - E6: merge `workflow.ids` + `governance` (precedence via [SpecmaticConfigMerger])
     *    for logging/diagnostics; the live id-propagation runs in [WorkflowPropagator].
     *  - E5: the overlay-merged spec is produced for parity logging; the live overlay is
     *    loaded by Specmatic from the file the launcher points `overlayFilePath` at.
     *  - E4: compile `seeds` and register them via `httpStub.setExpectation`.
     *
     * ## Specmatic 2.46.2 wiring (verified against specmatic-2.46.2.jar + experiment)
     *
     * E4 (seeds): `HttpStub.setExpectation(ScenarioStub)` is the public runtime API.
     *
     * E5 (overlay): loaded at HttpStub CONSTRUCTION via `SpecmaticConfig.getStubOverlayFilePath`,
     * which reads `System.getenv("overlayFilePath")` (fallback system property) — confirmed by
     * booting `stub` with that env var and observing the overlay applied to the served spec. The
     * launcher therefore translates `overlay.patches` to a Specmatic overlay file and sets the env
     * var before Specmatic starts. Specmatic emits no `Deprecation` header for `deprecated:true`
     * operations, so [DeprecationPolicy] + [PotemkinResponseInterceptor] add it.
     *
     * E6 (workflow): `io.specmatic.core.Workflow` is referenced ONLY by `Feature.scenarioAsTest`
     * / `generateContractTests` (TEST-mode contract-test chaining); `getWorkflowDetails()` resolves
     * from the *test* service config. Stub mode never consults it. Workflow id-propagation is
     * therefore implemented in the plugin forward path via [WorkflowPropagator].
     */
    private fun applyForwardBlocks(
        config: PluginConfig,
        specmaticConfig: SpecmaticConfig,
        bridge: SpecmaticStubBridge,
    ) {
        val blocks = config.forwardBlocks

        // E6 — workflow + governance merge.
        val merger = SpecmaticConfigMerger()
        if (blocks.workflow.ids.isNotEmpty()) {
            val existing = (specmaticConfig.getWorkflowDetails() as? WorkflowConfiguration)?.ids ?: emptyMap()
            val mergedWorkflow = merger.mergeWorkflow(existing, blocks.workflow)
            log.info("Forward-blocks: merged {} workflow id-operation(s)", mergedWorkflow.ids.size)
        }
        if (blocks.governance.report != null || blocks.governance.successCriterion != null) {
            val mergedGovernance = merger.mergeGovernance(emptyMap(), blocks.governance)
            log.info("Forward-blocks: merged governance keys {}", mergedGovernance.keys)
        }

        // E5 — overlay translation (the merged spec is the e2e seam).
        if (blocks.overlay.patches.isNotEmpty()) {
            runCatching { OverlayApplier().toOverlay(blocks.overlay.patches) }
                .onSuccess { log.info("Forward-blocks: translated {} overlay patch(es)", blocks.overlay.patches.size) }
                .onFailure { log.warn("Forward-blocks: overlay translation failed: {}", it.message) }
        }

        // E4 — seeds.
        if (blocks.seeds.isNotEmpty()) {
            SeedApplier(bridge).applyAll(blocks.seeds)
        }
    }
}
