// YAML schema validators for potemkin.yml and boundary modules.
// Unknown top-level keys in potemkin.yml are rejected with a Levenshtein
// "did you mean?" suggestion; removed snake_case keys throw BOOT_ERR_REMOVED_SYNTAX.

import { BootError } from '../errors.js';
import type {
  PotemkinConfiguration,
  ScanConfig,
  PluginAuthConfig,
  PluginConfiguration,
  PluginJwk,
  SeedDefinition,
  WorkflowDefinition,
  OverlayDefinition,
  GovernanceDefinition,
} from '../contracts/config.js';
import {
  isJsonObject,
  isJsonValue,
  isRecord as isObject,
  type JsonObject,
  type JsonValue,
  type Patch,
} from '../contracts/value.js';

export const PLUGIN_SUB_KEYS = [
  'engine',
  'controlPort',
  'resilience',
  'healthProbe',
  'discovery',
  'circuitBreaker',
  'auth',
] as const;

export const POTEMKIN_TOP_LEVEL_KEYS = [
  'version',
  'specmatic',
  'modules',
  'openapi',
  'typescript',
  'plugin',
  'seeds',
  'workflow',
  'overlay',
  'governance',
] as const;

// Renamed snake_case keys; each produces BOOT_ERR_REMOVED_SYNTAX at parse time.
export const REMOVED_KEY_MAP: Record<string, string> = {
  event_catalog: 'events',
  payload_template: 'template',
  state_schema: 'state',
  dispatch_commands: 'dispatch',
  contract_path: 'contractPath',
  depends_on: 'dependsOn',
  out_of_contract: 'outOfContract',
  spec_id: 'specId',
  seed_expectations: 'seeds',
  derived_projections: 'derivedProjections',
};

export interface ValidationContext {
  /** Source description for error messages (file path, "potemkin.yml", etc.). */
  readonly source: string;
}

export function validatePotemkinConfig(
  raw: unknown,
  ctx: ValidationContext,
): PotemkinConfiguration {
  if (!isObject(raw)) {
    throw new BootError('BOOT_ERR_DSL_SCHEMA_VIOLATION', `${ctx.source}: root must be an object`, {
      source: ctx.source,
    });
  }

  rejectSnakeCaseKeys(raw, ctx.source);

  for (const k of Object.keys(raw)) {
    if (!includesString(POTEMKIN_TOP_LEVEL_KEYS, k)) {
      const suggestion = closestKey(k, POTEMKIN_TOP_LEVEL_KEYS);
      throw new BootError(
        'BOOT_ERR_UNKNOWN_KEY',
        `${ctx.source}: unknown top-level key "${k}"${
          suggestion ? ` — did you mean "${suggestion}"?` : ''
        }`,
        { source: ctx.source, key: k, ...(suggestion ? { suggestion } : {}) },
      );
    }
  }

  const version = raw['version'];
  if (typeof version !== 'number') {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${ctx.source}: "version" must be a number`,
      { source: ctx.source },
    );
  }
  const specmatic = raw['specmatic'];
  if (typeof specmatic !== 'string') {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${ctx.source}: "specmatic" must be a string path`,
      { source: ctx.source },
    );
  }
  const modules = raw['modules'];
  if (!isNonEmptyStringArray(modules)) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${ctx.source}: "modules" must be a non-empty array of glob strings`,
      { source: ctx.source },
    );
  }
  const openapi = raw['openapi'];
  if (openapi !== undefined && !isNonEmptyStringArray(openapi)) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${ctx.source}: "openapi" must be a non-empty array of file globs`,
      { source: ctx.source },
    );
  }

  const typescript = assertTypescriptBlock(raw['typescript'], ctx.source);
  const plugin = assertPluginBlock(raw['plugin'], ctx.source);
  const seeds = assertSeedsBlock(raw['seeds'], ctx.source);
  const workflow = assertWorkflowBlock(raw['workflow'], ctx.source);
  const overlay = assertOverlayBlock(raw['overlay'], ctx.source);
  const governance = assertGovernanceBlock(raw['governance'], ctx.source);

  return {
    version,
    specmatic,
    modules,
    ...(openapi === undefined ? {} : { openapi }),
    typescript,
    plugin,
    seeds,
    workflow,
    overlay,
    governance,
  };
}

function assertTypescriptBlock(raw: unknown, source: string): ScanConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${source}: "typescript" must be a mapping`,
      { source },
    );
  }
  const scan = raw['scan'];
  if (!Array.isArray(scan) || scan.length === 0) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${source}: "typescript.scan" must be a non-empty array of { include } entries`,
      { source },
    );
  }
  const entries = scan.map((entry, i) => {
    const include = isObject(entry) ? entry['include'] : undefined;
    if (!isObject(entry) || !isNonEmptyStringArray(include)) {
      throw new BootError(
        'BOOT_ERR_DSL_SCHEMA_VIOLATION',
        `${source}: "typescript.scan[${i}].include" must be a non-empty array of glob strings`,
        { source },
      );
    }
    const exclude = isObject(entry) ? entry['exclude'] : undefined;
    if (exclude !== undefined && !isStringArray(exclude)) {
      throw new BootError(
        'BOOT_ERR_DSL_SCHEMA_VIOLATION',
        `${source}: "typescript.scan[${i}].exclude" must be an array of glob strings`,
        { source },
      );
    }
    return {
      include,
      ...(exclude === undefined ? {} : { exclude }),
    };
  });
  const watchIntervalMs = raw['watchIntervalMs'];
  if (
    watchIntervalMs !== undefined &&
    (typeof watchIntervalMs !== 'number' ||
      !Number.isFinite(watchIntervalMs) ||
      watchIntervalMs <= 0)
  ) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${source}: "typescript.watchIntervalMs" must be a finite positive number`,
      { source },
    );
  }
  return {
    scan: entries,
    ...(watchIntervalMs === undefined ? {} : { watchIntervalMs }),
  };
}

function assertPluginBlock(raw: unknown, source: string): PluginConfiguration | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    throw new BootError('BOOT_ERR_DSL_SCHEMA_VIOLATION', `${source}: "plugin" must be an object`, {
      source,
    });
  }
  for (const k of Object.keys(raw)) {
    if (!includesString(PLUGIN_SUB_KEYS, k)) {
      const suggestion = closestKey(k, PLUGIN_SUB_KEYS);
      throw new BootError(
        'BOOT_ERR_UNKNOWN_KEY',
        `${source}: unknown plugin key "${k}"${
          suggestion ? ` — did you mean "${suggestion}"?` : ''
        }`,
        { source, key: k, ...(suggestion ? { suggestion } : {}) },
      );
    }
  }
  const controlPort = assertIntegerRange(
    raw['controlPort'],
    'plugin.controlPort',
    source,
    0,
    65535,
  );

  const engineRaw = raw['engine'];
  if (engineRaw !== undefined && !isObject(engineRaw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${source}: "plugin.engine" must be an object`,
      { source },
    );
  }
  assertObjectKeys(engineRaw, ['url', 'timeoutMs'], 'plugin.engine', source);
  const engineUrl = isObject(engineRaw)
    ? assertOptionalString(engineRaw['url'], 'plugin.engine.url', source)
    : undefined;
  const engineTimeoutMs = isObject(engineRaw)
    ? assertPositiveNumber(engineRaw['timeoutMs'], 'plugin.engine.timeoutMs', source)
    : undefined;
  const engine =
    engineRaw === undefined
      ? undefined
      : {
          ...(engineUrl === undefined ? {} : { url: engineUrl }),
          ...(engineTimeoutMs === undefined ? {} : { timeoutMs: engineTimeoutMs }),
        };

  const resilience = parseNonNegativeNumberBlock(
    raw['resilience'],
    ['maxRetries', 'backoffMs'],
    'plugin.resilience',
    source,
  );

  const healthProbeRaw = raw['healthProbe'];
  assertObjectKeys(healthProbeRaw, ['initialMs', 'stableMs', 'path'], 'plugin.healthProbe', source);
  const healthProbeNumbers = parseNonNegativeNumberBlock(
    healthProbeRaw,
    ['initialMs', 'stableMs'],
    'plugin.healthProbe',
    source,
  );
  const healthProbePath = isObject(healthProbeRaw)
    ? assertOptionalString(healthProbeRaw['path'], 'plugin.healthProbe.path', source)
    : undefined;
  const healthProbe =
    healthProbeRaw === undefined
      ? undefined
      : {
          ...healthProbeNumbers,
          ...(healthProbePath === undefined ? {} : { path: healthProbePath }),
        };

  const discovery = parseNonNegativeNumberBlock(
    raw['discovery'],
    ['refreshOnFailureMs', 'ttlSeconds'],
    'plugin.discovery',
    source,
  );

  const circuitBreaker = parseNonNegativeNumberBlock(
    raw['circuitBreaker'],
    ['failureRate', 'waitMs'],
    'plugin.circuitBreaker',
    source,
  );
  const authRaw = raw['auth'];
  if (authRaw !== undefined && !isObject(authRaw)) {
    throw schemaViolation(`${source}: "plugin.auth" must be an object`, source);
  }
  assertObjectKeys(
    authRaw,
    ['mode', 'algorithm', 'secret', 'jwks', 'jwksUrl', 'realm'],
    'plugin.auth',
    source,
  );
  const auth = isObject(authRaw) ? parsePluginAuth(authRaw, source) : undefined;

  return {
    ...(engine === undefined ? {} : { engine }),
    ...(controlPort === undefined ? {} : { controlPort }),
    ...(resilience === undefined ? {} : { resilience }),
    ...(healthProbe === undefined ? {} : { healthProbe }),
    ...(discovery === undefined ? {} : { discovery }),
    ...(circuitBreaker === undefined ? {} : { circuitBreaker }),
    ...(auth === undefined ? {} : { auth }),
  };
}

function parseNonNegativeNumberBlock(
  raw: unknown,
  keys: readonly string[],
  field: string,
  source: string,
): Record<string, number> | undefined {
  if (raw === undefined) return;
  if (!isObject(raw)) throw schemaViolation(`${source}: "${field}" must be an object`, source);
  assertObjectKeys(raw, keys, field, source);
  const parsed: Record<string, number> = {};
  for (const key of keys) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw schemaViolation(
        `${source}: "${field}.${key}" must be a finite non-negative number`,
        source,
      );
    }
    parsed[key] = value;
  }
  return parsed;
}

function parsePluginAuth(raw: Record<string, unknown>, source: string): PluginAuthConfig {
  const mode = assertOptionalEnum(
    raw['mode'],
    ['none', 'jwt'] as const,
    'plugin.auth.mode',
    source,
    'must be "none" or "jwt"',
  );
  const algorithm = assertOptionalEnum(
    raw['algorithm'],
    ['HS256', 'RS256'] as const,
    'plugin.auth.algorithm',
    source,
    'must be "HS256" or "RS256"',
  );
  const secret = assertOptionalString(raw['secret'], 'plugin.auth.secret', source);
  const jwksUrl = assertOptionalString(raw['jwksUrl'], 'plugin.auth.jwksUrl', source);
  const realm = assertOptionalString(raw['realm'], 'plugin.auth.realm', source);
  const jwks = parsePluginJwks(raw['jwks'], source);

  return {
    ...(mode === undefined ? {} : { mode }),
    ...(algorithm === undefined ? {} : { algorithm }),
    ...(secret === undefined ? {} : { secret }),
    ...(jwks === undefined ? {} : { jwks }),
    ...(jwksUrl === undefined ? {} : { jwksUrl }),
    ...(realm === undefined ? {} : { realm }),
  };
}

function parsePluginJwks(value: unknown, source: string): readonly PluginJwk[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw schemaViolation(`${source}: "plugin.auth.jwks" must be an array`, source);
  }
  return value.map((entry, index) => {
    const field = `plugin.auth.jwks[${index}]`;
    if (!isObject(entry)) throw schemaViolation(`${source}: "${field}" must be an object`, source);
    assertObjectKeys(entry, ['kty', 'kid', 'n', 'e'], field, source);
    const kty = assertNonEmptyString(entry['kty'], `${field}.kty`, source);
    const n = assertNonEmptyString(entry['n'], `${field}.n`, source);
    const e = assertNonEmptyString(entry['e'], `${field}.e`, source);
    const kid = assertOptionalString(entry['kid'], `${field}.kid`, source);
    return {
      kty,
      n,
      e,
      ...(kid === undefined ? {} : { kid }),
    };
  });
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
        'BOOT_ERR_UNKNOWN_KEY',
        `${source}: unknown key "${field}.${key}"${suggestion ? ` — did you mean "${field}.${suggestion}"?` : ''}`,
        { source, key, field: `${field}.${key}`, ...(suggestion ? { suggestion } : {}) },
      );
    }
  }
}

function assertOptionalString(value: unknown, field: string, source: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw schemaViolation(`${source}: "${field}" must be a string`, source);
  }
  return value;
}

function assertNonEmptyString(value: unknown, field: string, source: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw schemaViolation(`${source}: "${field}" must be a non-empty string`, source);
  }
  return value;
}

function assertPositiveNumber(value: unknown, field: string, source: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw schemaViolation(`${source}: "${field}" must be a positive number`, source);
  }
  return value;
}

function assertIntegerRange(
  value: unknown,
  field: string,
  source: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw schemaViolation(
      `${source}: "${field}" must be an integer between ${min} and ${max}`,
      source,
    );
  }
  return value;
}

function assertOptionalEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string,
  source: string,
  expectation: string,
): Values[number] | undefined {
  if (value === undefined) return undefined;
  if (!isOneOf(value, values))
    throw schemaViolation(`${source}: "${field}" ${expectation}`, source);
  return value;
}

function schemaViolation(message: string, source: string): BootError {
  return new BootError('BOOT_ERR_DSL_SCHEMA_VIOLATION', message, { source });
}

function assertSeedsBlock(raw: unknown, source: string): readonly SeedDefinition[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new BootError('BOOT_ERR_DSL_SCHEMA_VIOLATION', `${source}: "seeds" must be an array`, {
      source,
    });
  }
  return raw.map((entry, index) => {
    const field = `seeds[${index}]`;
    if (!isObject(entry)) throw schemaViolation(`${source}: "${field}" must be an object`, source);

    const base = assertOptionalEnum(
      entry['base'],
      ['contract', 'empty'] as const,
      `${field}.base`,
      source,
      'must be "contract" or "empty"',
    );
    if (base === undefined) {
      throw schemaViolation(`${source}: "${field}.base" is required`, source);
    }

    const request = entry['request'];
    if (!isObject(request)) {
      throw schemaViolation(
        `${source}: "${field}.request" must be an object with "method" and "path"`,
        source,
      );
    }
    const method = assertNonEmptyString(request['method'], `${field}.request.method`, source);
    const path = assertNonEmptyString(request['path'], `${field}.request.path`, source);
    const description = assertOptionalString(entry['description'], `${field}.description`, source);
    const patches = parsePatches(entry['patches'], `${field}.patches`, source) ?? [];

    return {
      ...(description === undefined ? {} : { description }),
      request: { method, path },
      base,
      patches,
    };
  });
}

function assertWorkflowBlock(raw: unknown, source: string): WorkflowDefinition | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${source}: "workflow" must be an object`,
      { source },
    );
  }
  const idsRaw = raw['ids'];
  if (idsRaw === undefined) return {};
  if (!isObject(idsRaw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${source}: "workflow.ids" must be an object`,
      { source },
    );
  }

  const ids: Record<string, { extract: string; use: string }> = {};
  for (const [key, value] of Object.entries(idsRaw)) {
    if (!isObject(value)) {
      throw new BootError(
        'BOOT_ERR_DSL_SCHEMA_VIOLATION',
        `${source}: "workflow.ids.${key}" must be an object with "extract" and "use"`,
        { source },
      );
    }
    const extract = assertOptionalString(value['extract'], `workflow.ids.${key}.extract`, source);
    if (extract === undefined) {
      throw new BootError(
        'BOOT_ERR_DSL_SCHEMA_VIOLATION',
        `${source}: "workflow.ids.${key}.extract" must be a string`,
        { source },
      );
    }
    const use = assertOptionalString(value['use'], `workflow.ids.${key}.use`, source);
    if (use === undefined) {
      throw new BootError(
        'BOOT_ERR_DSL_SCHEMA_VIOLATION',
        `${source}: "workflow.ids.${key}.use" must be a string`,
        { source },
      );
    }
    ids[key] = { extract, use };
  }
  return { ids };
}

function assertOverlayBlock(raw: unknown, source: string): OverlayDefinition | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    throw new BootError('BOOT_ERR_DSL_SCHEMA_VIOLATION', `${source}: "overlay" must be an object`, {
      source,
    });
  }
  return { patches: parsePatches(raw['patches'], 'overlay.patches', source) ?? [] };
}

function assertGovernanceBlock(raw: unknown, source: string): GovernanceDefinition | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${source}: "governance" must be an object`,
      { source },
    );
  }
  const report =
    raw['report'] === undefined ? undefined : parseGovernanceReport(raw['report'], source);
  const successCriterion = assertOptionalString(
    raw['successCriterion'],
    'governance.successCriterion',
    source,
  );
  return {
    ...(report === undefined ? {} : { report }),
    ...(successCriterion === undefined ? {} : { successCriterion }),
  };
}

function parseGovernanceReport(
  raw: unknown,
  source: string,
): NonNullable<GovernanceDefinition['report']> {
  if (!isObject(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      `${source}: "governance.report" must be an object`,
      { source },
    );
  }
  assertObjectKeys(raw, ['format', 'successCriteria'], 'governance.report', source);
  const format = assertOptionalString(raw['format'], 'governance.report.format', source);
  const criteriaRaw = raw['successCriteria'];
  if (criteriaRaw === undefined) {
    return format === undefined ? {} : { format };
  }
  if (!isObject(criteriaRaw)) {
    throw schemaViolation(
      `${source}: "governance.report.successCriteria" must be an object`,
      source,
    );
  }
  assertObjectKeys(
    criteriaRaw,
    ['minCoverage', 'excludedEndpoints'],
    'governance.report.successCriteria',
    source,
  );
  const minCoverage = assertFiniteNumber(
    criteriaRaw['minCoverage'],
    'governance.report.successCriteria.minCoverage',
    source,
  );
  const excludedEndpoints = parseOptionalStringArray(
    criteriaRaw['excludedEndpoints'],
    'governance.report.successCriteria.excludedEndpoints',
    source,
  );
  const successCriteria = {
    ...(minCoverage === undefined ? {} : { minCoverage }),
    ...(excludedEndpoints === undefined ? {} : { excludedEndpoints }),
  };
  return {
    ...(format === undefined ? {} : { format }),
    successCriteria,
  };
}

function parsePatches(value: unknown, field: string, source: string): readonly Patch[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw schemaViolation(`${source}: "${field}" must be an array`, source);
  }
  return value.map((entry, index) => parsePatch(entry, `${field}[${index}]`, source));
}

function parsePatch(value: unknown, field: string, source: string): Patch {
  if (!isObject(value)) throw schemaViolation(`${source}: "${field}" must be an object`, source);
  const op = assertOptionalEnum(
    value['op'],
    [
      'add',
      'remove',
      'replace',
      'move',
      'copy',
      'append',
      'prepend',
      'increment',
      'merge',
      'upsert',
    ] as const,
    `${field}.op`,
    source,
    'must be a supported patch operation',
  );
  if (op === undefined) throw schemaViolation(`${source}: "${field}.op" is required`, source);
  const path = assertPatchPath(value['path'], `${field}.path`, source);

  switch (op) {
    case 'add':
    case 'replace':
    case 'append':
    case 'prepend':
      return { op, path, value: parseJsonValue(value['value'], `${field}.value`, source) };
    case 'remove':
      return { op, path };
    case 'move':
    case 'copy':
      return { op, path, from: assertPatchPath(value['from'], `${field}.from`, source) };
    case 'increment': {
      const by = assertFiniteNumber(value['by'], `${field}.by`, source);
      if (by === undefined) throw schemaViolation(`${source}: "${field}.by" is required`, source);
      return { op, path, by };
    }
    case 'merge': {
      const deep = assertOptionalBoolean(value['deep'], `${field}.deep`, source);
      return {
        op,
        path,
        value: parseJsonObject(value['value'], `${field}.value`, source),
        ...(deep === undefined ? {} : { deep }),
      };
    }
    case 'upsert':
      return {
        op,
        path,
        key: assertString(value['key'], `${field}.key`, source),
        value: parseJsonObject(value['value'], `${field}.value`, source),
      };
  }
}

function parseJsonValue(value: unknown, field: string, source: string): JsonValue {
  if (!isJsonValue(value)) {
    throw schemaViolation(`${source}: "${field}" must be a JSON value`, source);
  }
  return value;
}

function parseJsonObject(value: unknown, field: string, source: string): JsonObject {
  if (!isJsonObject(value)) {
    throw schemaViolation(`${source}: "${field}" must be a JSON object`, source);
  }
  return value;
}

function assertPatchPath(value: unknown, field: string, source: string): string {
  const path = assertString(value, field, source);
  if (!path.startsWith('/')) {
    throw schemaViolation(`${source}: "${field}" must start with "/"`, source);
  }
  return path;
}

function assertString(value: unknown, field: string, source: string): string {
  if (typeof value !== 'string')
    throw schemaViolation(`${source}: "${field}" must be a string`, source);
  return value;
}

function assertFiniteNumber(value: unknown, field: string, source: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw schemaViolation(`${source}: "${field}" must be a finite number`, source);
  }
  return value;
}

function assertOptionalBoolean(value: unknown, field: string, source: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean')
    throw schemaViolation(`${source}: "${field}" must be a boolean`, source);
  return value;
}

function parseOptionalStringArray(
  value: unknown,
  field: string,
  source: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!isStringArray(value)) {
    throw schemaViolation(`${source}: "${field}" must be an array of strings`, source);
  }
  return value;
}

function includesString(values: readonly string[], value: string): boolean {
  return values.some((candidate) => candidate === value);
}

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNonEmptyStringArray(value: unknown): value is [string, ...string[]] {
  return isStringArray(value) && value.length > 0;
}

function rejectSnakeCaseKeys(raw: Record<string, unknown>, source: string): void {
  for (const k of Object.keys(raw)) {
    if (k in REMOVED_KEY_MAP) {
      throw new BootError(
        'BOOT_ERR_REMOVED_SYNTAX',
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
