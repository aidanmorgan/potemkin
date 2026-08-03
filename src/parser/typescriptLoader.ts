/**
 * Loads trusted TypeScript configuration modules selected by potemkin.yml.
 *
 * Scanned files are evaluated for the canonical @PotemkinConfigure annotation.
 * Each annotation marks a static factory method; the resulting definitions are
 * composed before the source-independent compiler sees them. Files without an
 * annotation are dependency modules and are loaded only when imported.
 */

import { FactoryCollector } from "../authoring/factory.js";
import type { RegisteredFactory } from "../authoring/factory.js";
import {
  createDefaultTypeScriptDiscoveryDependencies,
  isDecoratedTypeScriptModule,
  resolveTypeScriptScanFiles,
} from "./typescriptDiscovery.js";
import type { TypeScriptDiscoveryDependencies } from "./typescriptDiscovery.js";
import type { OpenApiDoc } from "../contract/loader.js";
import type { PotemkinConfiguration, ScanConfig } from "../config.js";
import type { SimulationDefinition } from "../authoring/runtimeModel.js";
import type { RuntimePolicies } from "../model/runtime.js";
import { mergeRuntimePolicies } from "../core/policyMerge.js";
import { createTypeScriptSdk, sdk, type TypeScriptSdk } from "../sdk/index.js";
import {
  errorMessage,
  isTypeScriptAuthoringError,
  TypeScriptAuthoringError,
} from "../authoring/errors.js";
import { TypeScriptModuleLoader } from "./typescriptModuleLoader.js";
import type { TypeScriptModuleLoaderDependencies } from "./typescriptModuleLoader.js";

export interface TypeScriptLoaderContext {
  readonly openapi: OpenApiDoc;
  readonly configuration: PotemkinConfiguration;
  readonly sourceFiles: readonly string[];
}

export interface TypeScriptLoadResult {
  readonly files: readonly string[];
  readonly definition: SimulationDefinition | undefined;
}

export interface TypeScriptLoaderOptions {
  /**
   * Factories discovered by the canonical TypeScript scan. When supplied,
   * factory modules are not evaluated a second time by this authoring loader.
   */
  readonly factories?: readonly RegisteredFactory[];
  readonly sdk?: TypeScriptSdk;
  readonly discovery?: TypeScriptDiscoveryDependencies;
  readonly loader?: TypeScriptModuleLoaderDependencies;
}

export async function loadTypeScriptConfiguration(
  config: ScanConfig,
  cwd: string,
  context: TypeScriptLoaderContext,
  options: TypeScriptLoaderOptions = {},
): Promise<TypeScriptLoadResult> {
  const collector = new FactoryCollector();
  const configuredSdk = createTypeScriptSdk(collector, options.sdk ?? sdk);
  const discovery = options.discovery ?? createDefaultTypeScriptDiscoveryDependencies();
  const files = await resolveTypeScriptScanFiles(config.scan, cwd, discovery);
  const loader = new TypeScriptModuleLoader({
    cwd,
    scan: config.scan,
    sdk: configuredSdk,
    dependencies: options.loader,
  });

  if (options.factories === undefined) {
    for (const file of files) {
      if (isDecoratedTypeScriptModule(file, discovery)) loader.load(file);
    }
  }

  const factoryContext = { ...context, sourceFiles: files };
  const factories = options.factories ?? collector.snapshot();
  const definitions: SimulationDefinition[] = [];
  for (const entry of [...factories].sort(compareFactories)) {
    let definition: SimulationDefinition | undefined;
    try {
      const candidate = await entry.factory(factoryContext);
      definition = normalizeFactoryOutput(candidate, entry.source, entry.name);
    } catch (error) {
      if (isTypeScriptAuthoringError(error)) throw error;
      throw new TypeScriptAuthoringError(
        "TS_EXECUTION",
        `TypeScript factory "${entry.name}" failed: ${errorMessage(error)}`,
        { details: { name: entry.name, source: entry.source }, source: entry.source, cause: error },
      );
    }
    if (definition !== undefined) definitions.push(definition);
  }

  return {
    files,
    definition: definitions.length === 0 ? undefined : mergeDefinitions(definitions),
  };
}

function compareFactories(left: RegisteredFactory, right: RegisteredFactory): number {
  return left.source.localeCompare(right.source) || left.name.localeCompare(right.name);
}

function normalizeFactoryOutput(
  candidate: unknown,
  source: string,
  factoryName: string,
): SimulationDefinition | undefined {
  let value = candidate;
  if (
    value !== null &&
    typeof value === "object" &&
    "build" in value &&
    typeof (value as { build?: unknown }).build === "function"
  ) {
    value = (value as { build: () => unknown }).build();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record["boundaries"]) &&
    !Array.isArray(record["resources"]) &&
    !Array.isArray(record["helpers"]) &&
    !Array.isArray(record["uses"]) &&
    record["policies"] === undefined
  )
    return undefined;
  if (record["boundaries"] !== undefined && !Array.isArray(record["boundaries"])) {
    throw new TypeScriptAuthoringError(
      "TS_DEFINITION_INVALID",
      `${source} factory "${factoryName}" has invalid boundaries; expected an array`,
      { details: { source, factoryName }, source },
    );
  }
  if (record["helpers"] !== undefined && !Array.isArray(record["helpers"])) {
    throw new TypeScriptAuthoringError(
      "TS_DEFINITION_INVALID",
      `${source} factory "${factoryName}" has invalid helpers; expected an array`,
      { details: { source, factoryName }, source },
    );
  }
  return value as SimulationDefinition;
}

function mergeDefinitions(definitions: readonly SimulationDefinition[]): SimulationDefinition {
  const policies = definitions
    .map((definition) => definition.policies)
    .filter((value): value is RuntimePolicies => value !== undefined);
  return {
    boundaries: definitions.flatMap((definition) => definition.boundaries),
    ...(definitions.some((definition) => definition.resources !== undefined)
      ? { resources: definitions.flatMap((definition) => definition.resources ?? []) }
      : {}),
    ...(definitions.some((definition) => definition.uses !== undefined)
      ? { uses: definitions.flatMap((definition) => definition.uses ?? []) }
      : {}),
    ...(definitions.some((definition) => definition.helpers !== undefined)
      ? { helpers: definitions.flatMap((definition) => definition.helpers ?? []) }
      : {}),
    ...(policies.length === 0 ? {} : { policies: mergePolicies(policies) }),
  };
}

function mergePolicies(policies: readonly RuntimePolicies[]): RuntimePolicies {
  return mergeRuntimePolicies(policies);
}
