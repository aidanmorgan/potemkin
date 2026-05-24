import type { DomainEvent, JsonObject, JsonValue } from '../types.js';
import type { BoundaryConfig } from '../dsl/types.js';
import type { StateGraph } from '../stategraph/graph.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { ContractValidator } from '../contract/validator.js';
import type { Logger } from '../observability/logger.js';
import type { Tracer } from '../observability/tracing.js';
import type { ObjectGraphSchemaRegistry } from '../schema/types.js';
import { deepClone, deepMerge } from '../stategraph/graph.js';
import { CelPhase } from '../cel/phases.js';
import { getTracer } from '../observability/tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';
import { InternalExecutionError } from '../errors.js';
import { guardAssignPath, guardAssignedValue } from '../schema/runtimeGuard.js';

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
  const { event, boundary, graph, cel, validator, logger, schemaRegistry } = input;
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

    // Step 3: Integrity Validation
    if (validator) {
      validator.validateEntity(event.boundary, buf);
    }

    // Step 4: Atomic Swap
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
