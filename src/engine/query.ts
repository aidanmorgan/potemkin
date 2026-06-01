import type { JsonValue, JsonObject } from '../types.js';
import type { BoundaryConfig } from '../dsl/types.js';
import type { StateGraph } from '../stategraph/graph.js';
import type { EventStore } from '../eventstore/store.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { OpenApiDoc } from '../contract/loader.js';
import type { Logger } from '../observability/logger.js';
import type { Tracer } from '../observability/tracing.js';
import type { ObjectGraphSchemaRegistry } from '../schema/types.js';
import { CelPhase } from '../cel/phases.js';
import { getTracer } from '../observability/tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';
import { EntityAbsenceError } from '../errors.js';

export interface QueryRequest {
  readonly boundary: BoundaryConfig;
  /** Specific targetId, or null for a collection query. */
  readonly targetId: string | null;
  readonly queryParams: Record<string, string | string[]>;
  readonly graph: StateGraph;
  readonly cel: CelEvaluator;
  readonly openapi: OpenApiDoc;
  /** Optional logger for query execution traces. */
  readonly logger?: Logger;
  /** Optional schema registry for resolving derived property paths. */
  readonly schemaRegistry?: ObjectGraphSchemaRegistry;
  /**
   * Optional event store used to scope collection queries to the requested boundary.
   * When provided, entities are filtered to those whose first event has a matching boundary.
   * When absent (e.g. in tests that populate the graph directly), no boundary filter is applied.
   */
  readonly events?: EventStore;
  /**
   * Optional tracer for the engine.query span. When provided, the span is emitted
   * via this tracer (enabling injection by UoW for testability). Falls back to
   * getTracer('engine') when absent.
   */
  readonly tracer?: Tracer;
}

/**
 * Execute a read query against the StateGraph.
 *
 * - If `targetId` is non-null: return the single entity (applying CEL derived-property
 *   expressions defined in `queryMapping`).
 * - If `targetId` is null: return a filtered/sliced array of all entities in the boundary,
 *   applying `queryMapping` filter expressions against `queryParams`.
 *
 * @throws {EntityAbsenceError} (404) if a single-entity lookup finds no match.
 */
export function runQuery(req: QueryRequest): JsonValue {
  const tracer = req.tracer ?? getTracer('engine');
  let result: JsonValue = null;
  let threw = false;
  let thrownErr: unknown;

  tracer.startActiveSpan('engine.query', (span) => {
    try {
      result = _runQuery(req);
    } catch (err) {
      threw = true;
      thrownErr = err;
      if (err instanceof Error) span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
    } finally {
      span.end();
    }
  });

  if (threw) throw thrownErr;
  return result;
}

/** Encode an opaque cursor carrying the id of the last item on the current page. */
function encodeCursor(lastId: string): string {
  return Buffer.from(JSON.stringify({ lastId }), 'utf8').toString('base64');
}

/** Decode an opaque cursor. Returns null when the cursor is malformed. */
function decodeCursor(cursor: string): { lastId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    if (parsed && typeof parsed === 'object' && typeof parsed.lastId === 'string') {
      return { lastId: parsed.lastId };
    }
    return null;
  } catch {
    return null;
  }
}

function compareValues(a: unknown, b: unknown): number {
  // Nulls/undefined sort to the end regardless of order.
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * Resolve a dotted path (e.g. `customer.contact.email`) against an object.
 * A single segment with no dot behaves identically to a direct property lookup.
 * Returns undefined when any intermediate segment is missing or not an object.
 */
function getByDotPath(obj: unknown, path: string): unknown {
  if (path.indexOf('.') === -1) {
    return (obj as Record<string, unknown> | null | undefined)?.[path];
  }
  let cur: unknown = obj;
  for (const segment of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || Array.isArray(cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

function operatorMatch(fieldValue: unknown, op: string, expected: string): boolean {
  // arrayContains: strict array-only membership. Non-arrays never match.
  if (op === 'arrayContains') {
    return Array.isArray(fieldValue) && fieldValue.some(el => String(el) === expected);
  }
  // contains against an array does membership rather than substring.
  if (op === 'contains' && Array.isArray(fieldValue)) {
    return fieldValue.some(el => String(el) === expected);
  }
  // Null/undefined: only `ne` may match.
  if (fieldValue === null || fieldValue === undefined) {
    return op === 'ne';
  }
  // Numeric ops try numeric compare when expected parses as number.
  const numExpected = Number(expected);
  const numField = typeof fieldValue === 'number' ? fieldValue : Number(fieldValue);
  switch (op) {
    case 'gt':  return !isNaN(numField) && !isNaN(numExpected) ? numField > numExpected : String(fieldValue) > expected;
    case 'gte': return !isNaN(numField) && !isNaN(numExpected) ? numField >= numExpected : String(fieldValue) >= expected;
    case 'lt':  return !isNaN(numField) && !isNaN(numExpected) ? numField < numExpected : String(fieldValue) < expected;
    case 'lte': return !isNaN(numField) && !isNaN(numExpected) ? numField <= numExpected : String(fieldValue) <= expected;
    case 'ne':  return String(fieldValue) !== expected && (isNaN(numField) || isNaN(numExpected) || numField !== numExpected);
    case 'in': {
      const set = expected.split(',').map(s => s.trim());
      return set.includes(String(fieldValue));
    }
    case 'contains':
      return typeof fieldValue === 'string' && fieldValue.toLowerCase().includes(expected.toLowerCase());
    case 'startsWith':
      return typeof fieldValue === 'string' && fieldValue.toLowerCase().startsWith(expected.toLowerCase());
    case 'endsWith':
      return typeof fieldValue === 'string' && fieldValue.toLowerCase().endsWith(expected.toLowerCase());
    default:
      return false;
  }
}

function _runQuery(req: QueryRequest): JsonValue {
  const { boundary, targetId, queryParams, graph, cel, openapi, logger, events } = req;
  const log = logger?.child({ component: 'query', boundary: boundary.boundary, targetId });

  if (targetId !== null) {
    // Single-entity lookup
    const raw = graph.get(targetId);
    if (raw === null) {
      log?.debug({ targetId }, 'Entity not found');
      throw new EntityAbsenceError(
        `Entity '${targetId}' not found in boundary '${boundary.boundary}'`,
        { targetId, boundary: boundary.boundary },
      );
    }

    let entity = applyDerivedProperties(raw, boundary, openapi, cel, log);
    const includeFields = parseCsvParam(queryParams['include']);
    if (includeFields.length > 0) entity = expandIncludes(entity, includeFields, graph);
    const selectFields = parseCsvParam(queryParams['fields']);
    if (selectFields.length > 0) entity = projectFields(entity, selectFields);
    log?.info({ targetId, boundary: boundary.boundary }, 'Single-entity query result returned');
    return entity;
  }

  // Collection query — scope to this boundary when event store is available.
  // Without boundary scoping, graph.values() returns ALL entities across ALL boundaries
  // sharing the same StateGraph, causing cross-boundary data leakage.
  // Inspect the first event for each entity's targetId to find its originating boundary.
  let graphKeys = graph.keys() as readonly string[];
  if (events !== undefined) {
    const boundaryName = boundary.boundary;
    graphKeys = graphKeys.filter((key) => {
      const entityEvents = events.byAggregate(key);
      if (entityEvents.length === 0) return false;
      return entityEvents[0].boundary === boundaryName;
    });
  }
  let entities = graphKeys.map((k) => graph.get(k)!).filter(Boolean) as readonly JsonObject[];

  // Soft-delete: exclude entities with _deleted=true unless ?includeDeleted=true.
  const includeDeletedParam = queryParams['includeDeleted'];
  const includeDeleted = includeDeletedParam !== undefined
    && (Array.isArray(includeDeletedParam) ? includeDeletedParam[0] : includeDeletedParam) === 'true';
  if (!includeDeleted) {
    entities = entities.filter(e => e['_deleted'] !== true);
  }

  // Apply queryMapping filters
  const appliedFilters: string[] = [];
  if (boundary.queryMapping) {
    for (const [paramKey, filterExpr] of Object.entries(boundary.queryMapping)) {
      const paramValue = queryParams[paramKey];
      if (paramValue === undefined) continue;

      appliedFilters.push(paramKey);

      entities = entities.filter(entity => {
        const celCtx: Record<string, unknown> = {
          state: entity as Record<string, unknown>,
          param: paramValue,
          params: queryParams,
        };
        try {
          const match = cel.evaluate(filterExpr, celCtx, CelPhase.Behavior);
          return match === true;
        } catch (err) {
          log?.warn(
            { boundary: boundary.boundary, entityId: entity['id'], filterExpr, err },
            'Query filter CEL evaluation failed — excluding entity from results',
          );
          return false;
        }
      });
    }
  }

  // Apply operator filters (?field:op=value, where op ∈ gt,gte,lt,lte,ne,in,contains,startsWith,endsWith).
  // The same field can carry multiple operator filters; all must match (AND).
  const opRegex = /^(.+):(gt|gte|lt|lte|ne|in|contains|arrayContains|startsWith|endsWith)$/;
  for (const [key, rawVal] of Object.entries(queryParams)) {
    const m = opRegex.exec(key);
    if (!m) continue;
    const field = m[1]!;
    const op = m[2]!;
    const val = Array.isArray(rawVal) ? rawVal[0] : rawVal;
    if (val === undefined) continue;
    entities = entities.filter(e => operatorMatch(getByDotPath(e, field), op, val));
  }

  // Apply ?q=searchTerm full-text search across string fields.
  const qParam = queryParams['q'];
  if (qParam !== undefined) {
    const q = (Array.isArray(qParam) ? qParam[0] : qParam).toLowerCase();
    entities = entities.filter(e => {
      for (const v of Object.values(e)) {
        if (typeof v === 'string' && v.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }

  // Apply sorting before pagination.
  // Multi-field form: ?sort=status,-score — comma-separated keys, `-` prefix = descending.
  // Single-field form (no comma, no `-`): ?sort=field&order=asc|desc (backward compatible).
  const sortParam = queryParams['sort'];
  if (sortParam !== undefined) {
    const sortRaw = Array.isArray(sortParam) ? sortParam[0]! : sortParam;
    const isMultiField = sortRaw.includes(',') || sortRaw.startsWith('-');
    if (isMultiField) {
      const keys = sortRaw.split(',').map(s => s.trim()).filter(s => s.length > 0).map(s => {
        const desc = s.startsWith('-');
        return { field: desc ? s.slice(1) : s, dir: desc ? -1 : 1 };
      });
      entities = [...entities].sort((a, b) => {
        for (const { field, dir } of keys) {
          const cmp = dir * compareValues(getByDotPath(a, field), getByDotPath(b, field));
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
    } else {
      const orderParam = queryParams['order'];
      const orderRaw = orderParam !== undefined
        ? (Array.isArray(orderParam) ? orderParam[0] : orderParam)
        : 'asc';
      const dir = orderRaw === 'desc' ? -1 : 1;
      entities = [...entities].sort((a, b) => dir * compareValues(getByDotPath(a, sortRaw), getByDotPath(b, sortRaw)));
    }
  }

  // Apply pagination: limit and offset/cursor from query params.
  const offsetParam = queryParams['offset'];
  const limitParam = queryParams['limit'];
  const cursorParam = queryParams['cursor'];

  const offset = offsetParam !== undefined
    ? parseInt(Array.isArray(offsetParam) ? offsetParam[0] : offsetParam, 10)
    : 0;
  const limit = limitParam !== undefined
    ? parseInt(Array.isArray(limitParam) ? limitParam[0] : limitParam, 10)
    : undefined;

  const totalCount = entities.length;

  // Cursor takes precedence over offset. A cursor carries the id of the last item
  // emitted on the previous page; the next page begins after that id in the current
  // (filtered + sorted) ordering. A malformed cursor yields an empty page.
  const cursor = cursorParam !== undefined
    ? (Array.isArray(cursorParam) ? cursorParam[0]! : cursorParam)
    : undefined;

  let startIndex: number;
  let cursorMalformed = false;
  if (cursor !== undefined) {
    const decoded = decodeCursor(cursor);
    if (decoded === null) {
      cursorMalformed = true;
      startIndex = entities.length; // empty page
    } else {
      const lastIdx = entities.findIndex(e => e['id'] === decoded.lastId);
      startIndex = lastIdx === -1 ? entities.length : lastIdx + 1;
    }
  } else {
    startIndex = isNaN(offset) || offset < 0 ? 0 : offset;
  }

  let sliced = entities.slice(startIndex);
  if (limit !== undefined && !isNaN(limit) && limit >= 0) {
    sliced = sliced.slice(0, limit);
  }

  // Apply derived properties to each entity, then optional relationship expansion
  // (?include=field) and sparse fieldset projection (?fields=a,b).
  const includeFields = parseCsvParam(queryParams['include']);
  const selectFields = parseCsvParam(queryParams['fields']);
  const result = sliced.map(entity => {
    let e = applyDerivedProperties(entity, boundary, openapi, cel, log);
    if (includeFields.length > 0) e = expandIncludes(e, includeFields, graph);
    if (selectFields.length > 0) e = projectFields(e, selectFields);
    return e;
  });

  log?.info(
    { boundary: boundary.boundary, resultCount: result.length, appliedFilters, offset: startIndex, limit },
    'Collection query result returned',
  );

  // Pagination envelope is emitted only when `?limit` is explicitly provided
  // (preserves backwards compatibility for callers that expect a raw array).
  if (limitParam !== undefined) {
    const limitN = limit !== undefined && !isNaN(limit) && limit >= 0 ? limit : 0;
    const hasMore = !cursorMalformed && startIndex + result.length < totalCount;
    const envelope: JsonObject = {
      items: result as unknown as JsonValue,
      totalCount,
      offset: startIndex,
      limit: limitN,
      hasMore,
    };
    // Emit nextCursor only when there is another page and we have a last id to anchor on.
    if (hasMore && result.length > 0) {
      const lastId = result[result.length - 1]!['id'];
      if (typeof lastId === 'string') {
        envelope['nextCursor'] = encodeCursor(lastId);
      }
    }
    return envelope as unknown as JsonValue;
  }

  return result;
}

/** Parse a comma-separated query param into a trimmed, non-empty string array. */
function parseCsvParam(param: string | string[] | undefined): string[] {
  if (param === undefined) return [];
  const raw = Array.isArray(param) ? param[0] ?? '' : param;
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * For each included field, resolve the ids stored in entity[field] against the graph
 * and embed the referenced entities under `_<field>`. The original id array is retained.
 */
function expandIncludes(entity: JsonObject, fields: readonly string[], graph: StateGraph): JsonObject {
  const result: JsonObject = { ...entity };
  for (const field of fields) {
    const ids = entity[field];
    if (!Array.isArray(ids)) continue;
    const embedded = ids
      .map(id => (typeof id === 'string' ? graph.get(id) : null))
      .filter((e): e is JsonObject => e !== null && e !== undefined);
    result[`_${field}`] = embedded as unknown as JsonValue;
  }
  return result;
}

/** Project an entity down to the selected fields. `id` is always preserved. */
function projectFields(entity: JsonObject, fields: readonly string[]): JsonObject {
  const keep = new Set<string>(fields);
  keep.add('id');
  const result: JsonObject = {};
  for (const key of keep) {
    if (key in entity) result[key] = entity[key]!;
  }
  return result;
}

/**
 * Scan the OpenAPI component schema for vendor-extension `x-derived` properties and compute
 * them via CEL evaluation, returning a new object with derived properties appended.
 * The original stored entity is not mutated.
 */
function applyDerivedProperties(
  entity: JsonObject,
  boundary: BoundaryConfig,
  openapi: OpenApiDoc,
  cel: CelEvaluator,
  log?: Logger,
): JsonObject {
  // Resolve the component schema for this boundary
  const raw = openapi.raw as Record<string, unknown>;
  const components = raw?.['components'] as Record<string, unknown> | undefined;
  const schemas = components?.['schemas'] as Record<string, unknown> | undefined;
  const boundarySchema = schemas?.[boundary.boundary] as Record<string, unknown> | undefined;

  if (!boundarySchema) {
    return entity;
  }

  const properties = boundarySchema['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!properties) {
    return entity;
  }

  // Collect all derived properties
  const derivedEntries: Array<[string, string]> = [];
  for (const [propName, propSchema] of Object.entries(properties)) {
    const xDerived = propSchema['x-derived'];
    if (typeof xDerived === 'string' && xDerived.trim().length > 0) {
      derivedEntries.push([propName, xDerived]);
    }
  }

  if (derivedEntries.length === 0) {
    return entity;
  }

  // Shallow-copy the entity and append computed derived properties
  const result: JsonObject = { ...entity };
  const celCtx: Record<string, unknown> = { state: entity as Record<string, unknown> };

  for (const [propName, expr] of derivedEntries) {
    try {
      const value = cel.evaluate(expr, celCtx, CelPhase.Behavior);
      result[propName] = value as JsonValue;
      log?.debug({ propName, boundary: boundary.boundary }, 'Derived property computed');
    } catch (err) {
      // Set to null rather than throwing: a bad x-derived expression should not abort
      // the entire query for a single field. Null is a detectable sentinel for callers.
      log?.warn({ propName, expr, err }, 'Derived property CEL evaluation failed — setting to null');
      result[propName] = null;
    }
  }

  return result;
}
