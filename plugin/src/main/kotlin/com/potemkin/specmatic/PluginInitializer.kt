package com.potemkin.specmatic

import io.specmatic.core.SpecmaticConfig
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
 */
class PluginInitializer : StubInitializer {

    private val log = LoggerFactory.getLogger(PluginInitializer::class.java)

    override fun initialize(specmaticConfig: SpecmaticConfig, httpStub: HttpStub) {
        log.info("Potemkin plugin initialising…")
        val config = PluginConfig.load()
        log.info(
            "Potemkin plugin config: backendUrl={}, forwardTimeoutMs={}, discoveryRefreshOnFailureMs={}",
            config.backendUrl,
            config.forwardTimeoutMs,
            config.discoveryRefreshOnFailureMs,
        )
        val client = CqrsBackendClient(config.backendUrl, config.forwardTimeoutMs)
        val discovery = RoutesDiscoveryClient(config.backendUrl, config.discoveryRefreshOnFailureMs)
        val handler = StatefulRequestHandler(discovery, client)
        httpStub.registerHandler(handler)
        log.info(
            "Potemkin StatefulRequestHandler registered — routes discovered via {}/_engine/routes",
            config.backendUrl,
        )
    }
}
