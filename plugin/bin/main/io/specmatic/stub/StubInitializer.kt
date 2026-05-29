package io.specmatic.stub

import io.specmatic.core.SpecmaticConfig

/**
 * SPI interface for Specmatic stub plugins loaded via [java.util.ServiceLoader].
 *
 * NOTE: This interface was removed from `specmatic-core` at some point and is defined
 * locally here so that [com.potemkin.specmatic.PluginInitializer] continues to compile.
 * If Specmatic re-adds this interface, remove this file and rely on the upstream definition.
 *
 * The file `src/main/resources/META-INF/services/io.specmatic.stub.StubInitializer` points
 * to `com.potemkin.specmatic.PluginInitializer` so Specmatic can discover the plugin at
 * runtime via ServiceLoader — as long as Specmatic's runtime also calls ServiceLoader for
 * this interface.
 */
interface StubInitializer {
    fun initialize(specmaticConfig: SpecmaticConfig, httpStub: HttpStub)
}
