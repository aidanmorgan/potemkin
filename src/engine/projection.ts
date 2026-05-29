import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { DomainEvent, JsonObject, JsonValue } from '../types.js';
import type { BoundaryConfig } from '../dsl/types.js';
import type { StateGraph } from '../stategraph/graph.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { ContractValidator } from '../contract/validator.js';
import type { Logger } from '../observability/logger.js';
import type { Tracer } from '../observability/tracing.js';
import type { ObjectGraphSchemaRegistry } from '../schema/types.js';
import type { OpenApiDoc } from '../contract/loader.js';
import { deepClone, deepMerge } from '../stategraph/graph.js';
import { CelPhase } from '../cel/phases.js';
import { getTracer } from '../observability/tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';
import { InternalExecutionError } from '../errors.js';
import { guardAssignPath, guardAssignedValue } from '../schema/runtimeGuard.js';

// REQ-65: AJV instance for schema_ref payload validation (module-level, lazily initialized)
let _ajvForSchemaRef: Ajv | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _schemaRefValidatorCache = new Map<string, (data: unknown) => boolean>();

function getAjvForSchemaRef(): Ajv {
  if (!_ajvForSchemaRef) {
    _ajvForSchemaRef = new Ajv({ allErrors: true, strict: false });
    addFormats(_ajvForSchemaRef);
  }
  return _ajvForSchemaRef;
}

/**
 * REQ-65: Validate an event payload against an OpenAPI component schema_ref.
 * Resolves `#/components/schemas/X` style refs from the OpenAPI doc.
 */
function validatePayloadAgainstSchemaRef(
  payload: JsonObject,
  schemaRef: string,
  openapi: OpenApiDoc | undefined,
  eventType: string,
): void {
  if (!openapi) return; // If no openapi doc is available, skip (boot validates ref existence)

  // Parse `#/components/schemas/SomeSchema` ref
  const match = /^#\/components\/schemas\/(.+)$/.exec(schemaRef);
  if (!match) return; // Non-standard ref format — skip silently

  const schemaName = match[1];
  const rawDoc = openapi.raw as Record<string, unknown>;
  const components = rawDoc['components'] as Record<string, unknown> | undefined;
  const schemas = components?.['schemas'] as Record<string, unknown> | undefined;
  const schema = schemas?.[schemaName];

  if (!schema || typeof schema !== 'object') {
    throw new InternalExecutionError(
      `schema_ref "${schemaRef}" could not be resolved for event "${eventType}"`,
      { code: 'EVENT_PAYLOAD_VIOLATES_SCHEMA', eventType, schemaRef, errors: [] },
    );
  }

  const cacheKey = schemaRef;
  let validate = _schemaRefValidatorCache.get(cacheKey);
  if (!validate) {
    const compiled = getAjvForSchemaRef().compile(schema as object);
    // Store as a simple boolean-returning wrapper
    validate = (data: unknown) => compiled(data) as boolean;
    _schemaRefValidatorCache.set(cacheKey, validate);
  }

  const ajvInstance = getAjvForSchemaRef();
  const compiled = ajvInstance.compile(schema as object);
  const valid = compiled(payload);
  if (!valid) {
    throw new InternalExecutionError(
      `Event payload for "${eventType}" violates schema_ref "${schemaRef}"`,
      {
        code: 'EVENT_PAYLOAD_VIOLATES_SCHEMA',
        eventType,
        schemaRef,
        errors: compiled.errors as JsonValue,
      },
    );
  }
}

// REQ-67: sentinel prefix — defense-in-depth for reducer phase
const TS_SENTINEL = 'ts:';

export interface ProjectionInput {
  readonly event: DomainEvent;
  readonly boundary: BoundaryConfig;
  /** The graph to read from and write the projected state into. */
  readonly graph: StateGraph;
  readonly cel: CelEvaluator;
  /** Optional validator; when provided the mutated buffer is validated before the atomic swap. */
  readonly validator?: ContractValidator;
  /** Optional logger for projection traces. */
  readonly logger?: Logger;
  /** Optional schema registry for runtime type-checking of assign/append operations. */
  readonly schemaRegistry?: ObjectGraphSchemaRegistry;
  /**
   * Optional tracer for the engine.project span. When provided, the span is emitted
   * via this tracer (enabling injection by UoW for testability). Falls back to
   * getTracer('engine') when absent.
   */
  readonly tracer?: Tracer;
  /** REQ-65: Optional OpenAPI document for schema_ref payload validation. */
  readonly openapi?: OpenApiDoc;
}

/**
 * Project a single domain event onto the state graph via the matching reducer rule.
 *
 * Algorithm:
 *  1. Deep-clone the current entity state (or start from `{}`).
 *  2. If event is `System.GenericUpdateEvent`: deep-merge payload onto buffer.
 *     If event is `BaselineEntityCreatedEvent`: replace buf with payload directly.
 *     Otherwise: execute `assign` / `append` CEL expressions from the matching reducer.
 *  3. Validate the buffer with `validator.validateEntity` if a validator is provided.
 *  4. Atomic swap the state graph entry.
 *
 * @throws {InternalExecutionError} (500) if CEL evaluation or validation fails.
 */
export function projectEvent(input: ProjectionInput): void {
  // O-5 fix: use injected tracer when provided (enables span capture in tests).
  // Falls back to getTracer('engine') for production/boot/reset paths.
  const tracer = input.tracer ?? getTracer('engine');
  tracer.startActiveSpan('engine.project', (span) => {
    try {
      _projectEvent(input);
    } catch (err) {
      if (err instanceof Error) span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.end();
      throw err;
    }
    span.end();
  });
}

function _projectEvent(input: ProjectionInput): void {
  const { event, boundary, graph, cel, validator, logger, schemaRegistry, openapi } = input;
  const log = logger?.child({
    component: 'projection',
    eventId: event.eventId,
    eventType: event.type,
    aggregateId: event.aggregateId,
    boundary: event.boundary,
  });

  // Step 1: Memory Isolation — deep-clone current state or start fresh
  const current = graph.get(event.aggregateId);
  const buf: JsonObject = deepClone(current ?? {});

  try {
    // Step 2: Reducer Evaluation
    if (event.type === 'System.GenericUpdateEvent') {
      // JSON merge fallback — deep-merge payload into buf in-place
      mergeInPlace(buf, event.payload);
      log?.debug({ payloadKeys: Object.keys(event.payload) }, 'Applied GenericUpdateEvent via deep-merge');
    } else if (event.type === 'BaselineEntityCreatedEvent') {
      // Replace buffer entirely with payload
      replaceInPlace(buf, event.payload);
      log?.debug({}, 'Applied BaselineEntityCreatedEvent — replaced state with payload');
    } else {
      // Find matching reducers (by event type key)
      const matchingReducers = boundary.reducers.filter(r => r.on === event.type);

      for (const reducer of matchingReducers) {
        const celCtx = {
          event: event as unknown as Record<string, unknown>,
          state: buf as Record<string, unknown>,
          payload: event.payload,
        };

        // Process assign expressions
        if (reducer.assign) {
          for (const [dotPath, expr] of Object.entries(reducer.assign)) {
            if (schemaRegistry) {
              guardAssignPath(schemaRegistry, boundary.boundary, dotPath);
            }

            // REQ-71 defense-in-depth: reject ts: in reducer phase at runtime
            if (expr.startsWith(TS_SENTINEL)) {
              throw new InternalExecutionError(
                `ts: sentinel "${expr}" in reducer assign path "${dotPath}" — forbidden in Reducer phase (REQ-71)`,
                { code: 'SCRIPT_IN_REDUCER_PHASE', dotPath, expr },
              );
            }

            let value: JsonValue;
            try {
              value = cel.evaluate(expr, celCtx, CelPhase.Reducer) as JsonValue;
            } catch (err) {
              throw new InternalExecutionError(
                `CEL evaluation failed for assign path '${dotPath}': ${err instanceof Error ? err.message : String(err)}`,
                { dotPath, expr, eventType: event.type },
              );
            }

            // N3 fix: explicitly reject undefined to preserve JsonObject type contract.
            // CEL returning undefined (e.g. accessing a missing field) must not silently
            // store undefined on the entity, which would violate the JsonValue contract.
            if (value === undefined) {
              throw new InternalExecutionError(
                `CEL expression returned undefined for assign path '${dotPath}' — this violates the JsonObject contract`,
                { code: 'SCHEMA_TYPE_MISMATCH', reason: 'CEL expression returned undefined', dotPath, expr, eventType: event.type },
              );
            }

            if (schemaRegistry) {
              guardAssignedValue(schemaRegistry, boundary.boundary, dotPath, value);
            }

            setByDotPath(buf, dotPath, value);
            log?.debug({ dotPath, value }, 'Assigned value via reducer');
          }
        }

        // Process append expressions
        if (reducer.append) {
          for (const [dotPath, expr] of Object.entries(reducer.append)) {
            if (schemaRegistry) {
              guardAssignPath(schemaRegistry, boundary.boundary, dotPath);
            }

            // REQ-71 defense-in-depth
            if (expr.startsWith(TS_SENTINEL)) {
              throw new InternalExecutionError(
                `ts: sentinel "${expr}" in reducer append path "${dotPath}" — forbidden in Reducer phase (REQ-71)`,
                { code: 'SCRIPT_IN_REDUCER_PHASE', dotPath, expr },
              );
            }

            let value: JsonValue;
            try {
              value = cel.evaluate(expr, celCtx, CelPhase.Reducer) as JsonValue;
            } catch (err) {
              throw new InternalExecutionError(
                `CEL evaluation failed for append path '${dotPath}': ${err instanceof Error ? err.message : String(err)}`,
                { dotPath, expr, eventType: event.type },
              );
            }

            if (schemaRegistry) {
              guardAssignedValue(schemaRegistry, boundary.boundary, dotPath, value, 'append');
            }

            const existing = getByDotPath(buf, dotPath);
            const arr: JsonValue[] = Array.isArray(existing) ? [...existing] : [];
            arr.push(value);
            setByDotPath(buf, dotPath, arr);
            log?.debug({ dotPath, value }, 'Appended value via reducer');
          }
        }
      }
    }

    // Step 3: REQ-65 Event payload schema_ref validation
    // Only for non-system events that have a catalog entry with schema_ref
    if (event.type !== 'System.GenericUpdateEvent' && event.type !== 'BaselineEntityCreatedEvent') {
      const catalogEntry = boundary.eventCatalog.find(e => e.type === event.type);
      if (catalogEntry?.schemaRef) {
        validatePayloadAgainstSchemaRef(event.payload, catalogEntry.schemaRef, openapi, event.type);
        log?.debug({ schemaRef: catalogEntry.schemaRef, eventType: event.type }, 'Event payload validated against schema_ref');
      }
    }

    // Audit fields: only inject when the boundary opts in (boundary.auditFields=true).
    // This keeps strict OpenAPI contracts that don't declare updatedAt/updatedBy from
    // failing response validation by default.
    if (event.type !== 'BaselineEntityCreatedEvent' && boundary.auditFields === true) {
      buf['updatedAt'] = event.timestamp;
      const actorId = event.request?.actorId;
      buf['updatedBy'] = actorId ?? null;
    }

    // Step 4: Integrity Validation
    if (validator) {
      validator.validateEntity(event.boundary, buf);
    }

    // Step 5: Atomic Swap
    graph.set(event.aggregateId, buf);
    log?.info({ aggregateId: event.aggregateId, eventType: event.type }, 'Projection applied successfully');
  } catch (err) {
    log?.error({ err, aggregateId: event.aggregateId, eventType: event.type }, 'Projection failed — aborting');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Dot-path helpers (support `a.b.c` and `a.b[0].c` notation)
// ---------------------------------------------------------------------------

/**
 * Set a value at a dot-notation path on an object.
 * Supports both `a.b.c` and `a.b[0].c` notation.
 * Initializes missing intermediate objects/arrays as needed.
 */
export function setByDotPath(obj: JsonObject, path: string, value: JsonValue): void {
  if (!path || path.trim() === '') {
    throw new InternalExecutionError('Empty assign path');
  }
  const parts = parsePath(path);
  if (parts.length === 0) return;

  let current: JsonValue = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current === null || typeof current !== 'object') {
      return; // Can't navigate further
    }

    if (Array.isArray(current)) {
      const idx = typeof part === 'number' ? part : parseInt(String(part), 10);
      if (isNaN(idx)) return;
      if (current[idx] == null) {
        const nextPart = parts[i + 1];
        current[idx] = typeof nextPart === 'number' ? [] : {};
      }
      current = current[idx] as JsonValue;
    } else {
      const key = String(part);
      if ((current as JsonObject)[key] == null) {
        const nextPart = parts[i + 1];
        (current as JsonObject)[key] = typeof nextPart === 'number' ? [] : {};
      }
      current = (current as JsonObject)[key] as JsonValue;
    }
  }

  const lastPart = parts[parts.length - 1];
  if (current === null || typeof current !== 'object') return;

  if (Array.isArray(current)) {
    const idx = typeof lastPart === 'number' ? lastPart : parseInt(String(lastPart), 10);
    if (!isNaN(idx)) current[idx] = value;
  } else {
    (current as JsonObject)[String(lastPart)] = value;
  }
}

/**
 * Get a value at a dot-notation path from an object.
 * Supports both `a.b.c` and `a.b[0].c` notation.
 * Returns undefined if the path does not exist.
 */
export function getByDotPath(obj: JsonObject, path: string): JsonValue | undefined {
  const parts = parsePath(path);
  let current: JsonValue = obj;

  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;

    if (Array.isArray(current)) {
      const idx = typeof part === 'number' ? part : parseInt(String(part), 10);
      if (isNaN(idx)) return undefined;
      current = current[idx] as JsonValue;
    } else {
      current = (current as JsonObject)[String(part)] as JsonValue;
    }
  }

  return current;
}

/**
 * Parse a dot-path string like `a.b[0].c` into segments like `['a', 'b', 0, 'c']`.
 */
function parsePath(path: string): Array<string | number> {
  const parts: Array<string | number> = [];
  // Split on dots, then handle bracket notation
  const segments = path.split('.');
  for (const seg of segments) {
    // Match `name[idx]` patterns
    const bracketMatch = /^([^\[]+)(\[\d+\])+$/.exec(seg);
    if (bracketMatch) {
      parts.push(bracketMatch[1]);
      const indices = [...seg.matchAll(/\[(\d+)\]/g)];
      for (const m of indices) {
        parts.push(parseInt(m[1], 10));
      }
    } else {
      parts.push(seg);
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// In-place mutation helpers that delegate to the canonical graph utilities
// ---------------------------------------------------------------------------

/**
 * Deep-merge `source` into `target` in-place, reusing the canonical `deepMerge`
 * from the stategraph module so there is a single implementation site.
 */
function mergeInPlace(target: JsonObject, source: JsonObject): void {
  const merged = deepMerge(target, source);
  replaceInPlace(target, merged);
}

/**
 * Replace all keys of `target` with those of `source` in-place.
 * Delegates per-value cloning to the canonical `deepClone` from stategraph.
 */
function replaceInPlace(target: JsonObject, source: JsonObject): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  for (const [key, val] of Object.entries(source)) {
    target[key] = deepClone(val as JsonValue);
  }
}
