/**
 * Configuration-driven Potemkin runtime boot.
 *
 * This is the single orchestration point for a potemkin.yml boot: YAML
 * modules, scanned TypeScript extensions, and annotated TypeScript
 * factories are compiled into one RuntimeProgram. The runtime and HTTP
 * gateway remain independent of the authoring source.
 */

import type { OpenApiDoc } from "../contract/loader.js";
import type { RuntimeModel } from "../model/index.js";
import type {
  RuntimeCompilationContext,
  RuntimeSystem,
  RuntimeBootInput,
} from "../runtime/system.js";
import { bootRuntime } from "../runtime/system.js";
import { compileMixedProgram } from "./mixed.js";
import { compileYamlProgram } from "./public.js";
import type { YamlCompilerOptions } from "./public.js";
import {
  startConfiguredRuntimeWatcher,
  type ConfiguredRuntimeWatcher,
} from "./configuredWatcher.js";
import { loadConfiguredTypeScriptSources } from "./configuredTypeScript.js";
import { loadConfiguredYamlSources } from "./configuredYaml.js";
import type { ConfiguredRuntimeSources } from "./configuredTypes.js";
import type { OpenApiLoadObservability } from "../contract/loader.js";
import type { YamlCompilationObservability } from "./yamlParser.js";
import { buildConfiguredTransitionModel } from "./transitionModel.js";

export interface ConfiguredRuntimeBootInput extends Omit<
  RuntimeBootInput,
  "program" | "programFactory"
> {
  readonly potemkinConfigPath: string;
  readonly onConfigurationError?: (error: unknown) => void;
  /** Host-owned diagnostics used while loading and compiling authoring sources. */
  readonly authoringObservability?: OpenApiLoadObservability & YamlCompilationObservability;
}

export async function loadConfiguredRuntimeSources(
  potemkinConfigPath: string,
  openapi: OpenApiDoc,
  authoringObservability: OpenApiLoadObservability & YamlCompilationObservability = {},
): Promise<ConfiguredRuntimeSources> {
  const yaml = await loadConfiguredYamlSources(potemkinConfigPath, openapi, authoringObservability);
  const typescript = await loadConfiguredTypeScriptSources(yaml.loaded, yaml.openapi);
  return { ...yaml, ...typescript };
}

export async function compileConfiguredProgram(
  sources: ConfiguredRuntimeSources,
  context: RuntimeCompilationContext,
  authoringObservability: YamlCompilationObservability = {},
): Promise<RuntimeModel> {
  const yaml = sources.loaded.yamlProgram;
  if (sources.authoring !== undefined) {
    return compileMixedProgram(
      { yaml, direct: sources.authoring },
      { ...context, openapi: context.openapi },
    );
  }
  return compileYamlProgram(yaml, {
    dependencies: context.dependencies,
    observability: authoringObservability,
  } satisfies YamlCompilerOptions);
}

export async function bootConfiguredRuntimeFromConfig(
  input: ConfiguredRuntimeBootInput,
): Promise<RuntimeSystem> {
  const sources = await loadConfiguredRuntimeSources(
    input.potemkinConfigPath,
    input.openapi,
    input.authoringObservability,
  );
  const transitionModel = await buildConfiguredTransitionModel(
    sources.loaded.yamlProgram,
    sources.openapi,
    sources.authoring,
  );
  const system = await bootRuntime({
    ...input,
    openapi: sources.openapi,
    configuration: input.configuration ?? sources.loaded.configuration,
    sourceByBoundary: sources.loaded.boundarySourcePaths,
    transitionModel,
    programFactory: (context) =>
      compileConfiguredProgram(sources, context, input.authoringObservability),
  });

  const watcher = await startConfiguredRuntimeWatcher({
    configPath: sources.loaded.potemkinConfigPath,
    openapi: input.openapi,
    system,
    initialSources: sources,
    compile: (nextSources, context) =>
      compileConfiguredProgram(nextSources, context, input.authoringObservability),
    model: (nextSources) =>
      buildConfiguredTransitionModel(
        nextSources.loaded.yamlProgram,
        nextSources.openapi,
        nextSources.authoring,
      ),
    onError: input.onConfigurationError,
    authoringObservability: input.authoringObservability,
  });
  system.reloadConfiguration = watcher.reload;
  system.addDisposeHook(() => watcher.stop());
  return system;
}

// Expose the watcher contract for hosts that coordinate its lifecycle explicitly.
export type { ConfiguredRuntimeWatcher };
