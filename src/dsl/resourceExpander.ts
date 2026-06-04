/**
 * Resource-aggregate expansion.
 *
 * A `resource:` file declares one resource ONCE — its state schema (by name),
 * identity, shared event_catalog/reducers/reactions, and an `operations:` list
 * mapping OpenAPI operationIds to events (or queries). At load time the engine
 * expands it into the per-path BoundaryConfig records it would otherwise be
 * written by hand (a collection boundary, a by-id boundary, sub-action
 * boundaries…), each sharing the one schema via the boundary `schema:` field.
 *
 * Expansion produces ordinary boundary YAML, so every generated boundary flows
 * through the same validateBoundaryConfig path — no special-casing downstream.
 */
import * as yaml from 'js-yaml';
import { BootError } from '../errors.js';
import type { OpenApiDoc } from '../contract/loader.js';

export interface ResolvedModule {
  readonly path: string;
  readonly text: string;
  readonly parsed: unknown;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** operationId -> { path, method } reverse index from the OpenAPI. */
function buildOperationIndex(openapi: OpenApiDoc): Map<string, { path: string; method: string }> {
  const index = new Map<string, { path: string; method: string }>();
  const paths = isRecord(openapi.raw) ? openapi.raw['paths'] : undefined;
  if (!isRecord(paths)) return index;
  for (const [path, itemRaw] of Object.entries(paths)) {
    if (!isRecord(itemRaw)) continue;
    for (const method of HTTP_METHODS) {
      const op = itemRaw[method];
      if (isRecord(op) && typeof op['operationId'] === 'string') {
        index.set(op['operationId'], { path, method: method.toUpperCase() });
      }
    }
  }
  return index;
}

function hasPathParam(path: string): boolean {
  return /\{[^}]+\}/.test(path);
}

function lastPathParam(path: string): string | undefined {
  const all = [...path.matchAll(/\{([^}]+)\}/g)];
  return all.length > 0 ? all[all.length - 1][1] : undefined;
}

/** Stable, readable, unique boundary-name suffix from a contract path. */
function pathToNameSuffix(path: string): string {
  return path
    .replace(/^\//, '')
    .replace(/\{([^}]+)\}/g, 'By_$1')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+$/g, '');
}

interface OperationEntry {
  readonly op: string;
  readonly emit?: string;
  readonly query?: boolean;
  /** CEL gate for the synthesized behavior (defaults to "true"). */
  readonly condition?: string;
  /** Precondition guards for the behavior (state-machine transitions). */
  readonly requires?: unknown;
  /** Conditional multi-emit (passed through to the behavior). */
  readonly emit_when?: unknown;
}

const KNOWN_OPERATION_KEYS = new Set(['op', 'emit', 'query', 'condition', 'requires', 'emit_when']);

/** Top-level keys a `resource:` file may declare. Unknown keys fail fast (no silent drop). */
const KNOWN_RESOURCE_KEYS = new Set([
  'resource', 'schema', 'identity', 'response', 'query_mapping', 'event_catalog',
  'reducers', 'reactions', 'initialization', 'operations',
  // boundary-level config threaded onto every generated boundary:
  'mask', 'audit_fields', 'hateoas', 'state', 'deprecated', 'latency', 'strict_schema', 'fault_rules',
]);

/** Boundary-level keys copied verbatim onto each generated boundary. */
const THREADED_KEYS = ['mask', 'audit_fields', 'hateoas', 'state', 'deprecated', 'latency', 'strict_schema', 'fault_rules'] as const;

function readOperations(raw: Record<string, unknown>, ctx: string): OperationEntry[] {
  const opsRaw = raw['operations'];
  if (!Array.isArray(opsRaw) || opsRaw.length === 0) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "operations" must be a non-empty array`, { context: ctx });
  }
  return opsRaw.map((entry, i) => {
    if (!isRecord(entry) || typeof entry['op'] !== 'string') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.operations[${i}]: requires a string "op" (operationId)`, { context: ctx });
    }
    for (const k of Object.keys(entry)) {
      if (!KNOWN_OPERATION_KEYS.has(k)) {
        throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.operations[${i}] (${entry['op']}): unknown key "${k}" — expected ${[...KNOWN_OPERATION_KEYS].join(', ')}`, { context: ctx });
      }
    }
    const query = entry['query'] === true;
    const emit = typeof entry['emit'] === 'string' ? entry['emit'] : undefined;
    if (!query && emit === undefined) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.operations[${i}] (${entry['op'] as string}): non-query operations require "emit: <EventType>"`, { context: ctx });
    }
    if (query && emit !== undefined) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.operations[${i}] (${entry['op'] as string}): a query operation must not declare "emit"`, { context: ctx });
    }
    return {
      op: entry['op'],
      ...(emit !== undefined ? { emit } : {}),
      query,
      ...(typeof entry['condition'] === 'string' ? { condition: entry['condition'] } : {}),
      ...(entry['requires'] !== undefined ? { requires: entry['requires'] } : {}),
      ...(entry['emit_when'] !== undefined ? { emit_when: entry['emit_when'] } : {}),
    };
  });
}

/** Expand one resource record into its per-path boundary records. */
function expandOne(raw: Record<string, unknown>, sourcePath: string, opIndex: Map<string, { path: string; method: string }>): ResolvedModule[] {
  const ctx = `resource "${typeof raw['resource'] === 'string' ? raw['resource'] : '?'}" (${sourcePath})`;
  const resourceName = raw['resource'];
  if (typeof resourceName !== 'string' || resourceName.length === 0) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "resource" must be a non-empty string`, { context: ctx });
  }
  const schema = raw['schema'];
  if (typeof schema !== 'string' || schema.length === 0) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "schema" must be a non-empty components.schemas name`, { context: ctx });
  }
  if (!Array.isArray(raw['event_catalog']) || !Array.isArray(raw['reducers'])) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "event_catalog" and "reducers" arrays are required`, { context: ctx });
  }
  // Fail fast on unknown top-level keys so nothing is silently dropped.
  for (const k of Object.keys(raw)) {
    if (!KNOWN_RESOURCE_KEYS.has(k)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: unknown resource key "${k}" — supported: ${[...KNOWN_RESOURCE_KEYS].sort().join(', ')}`, { context: ctx, key: k });
    }
  }

  const identity = isRecord(raw['identity']) ? raw['identity'] : undefined;
  const operations = readOperations(raw, ctx);

  // Group operations by their resolved contract path.
  const byPath = new Map<string, Array<OperationEntry & { method: string }>>();
  for (const op of operations) {
    const resolved = opIndex.get(op.op);
    if (!resolved) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: operation "${op.op}" is not an operationId in the OpenAPI contract`, { context: ctx, operationId: op.op });
    }
    const arr = byPath.get(resolved.path) ?? [];
    arr.push({ ...op, method: resolved.method });
    byPath.set(resolved.path, arr);
  }

  const hasCollectionPath = [...byPath.keys()].some((p) => !hasPathParam(p));
  const out: ResolvedModule[] = [];
  let attachedReactions = false;
  let attachedInit = false;
  for (const [path, ops] of byPath) {
    const isCollection = !hasPathParam(path);
    const hasQuery = ops.some((o) => o.query);

    const record: Record<string, unknown> = {
      boundary: `${resourceName}__${pathToNameSuffix(path)}`,
      schema,
      contract_path: path,
      // GET list/retrieve auto-serve a query when no behavior matches.
      fallback_override: hasQuery,
      event_catalog: raw['event_catalog'],
      reducers: raw['reducers'],
    };
    if (typeof raw['response'] === 'string') record['response'] = raw['response'];
    if (isRecord(raw['query_mapping'])) record['query_mapping'] = raw['query_mapping'];
    // Boundary-level config declared on the resource applies to every generated boundary.
    for (const k of THREADED_KEYS) {
      if (raw[k] !== undefined) record[k] = raw[k];
    }

    // Identity: collection paths create (generator); param paths key off the path.
    if (isCollection) {
      if (identity?.['creation'] !== undefined) record['identity'] = { creation: identity['creation'] };
    } else {
      record['identity'] = { key: { from: 'path', name: lastPathParam(path) } };
    }

    // Seed entities ride on the collection boundary (which owns creation); if the
    // resource has no collection path (e.g. reaction-materialized), the first
    // generated boundary carries them so seeds are never silently dropped.
    if (!attachedInit && Array.isArray(raw['initialization']) && raw['initialization'].length > 0 && (isCollection || (!hasCollectionPath && out.length === 0))) {
      record['initialization'] = raw['initialization'];
      attachedInit = true;
    }

    // One behavior per non-query operation, carrying any per-operation guard
    // (condition / requires / emit_when) so guarded state-machine transitions
    // (e.g. confirm only when requires_confirmation) are expressible.
    const behaviors = ops
      .filter((o) => !o.query)
      .map((o) => ({
        name: o.op,
        match: {
          operationId: o.op,
          method: o.method,
          condition: o.condition ?? 'true',
          ...(o.requires !== undefined ? { requires: o.requires } : {}),
        },
        emit: o.emit,
        ...(o.emit_when !== undefined ? { emit_when: o.emit_when } : {}),
      }));
    if (behaviors.length > 0) record['behaviors'] = behaviors;

    // Resource reactions ride on the first generated boundary (reacting boundary
    // = that boundary); auto-fill the reacting boundary name when absent.
    if (!attachedReactions && Array.isArray(raw['reactions']) && raw['reactions'].length > 0) {
      record['reactions'] = (raw['reactions'] as unknown[]).map((r) =>
        isRecord(r) && r['boundary'] === undefined ? { ...r, boundary: record['boundary'] } : r,
      );
      attachedReactions = true;
    }

    out.push({ path: `${sourcePath}#${path}`, text: yaml.dump(record), parsed: record });
  }
  return out;
}

/**
 * Expand all `resource:` modules into ordinary boundary modules, resolving each
 * operation's contract path/method from the OpenAPI.
 */
export function expandResourceModules(resourceModules: readonly ResolvedModule[], openapi: OpenApiDoc): ResolvedModule[] {
  if (resourceModules.length === 0) return [];
  const opIndex = buildOperationIndex(openapi);
  const out: ResolvedModule[] = [];
  for (const mod of resourceModules) {
    if (!isRecord(mod.parsed)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${mod.path}: resource file must be a YAML mapping`, { source: mod.path });
    }
    out.push(...expandOne(mod.parsed, mod.path, opIndex));
  }
  return out;
}
