// YAML schema validators for potemkin.yml and boundary modules.
// Unknown top-level keys in potemkin.yml are rejected with a Levenshtein
// "did you mean?" suggestion; removed snake_case keys throw BOOT_ERR_REMOVED_SYNTAX.

import { BootError } from "../errors.js";
import type { Patch } from "../model/patches.js";

export interface PotemkinScanEntry {
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
}

export interface PotemkinScanConfig {
  readonly scan: readonly PotemkinScanEntry[];
  readonly watchIntervalMs?: number;
}

export interface PotemkinConfigPluginEngine {
  readonly url?: string;
  readonly timeoutMs?: number;
}

export interface PotemkinConfigPluginResilience {
  readonly maxRetries?: number;
  readonly backoffMs?: number;
}

export interface PotemkinConfigPluginHealthProbe {
  readonly initialMs?: number;
  readonly stableMs?: number;
  /** Optional health endpoint metadata carried through to the plugin. */
  readonly path?: string;
}

export interface PotemkinConfigPluginDiscovery {
  readonly refreshOnFailureMs?: number;
  readonly ttlSeconds?: number;
}

export interface PotemkinConfigPluginCircuitBreaker {
  readonly failureRate?: number;
  readonly waitMs?: number;
}

export interface PotemkinConfigPluginJwk {
  readonly kty: string;
  readonly kid?: string;
  readonly n: string;
  readonly e: string;
}

export interface PotemkinConfigPluginAuth {
  readonly mode?: "none" | "jwt";
  readonly algorithm?: "HS256" | "RS256";
  readonly secret?: string;
  readonly jwks?: readonly PotemkinConfigPluginJwk[];
  readonly jwksUrl?: string;
  readonly realm?: string;
}

export interface PotemkinConfigPlugin {
  readonly engine?: PotemkinConfigPluginEngine;
  readonly controlPort?: number;
  readonly resilience?: PotemkinConfigPluginResilience;
  readonly healthProbe?: PotemkinConfigPluginHealthProbe;
  readonly discovery?: PotemkinConfigPluginDiscovery;
  readonly circuitBreaker?: PotemkinConfigPluginCircuitBreaker;
  readonly auth?: PotemkinConfigPluginAuth;
}

export interface PotemkinConfigSeed {
  readonly description?: string;
  readonly request: { readonly method: string; readonly path: string };
  readonly base: "contract" | "empty";
  readonly patches: readonly Patch[];
}

export interface PotemkinConfigWorkflow {
  readonly ids?: Record<string, { extract: string; use: string }>;
}

export interface PotemkinConfigOverlay {
  readonly patches: readonly Patch[];
}

export interface PotemkinConfigGovernance {
  readonly report?: {
    readonly format?: string;
    readonly successCriteria?: {
      readonly minCoverage?: number;
      readonly excludedEndpoints?: readonly string[];
    };
  };
  readonly successCriterion?: string;
}

export interface PotemkinConfig {
  readonly version: number;
  readonly specmatic: string;
  readonly modules: readonly string[];
  readonly openapi?: readonly string[];
  readonly typescript?: PotemkinScanConfig;
  readonly plugin?: PotemkinConfigPlugin;
  readonly seeds?: readonly PotemkinConfigSeed[];
  readonly workflow?: PotemkinConfigWorkflow;
  readonly overlay?: PotemkinConfigOverlay;
  readonly governance?: PotemkinConfigGovernance;
}

export const PLUGIN_SUB_KEYS = [
  "engine",
  "controlPort",
  "resilience",
  "healthProbe",
  "discovery",
  "circuitBreaker",
  "auth",
] as const;

export const POTEMKIN_TOP_LEVEL_KEYS = [
  "version",
  "specmatic",
  "modules",
  "openapi",
  "typescript",
  "plugin",
  "seeds",
  "workflow",
  "overlay",
  "governance",
] as const;

// Renamed snake_case keys; each produces BOOT_ERR_REMOVED_SYNTAX at parse time.
export const REMOVED_KEY_MAP: Record<string, string> = {
  event_catalog: "events",
  payload_template: "template",
  state_schema: "state",
  dispatch_commands: "dispatch",
  contract_path: "contractPath",
  depends_on: "dependsOn",
  out_of_contract: "outOfContract",
  spec_id: "specId",
  seed_expectations: "seeds",
  derived_projections: "derivedProjections",
};

export interface ValidationContext {
  /** Source description for error messages (file path, "potemkin.yml", etc.). */
  readonly source: string;
}

export function validatePotemkinConfig(raw: unknown, ctx: ValidationContext): PotemkinConfig {
  if (!isObject(raw)) {
    throw new BootError("BOOT_ERR_DSL_SCHEMA_VIOLATION", `${ctx.source}: root must be an object`, {
      source: ctx.source,
    });
  }

  rejectSnakeCaseKeys(raw, ctx.source);

  for (const k of Object.keys(raw)) {
    if (!(POTEMKIN_TOP_LEVEL_KEYS as readonly string[]).includes(k)) {
      const suggestion = closestKey(k, POTEMKIN_TOP_LEVEL_KEYS);
      throw new BootError(
        "BOOT_ERR_UNKNOWN_KEY",
        `${ctx.source}: unknown top-level key "${k}"${
          suggestion ? ` — did you mean "${suggestion}"?` : ""
        }`,
        { source: ctx.source, key: k, ...(suggestion ? { suggestion } : {}) },
      );
    }
  }

  if (typeof raw["version"] !== "number") {
    throw new BootError(
      "BOOT_ERR_DSL_SCHEMA_VIOLATION",
      `${ctx.source}: "version" must be a number`,
      { source: ctx.source },
    );
  }
  if (typeof raw["specmatic"] !== "string") {
    throw new BootError(
      "BOOT_ERR_DSL_SCHEMA_VIOLATION",
      `${ctx.source}: "specmatic" must be a string path`,
      { source: ctx.source },
    );
  }
  const modules = raw["modules"];
  if (
    !Array.isArray(modules) ||
    modules.length === 0 ||
    modules.some((m) => typeof m !== "string")
  ) {
    throw new BootError(
      "BOOT_ERR_DSL_SCHEMA_VIOLATION",
      `${ctx.source}: "modules" must be a non-empty array of glob strings`,
      { source: ctx.source },
    );
  }
  const openapi = raw["openapi"];
  if (
    openapi !== undefined &&
    (!Array.isArray(openapi) ||
      openapi.length === 0 ||
      openapi.some((entry) => typeof entry !== "string"))
  ) {
    throw new BootError(
      "BOOT_ERR_DSL_SCHEMA_VIOLATION",
      `${ctx.source}: "openapi" must be a non-empty array of file globs`,
      { source: ctx.source },
    );
  }

  const typescript = assertTypescriptBlock(raw["typescript"], ctx.source);
  const plugin = assertPluginBlock(raw["plugin"], ctx.source);
  const seeds = assertSeedsBlock(raw["seeds"], ctx.source);
  const workflow = assertWorkflowBlock(raw["workflow"], ctx.source);
  const overlay = assertOverlayBlock(raw["overlay"], ctx.source);
  const governance = assertGovernanceBlock(raw["governance"], ctx.source);

  return {
    version: raw["version"] as number,
    specmatic: raw["specmatic"] as string,
    modules: modules as readonly string[],
    ...(openapi === undefined ? {} : { openapi: openapi as readonly string[] }),
    typescript,
    plugin,
    seeds,
    workflow,
    overlay,
    governance,
  };
}

function assertTypescriptBlock(raw: unknown, source: string): PotemkinScanConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    throw new BootError(
      "BOOT_ERR_DSL_SCHEMA_VIOLATION",
      `${source}: "typescript" must be a mapping`,
      { source },
    );
  }
  if (!Array.isArray(raw["scan"]) || (raw["scan"] as unknown[]).length === 0) {
    throw new BootError(
      "BOOT_ERR_DSL_SCHEMA_VIOLATION",
      `${source}: "typescript.scan" must be a non-empty array of { include } entries`,
      { source },
    );
  }
  for (let i = 0; i < (raw["scan"] as unknown[]).length; i++) {
    const entry = (raw["scan"] as unknown[])[i];
    const include = isObject(entry) ? entry["include"] : undefined;
    if (
      !isObject(entry) ||
      !Array.isArray(include) ||
      (include as unknown[]).length === 0 ||
      (include as unknown[]).some((g) => typeof g !== "string")
    ) {
      throw new BootError(
        "BOOT_ERR_DSL_SCHEMA_VIOLATION",
        `${source}: "typescript.scan[${i}].include" must be a non-empty array of glob strings`,
        { source },
      );
    }
    const exclude = isObject(entry) ? entry["exclude"] : undefined;
    if (
      exclude !== undefined &&
      (!Array.isArray(exclude) || (exclude as unknown[]).some((g) => typeof g !== "string"))
    ) {
      throw new BootError(
        "BOOT_ERR_DSL_SCHEMA_VIOLATION",
        `${source}: "typescript.scan[${i}].exclude" must be an array of glob strings`,
        { source },
      );
    }
  }
  if (
    raw["watchIntervalMs"] !== undefined &&
    (typeof raw["watchIntervalMs"] !== "number" ||
      !Number.isFinite(raw["watchIntervalMs"]) ||
      raw["watchIntervalMs"] <= 0)
  ) {
    throw new BootError(
      "BOOT_ERR_DSL_SCHEMA_VIOLATION",
      `${source}: "typescript.watchIntervalMs" must be a finite positive number`,
      { source },
    );
  }
  return raw as unknown as PotemkinScanConfig;
}

function assertPluginBlock(raw: unknown, source: string): PotemkinConfigPlugin | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    throw new BootError("BOOT_ERR_DSL_SCHEMA_VIOLATION", `${source}: "plugin" must be an object`, {
      source,
    });
  }
  for (const k of Object.keys(raw)) {
    if (!(PLUGIN_SUB_KEYS as readonly string[]).includes(k)) {
      const suggestion = closestKey(k, PLUGIN_SUB_KEYS);
      throw new BootError(
        "BOOT_ERR_UNKNOWN_KEY",
        `${source}: unknown plugin key "${k}"${
          suggestion ? ` — did you mean "${suggestion}"?` : ""
        }`,
        { source, key: k, ...(suggestion ? { suggestion } : {}) },
      );
    }
  }
  assertIntegerRange(raw["controlPort"], "plugin.controlPort", source, 0, 65535);
  if (raw["engine"] !== undefined && !isObject(raw["engine"])) {
    throw new BootError(
      "BOOT_ERR_DSL_SCHEMA_VIOLATION",
      `${source}: "plugin.engine" must be an object`,
      { source },
    );
  }
  assertObjectKeys(raw["engine"], ["url", "timeoutMs"], "plugin.engine", source);
  if (isObject(raw["engine"])) {
    assertOptionalString(raw["engine"]["url"], "plugin.engine.url", source);
    assertPositiveNumber(raw["engine"]["timeoutMs"], "plugin.engine.timeoutMs", source);
  }
  assertNumericObject(raw["resilience"], ["maxRetries", "backoffMs"], "plugin.resilience", source);
  assertObjectKeys(
    raw["healthProbe"],
    ["initialMs", "stableMs", "path"],
    "plugin.healthProbe",
    source,
  );
  if (isObject(raw["healthProbe"]))
    assertOptionalString(raw["healthProbe"]["path"], "plugin.healthProbe.path", source);
  assertNumericObject(
    raw["discovery"],
    ["refreshOnFailureMs", "ttlSeconds"],
    "plugin.discovery",
    source,
  );
  assertNumericObject(
    raw["circuitBreaker"],
    ["failureRate", "waitMs"],
    "plugin.circuitBreaker",
    source,
  );
  assertObjectKeys(
    raw["auth"],
    ["mode", "algorithm", "secret", "jwks", "jwksUrl", "realm"],
    "plugin.auth",
    source,
  );
  if (isObject(raw["auth"])) {
    if (
      raw["auth"]["mode"] !== undefined &&
      raw["auth"]["mode"] !== "none" &&
      raw["auth"]["mode"] !== "jwt"
    ) {
      throw schemaViolation(`${source}: "plugin.auth.mode" must be "none" or "jwt"`, source);
    }
    if (
      raw["auth"]["algorithm"] !== undefined &&
      raw["auth"]["algorithm"] !== "HS256" &&
      raw["auth"]["algorithm"] !== "RS256"
    ) {
      throw schemaViolation(
        `${source}: "plugin.auth.algorithm" must be "HS256" or "RS256"`,
        source,
      );
    }
    for (const field of ["secret", "jwksUrl", "realm"]) {
      assertOptionalString(raw["auth"][field], `plugin.auth.${field}`, source);
    }
    if (raw["auth"]["jwks"] !== undefined) {
      const jwks = raw["auth"]["jwks"];
      if (!Array.isArray(jwks))
        throw schemaViolation(`${source}: "plugin.auth.jwks" must be an array`, source);
      for (let i = 0; i < jwks.length; i++) {
        const jwk = jwks[i];
        if (!isObject(jwk))
          throw schemaViolation(`${source}: "plugin.auth.jwks[${i}]" must be an object`, source);
        assertObjectKeys(jwk, ["kty", "kid", "n", "e"], `plugin.auth.jwks[${i}]`, source);
        for (const field of ["kty", "n", "e"]) {
          if (typeof jwk[field] !== "string" || jwk[field].length === 0) {
            throw schemaViolation(
              `${source}: "plugin.auth.jwks[${i}].${field}" must be a non-empty string`,
              source,
            );
          }
        }
        assertOptionalString(jwk["kid"], `plugin.auth.jwks[${i}].kid`, source);
      }
    }
  }
  return raw as PotemkinConfigPlugin;
}

function assertNumericObject(
  raw: unknown,
  keys: readonly string[],
  field: string,
  source: string,
): void {
  if (raw === undefined) return;
  if (!isObject(raw)) throw schemaViolation(`${source}: "${field}" must be an object`, source);
  assertObjectKeys(raw, keys, field, source);
  for (const key of keys) {
    if (
      raw[key] !== undefined &&
      (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || raw[key] < 0)
    ) {
      throw schemaViolation(
        `${source}: "${field}.${key}" must be a finite non-negative number`,
        source,
      );
    }
  }
}

function assertObjectKeys(
  raw: unknown,
  keys: readonly string[],
  field: string,
  source: string,
): void {
  if (raw === undefined || !isObject(raw)) return;
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) {
      const suggestion = closestKey(key, keys);
      throw new BootError(
        "BOOT_ERR_UNKNOWN_KEY",
        `${source}: unknown key "${field}.${key}"${suggestion ? ` — did you mean "${field}.${suggestion}"?` : ""}`,
        { source, key, field: `${field}.${key}`, ...(suggestion ? { suggestion } : {}) },
      );
    }
  }
}

function assertOptionalString(value: unknown, field: string, source: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw schemaViolation(`${source}: "${field}" must be a string`, source);
  }
}

function assertPositiveNumber(value: unknown, field: string, source: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
    throw schemaViolation(`${source}: "${field}" must be a positive number`, source);
  }
}

function assertIntegerRange(
  value: unknown,
  field: string,
  source: string,
  min: number,
  max: number,
): void {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
  ) {
    throw schemaViolation(
      `${source}: "${field}" must be an integer between ${min} and ${max}`,
      source,
    );
  }
}

function schemaViolation(message: string, source: string): BootError {
  return new BootError("BOOT_ERR_DSL_SCHEMA_VIOLATION", message, { source });
}

function assertSeedsBlock(raw: unknown, source: string): readonly PotemkinConfigSeed[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new BootError("BOOT_ERR_DSL_SCHEMA_VIOLATION", `${source}: "seeds" must be an array`, {
      source,
    });
  }
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!isObject(entry)) {
      throw new BootError(
        "BOOT_ERR_DSL_SCHEMA_VIOLATION",
        `${source}: "seeds[${i}]" must be an object`,
        { source },
      );
    }
    if (entry["base"] !== "contract" && entry["base"] !== "empty") {
      throw new BootError(
        "BOOT_ERR_DSL_SCHEMA_VIOLATION",
        `${source}: "seeds[${i}].base" must be "contract" or "empty"`,
        { source },
      );
    }
    if (!isObject(entry["request"])) {
      throw new BootError(
        "BOOT_ERR_DSL_SCHEMA_VIOLATION",
        `${source}: "seeds[${i}].request" must be an object with "method" and "path"`,
        { source },
      );
    }
    const req = entry["request"] as Record<string, unknown>;
    if (typeof req["method"] !== "string" || req["method"].length === 0) {
      throw new BootError(
        "BOOT_ERR_DSL_SCHEMA_VIOLATION",
        `${source}: "seeds[${i}].request.method" must be a non-empty string`,
        { source },
      );
    }
    if (typeof req["path"] !== "string" || req["path"].length === 0) {
      throw new BootError(
        "BOOT_ERR_DSL_SCHEMA_VIOLATION",
        `${source}: "seeds[${i}].request.path" must be a non-empty string`,
        { source },
      );
    }
    if (entry["patches"] !== undefined && !Array.isArray(entry["patches"])) {
      throw new BootError(
        "BOOT_ERR_DSL_SCHEMA_VIOLATION",
        `${source}: "seeds[${i}].patches" must be an array`,
        { source },
      );
    }
    if (entry["description"] !== undefined && typeof entry["description"] !== "string") {
      throw new BootError(
        "BOOT_ERR_DSL_SCHEMA_VIOLATION",
        `${source}: "seeds[${i}].description" must be a string`,
        { source },
      );
    }
  }
  return raw.map((entry) => ({
    ...(entry as Record<string, unknown>),
    patches:
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Array.isArray((entry as Record<string, unknown>)["patches"])
        ? (entry as Record<string, unknown>)["patches"]
        : [],
  })) as unknown as readonly PotemkinConfigSeed[];
}

function assertWorkflowBlock(raw: unknown, source: string): PotemkinConfigWorkflow | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    throw new BootError(
      "BOOT_ERR_DSL_SCHEMA_VIOLATION",
      `${source}: "workflow" must be an object`,
      { source },
    );
  }
  if (raw["ids"] !== undefined) {
    if (!isObject(raw["ids"])) {
      throw new BootError(
        "BOOT_ERR_DSL_SCHEMA_VIOLATION",
        `${source}: "workflow.ids" must be an object`,
        { source },
      );
    }
    for (const [k, v] of Object.entries(raw["ids"] as Record<string, unknown>)) {
      if (!isObject(v)) {
        throw new BootError(
          "BOOT_ERR_DSL_SCHEMA_VIOLATION",
          `${source}: "workflow.ids.${k}" must be an object with "extract" and "use"`,
          { source },
        );
      }
      if (typeof v["extract"] !== "string") {
        throw new BootError(
          "BOOT_ERR_DSL_SCHEMA_VIOLATION",
          `${source}: "workflow.ids.${k}.extract" must be a string`,
          { source },
        );
      }
      if (typeof v["use"] !== "string") {
        throw new BootError(
          "BOOT_ERR_DSL_SCHEMA_VIOLATION",
          `${source}: "workflow.ids.${k}.use" must be a string`,
          { source },
        );
      }
    }
  }
  return raw as PotemkinConfigWorkflow;
}

function assertOverlayBlock(raw: unknown, source: string): PotemkinConfigOverlay | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    throw new BootError("BOOT_ERR_DSL_SCHEMA_VIOLATION", `${source}: "overlay" must be an object`, {
      source,
    });
  }
  if (raw["patches"] !== undefined && !Array.isArray(raw["patches"])) {
    throw new BootError(
      "BOOT_ERR_DSL_SCHEMA_VIOLATION",
      `${source}: "overlay.patches" must be an array`,
      { source },
    );
  }
  return {
    ...(raw as Record<string, unknown>),
    patches: Array.isArray(raw["patches"]) ? raw["patches"] : [],
  } as unknown as PotemkinConfigOverlay;
}

function assertGovernanceBlock(raw: unknown, source: string): PotemkinConfigGovernance | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    throw new BootError(
      "BOOT_ERR_DSL_SCHEMA_VIOLATION",
      `${source}: "governance" must be an object`,
      { source },
    );
  }
  if (raw["report"] !== undefined) {
    if (!isObject(raw["report"])) {
      throw new BootError(
        "BOOT_ERR_DSL_SCHEMA_VIOLATION",
        `${source}: "governance.report" must be an object`,
        { source },
      );
    }
    const report = raw["report"];
    assertObjectKeys(report, ["format", "successCriteria"], "governance.report", source);
    assertOptionalString(report["format"], "governance.report.format", source);
    if (report["successCriteria"] !== undefined) {
      if (!isObject(report["successCriteria"])) {
        throw schemaViolation(
          `${source}: "governance.report.successCriteria" must be an object`,
          source,
        );
      }
      const criteria = report["successCriteria"];
      assertObjectKeys(
        criteria,
        ["minCoverage", "excludedEndpoints"],
        "governance.report.successCriteria",
        source,
      );
      if (
        criteria["minCoverage"] !== undefined &&
        (typeof criteria["minCoverage"] !== "number" || !Number.isFinite(criteria["minCoverage"]))
      ) {
        throw schemaViolation(
          `${source}: "governance.report.successCriteria.minCoverage" must be a finite number`,
          source,
        );
      }
      if (
        criteria["excludedEndpoints"] !== undefined &&
        (!Array.isArray(criteria["excludedEndpoints"]) ||
          criteria["excludedEndpoints"].some((endpoint) => typeof endpoint !== "string"))
      ) {
        throw schemaViolation(
          `${source}: "governance.report.successCriteria.excludedEndpoints" must be an array of strings`,
          source,
        );
      }
    }
  }
  if (raw["successCriterion"] !== undefined && typeof raw["successCriterion"] !== "string") {
    throw new BootError(
      "BOOT_ERR_DSL_SCHEMA_VIOLATION",
      `${source}: "governance.successCriterion" must be a string`,
      { source },
    );
  }
  return raw as PotemkinConfigGovernance;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rejectSnakeCaseKeys(raw: Record<string, unknown>, source: string): void {
  for (const k of Object.keys(raw)) {
    if (k in REMOVED_KEY_MAP) {
      throw new BootError(
        "BOOT_ERR_REMOVED_SYNTAX",
        `${source}: key "${k}" was renamed to "${REMOVED_KEY_MAP[k]}"`,
        { source, removed: k, replacement: REMOVED_KEY_MAP[k] },
      );
    }
  }
}

/**
 * Return the closest match from `candidates` within Levenshtein distance 3,
 * or null. Plain implementation — no n^2 worry at this input size.
 */
function closestKey(needle: string, candidates: readonly string[]): string | null {
  let best: { key: string; d: number } | null = null;
  for (const c of candidates) {
    const d = levenshtein(needle, c);
    if (d <= 3 && (!best || d < best.d)) best = { key: c, d };
  }
  return best ? best.key : null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = Array.from({ length: n + 1 }, () => 0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
