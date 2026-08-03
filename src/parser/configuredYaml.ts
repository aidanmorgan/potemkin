import type { OpenApiDoc, OpenApiLoadObservability } from "../contract/loader.js";
import type { LoadedConfig } from "./configLoader.js";
import { loadPotemkinConfig } from "./configLoader.js";
import { loadConfiguredOpenApi } from "./configuredOpenApi.js";

/** YAML-side sources selected by the single potemkin configuration file. */
export interface ConfiguredYamlSources {
  readonly loaded: LoadedConfig;
  readonly openapi: OpenApiDoc;
}

/** Load the YAML modules, OpenAPI globs, and typed potemkin configuration. */
export async function loadConfiguredYamlSources(
  potemkinConfigPath: string,
  openapi: OpenApiDoc,
  observability: OpenApiLoadObservability = {},
): Promise<ConfiguredYamlSources> {
  const resolvedOpenapi = await loadConfiguredOpenApi(potemkinConfigPath, openapi, observability);
  const loaded = await loadPotemkinConfig(potemkinConfigPath, { openapi: resolvedOpenapi });
  return { loaded, openapi: resolvedOpenapi };
}
