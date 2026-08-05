import type { Patch } from './value.js';

/** Canonical project configuration contracts, independent of its parser. */
export interface ScanEntry {
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
}

export interface ScanConfig {
  readonly scan: readonly ScanEntry[];
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
  readonly mode?: 'none' | 'jwt';
  readonly algorithm?: 'HS256' | 'RS256';
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
  readonly base: 'contract' | 'empty';
  readonly patches?: readonly Patch[];
}

export interface WorkflowDefinition {
  readonly ids?: Record<string, { extract: string; use: string }>;
}

export interface OverlayDefinition {
  readonly patches: readonly Patch[];
}

export interface GovernanceDefinition {
  readonly report?: GovernanceReportConfig;
  readonly successCriterion?: string;
}

export interface GovernanceReportConfig {
  readonly format?: 'junit' | 'json' | 'text' | string;
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
  readonly openapi?: readonly string[];
  readonly typescript?: ScanConfig;
  readonly plugin?: PluginConfiguration;
  readonly seeds?: readonly SeedDefinition[];
  readonly workflow?: WorkflowDefinition;
  readonly overlay?: OverlayDefinition;
  readonly governance?: GovernanceDefinition;
}

export interface EngineConfigurationResponse {
  readonly engine: 'potemkin-stateful';
  readonly version: string;
  readonly potemkin: PotemkinConfiguration;
  readonly pluginMetadata?: PluginConfiguration;
}
