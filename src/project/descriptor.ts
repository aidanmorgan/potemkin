/**
 * Source-neutral project metadata shared by generation and editor tooling.
 *
 * File loaders and unsaved editor overlays are inbound concerns. Once this
 * descriptor has been built, consumers only see the contract, validated
 * configuration, and merged scenario symbols; they do not each rediscover
 * the project graph independently.
 */

import type { OpenApiDoc, OpenApiLoadObservability } from '../contract/loader.js';
import { loadConfiguredOpenApi } from '../parser/configuredOpenApi.js';
import { loadPotemkinConfig, type LoadedConfig } from '../parser/configLoader.js';
import { collectScenarioModel, type ScenarioModel } from '../openapi/scenarioModel.js';

export interface ProjectDescriptorOptions {
  readonly configPath: string;
  /** Use a preloaded contract when a host already owns contract discovery. */
  readonly openapi?: OpenApiDoc;
  /** Unsaved potemkin.yml content supplied by an editor host. */
  readonly configText?: string;
  /** Unsaved source text keyed by absolute file path. */
  readonly documents?: ReadonlyMap<string, string>;
  readonly observability?: OpenApiLoadObservability;
}

export interface ProjectDescriptor {
  readonly openapi: OpenApiDoc;
  readonly loaded: LoadedConfig;
  readonly scenario: ScenarioModel;
}

export async function loadProjectDescriptor(
  options: ProjectDescriptorOptions,
): Promise<ProjectDescriptor> {
  const openapi = await loadConfiguredOpenApi(
    options.configPath,
    options.openapi,
    options.observability,
    options.configText,
  );
  const loaded = await loadPotemkinConfig(options.configPath, {
    openapi,
    ...(options.configText === undefined ? {} : { configText: options.configText }),
  });
  const scenario = await collectScenarioModel(openapi, loaded, {
    documents: options.documents,
  });
  return { openapi, loaded, scenario };
}
