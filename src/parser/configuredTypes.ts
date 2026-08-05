import type { OpenApiDoc } from '../contract/loader.js';
import type { SimulationDefinition } from '../authoring/types.js';
import type { LoadedConfig } from './configLoader.js';

export interface ConfiguredRuntimeSources {
  readonly loaded: LoadedConfig;
  readonly openapi: OpenApiDoc;
  readonly files: readonly string[] | undefined;
  /** TypeScript modules evaluated while discovering configured factories. */
  readonly typescriptDependencyFiles: readonly string[] | undefined;
  readonly authoring: SimulationDefinition | undefined;
}
