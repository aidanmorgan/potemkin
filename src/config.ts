import type { Patch } from "./model/patches.js";
import { ConfigurationError } from "./errors.js";

/** TypeScript-native top-level configuration for a Potemkin runtime. */
export interface ScanEntry {
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
}

export interface ScanConfig {
  readonly scan: readonly ScanEntry[];
  /** Polling interval for configuration/source changes; defaults to 10 seconds. */
  readonly watchIntervalMs?: number;
}

export interface PluginEngineConfig {
  readonly url?: string;
  readonly timeoutMs?: number;
}

export interface PluginResilienceConfig {
  readonly maxRetries?: number;
  readonly backoffMs?: number;
}

export interface PluginHealthProbeConfig {
  readonly initialMs?: number;
  readonly stableMs?: number;
  readonly path?: string;
}

export interface PluginDiscoveryConfig {
  readonly refreshOnFailureMs?: number;
  readonly ttlSeconds?: number;
}

export interface PluginCircuitBreakerConfig {
  readonly failureRate?: number;
  readonly waitMs?: number;
}

export interface PluginJwk {
  readonly kty: string;
  readonly kid?: string;
  readonly n: string;
  readonly e: string;
}

export interface PluginAuthConfig {
  readonly mode?: "none" | "jwt";
  readonly algorithm?: "HS256" | "RS256";
  readonly secret?: string;
  readonly jwks?: readonly PluginJwk[];
  readonly jwksUrl?: string;
  readonly realm?: string;
}

export interface PluginConfiguration {
  readonly engine?: PluginEngineConfig;
  readonly controlPort?: number;
  readonly resilience?: PluginResilienceConfig;
  readonly healthProbe?: PluginHealthProbeConfig;
  readonly discovery?: PluginDiscoveryConfig;
  readonly circuitBreaker?: PluginCircuitBreakerConfig;
  readonly auth?: PluginAuthConfig;
}

export interface SeedDefinition {
  readonly description?: string;
  readonly request: { readonly method: string; readonly path: string };
  readonly base: "contract" | "empty";
  readonly patches?: readonly Patch[];
}

export interface WorkflowDefinition {
  readonly ids?: Readonly<Record<string, { readonly extract: string; readonly use: string }>>;
}

export interface OverlayDefinition {
  readonly patches: readonly Patch[];
}

export interface GovernanceDefinition {
  readonly report?: GovernanceReportConfig;
  readonly successCriterion?: string;
}

export interface GovernanceReportConfig {
  readonly format?: "junit" | "json" | "text" | string;
  readonly successCriteria?: GovernanceSuccessCriteria;
}

export interface GovernanceSuccessCriteria {
  readonly minCoverage?: number;
  readonly excludedEndpoints?: readonly string[];
}

export interface PotemkinConfiguration {
  readonly version: number;
  readonly specmatic: string;
  readonly modules: readonly string[];
  /** OpenAPI documents/globs used to build the composite contract. */
  readonly openapi?: readonly string[];
  readonly typescript?: ScanConfig;
  readonly plugin?: PluginConfiguration;
  readonly seeds?: readonly SeedDefinition[];
  readonly workflow?: WorkflowDefinition;
  readonly overlay?: OverlayDefinition;
  readonly governance?: GovernanceDefinition;
}

export interface EngineConfigurationResponse {
  readonly engine: "potemkin-stateful";
  readonly version: string;
  readonly potemkin: PotemkinConfiguration;
  readonly pluginMetadata?: PluginConfiguration;
}

export function definePotemkinConfig(config: PotemkinConfiguration): PotemkinConfiguration {
  if (config === null || typeof config !== "object")
    throw new ConfigurationError("configuration must be an object", { field: "configuration" });
  if (!Number.isInteger(config.version) || config.version < 1)
    throw new ConfigurationError("version must be a positive integer", { field: "version" });
  if (typeof config.specmatic !== "string" || config.specmatic.length === 0)
    throw new ConfigurationError("specmatic must be a non-empty string", { field: "specmatic" });
  if (
    !Array.isArray(config.modules) ||
    config.modules.length === 0 ||
    config.modules.some((module) => typeof module !== "string" || module.length === 0)
  )
    throw new ConfigurationError("modules must be a non-empty array of paths", {
      field: "modules",
    });
  return deepFreeze(config);
}

export function definePluginConfig(config: PluginConfiguration): PluginConfiguration {
  return deepFreeze(config);
}

export function defineWorkflowConfig(config: WorkflowDefinition): WorkflowDefinition {
  return deepFreeze(config);
}

export function defineOverlayConfig(config: OverlayDefinition): OverlayDefinition {
  if (config === null || typeof config !== "object")
    throw new ConfigurationError("overlay must be an object", { field: "overlay" });
  if (!Array.isArray(config.patches))
    throw new ConfigurationError("overlay.patches must be an array", { field: "overlay.patches" });
  return deepFreeze(config);
}

export function defineGovernanceConfig(config: GovernanceDefinition): GovernanceDefinition {
  return deepFreeze(config);
}

export function defineSeedConfig(config: SeedDefinition): SeedDefinition {
  if (
    config === null ||
    typeof config !== "object" ||
    !config.request ||
    typeof config.request.method !== "string" ||
    typeof config.request.path !== "string"
  )
    throw new ConfigurationError("seed.request must contain method and path", {
      field: "seed.request",
    });
  return deepFreeze(config);
}

export function toEngineConfigurationResponse(
  version: string,
  configuration: PotemkinConfiguration,
): EngineConfigurationResponse {
  return deepFreeze({
    engine: "potemkin-stateful" as const,
    version,
    potemkin: configuration,
    ...(configuration.plugin === undefined ? {} : { pluginMetadata: configuration.plugin }),
  });
}

function deepFreeze<T>(value: T): T {
  const copy = structuredClone(value);
  const visit = (entry: unknown): void => {
    if (entry === null || typeof entry !== "object" || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry as Record<string, unknown>)) visit(child);
    Object.freeze(entry);
  };
  visit(copy);
  return copy;
}
