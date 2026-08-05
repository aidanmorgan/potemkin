/**
 * Project Compilation context.
 *
 * This module owns the transition from files and source adapters to one
 * source-neutral runtime definition. YAML parsing and TypeScript loading are
 * inbound adapters; neither format is visible after `compileProject`.
 */

import type { OpenApiDoc } from '../contract/loader.js';
import type { RuntimeDependencies } from '../model/runtime.js';
import type { RuntimeModel } from '../model/index.js';
import { compileMixedProgram } from '../parser/mixed.js';
import { compileYamlProgram } from '../parser/public.js';
import type { YamlCompilationObservability } from '../parser/yamlParser.js';
import { loadConfiguredTypeScriptSources } from '../parser/configuredTypeScript.js';
import { loadConfiguredYamlSources } from '../parser/configuredYaml.js';
import type { ConfiguredRuntimeSources } from '../parser/configuredTypes.js';
import type { OpenApiLoadObservability } from '../contract/loader.js';

export interface ProjectCompilationContext {
  readonly openapi: OpenApiDoc;
  readonly dependencies: RuntimeDependencies;
}

export async function loadProjectSources(
  configPath: string,
  openapi: OpenApiDoc,
  observability: OpenApiLoadObservability & YamlCompilationObservability = {},
): Promise<ConfiguredRuntimeSources> {
  const yaml = await loadConfiguredYamlSources(configPath, openapi, observability);
  const typescript = await loadConfiguredTypeScriptSources(yaml.loaded, yaml.openapi);
  return { ...yaml, ...typescript };
}

export async function compileProject(
  sources: ConfiguredRuntimeSources,
  context: ProjectCompilationContext,
  observability: YamlCompilationObservability = {},
): Promise<RuntimeModel> {
  if (sources.authoring !== undefined) {
    return compileMixedProgram(
      { yaml: sources.loaded.yamlProgram, direct: sources.authoring },
      context,
    );
  }
  return compileYamlProgram(sources.loaded.yamlProgram, {
    dependencies: context.dependencies,
    observability,
  });
}
