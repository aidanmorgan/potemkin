import * as path from "node:path";

import type { OpenApiDoc } from "../contract/loader.js";
import type { SimulationDefinition } from "../authoring/runtimeModel.js";
import { scanTypeScriptFactories } from "./typescriptFactoryScanner.js";
import { sdk } from "../sdk/index.js";
import type { LoadedConfig } from "./configLoader.js";
import { loadTypeScriptConfiguration } from "./typescriptLoader.js";

export interface ConfiguredTypeScriptSources {
  readonly files: readonly string[] | undefined;
  readonly typescriptDependencyFiles: readonly string[] | undefined;
  readonly authoring: SimulationDefinition | undefined;
}

/**
 * Load only the TypeScript side of a configured runtime. YAML parsing and
 * OpenAPI composition remain in configuredYaml.ts.
 */
export async function loadConfiguredTypeScriptSources(
  loaded: LoadedConfig,
  openapi: OpenApiDoc,
): Promise<ConfiguredTypeScriptSources> {
  if (loaded.typescript === undefined) {
    return { files: undefined, typescriptDependencyFiles: undefined, authoring: undefined };
  }

  const cwd = path.dirname(loaded.potemkinConfigPath);
  const scanned = await scanTypeScriptFactories(loaded.typescript, cwd, { sdk });
  const authoring = await loadTypeScriptConfiguration(
    loaded.typescript,
    cwd,
    {
      openapi,
      configuration: loaded.configuration,
      sourceFiles: [],
    },
    { factories: scanned.factories, sdk },
  );
  return {
    files: scanned.files,
    typescriptDependencyFiles: scanned.loadedFiles,
    authoring: authoring.definition,
  };
}
