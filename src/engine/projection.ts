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
import { applyPatches, type JournalEntry, type Patch } from '../dsl/patches.js';
import { applyReducerPatchList } from './reducerPatches.js';
import type { TsReducerRegistry } from './tsReducerRegistry.js';
import type { ReducerContext, RegisteredReducer } from '../sdk/index.js';
import { recomputeComputedFields } from '../dsl/schemaInference.js';
import type { DeclaredComputedField } from '../dsl/schemaInference.js';
import type { CelContext } from '../cel/evaluator.js';
import { CelPhase } from '../cel/phases.js';
import { guardAssignedValue } from '../schema/runtimeGuard.js';
import { getTracer } from '../observability/tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';
import { InternalExecutionError } from '../errors.js';

// schema_ref payload validation owns no module-level mutable state (no shared
// Ajv singleton, no ref-string-keyed cache). A ref string like
// `#/components/schemas/X` is only unique within one OpenAPI document, so caching
// by ref string would collide across concurrently booted systems. Any cache we
// keep is therefore keyed by the resolved schema *object identity* via a WeakMap,
// which is safe across systems and lets schemas be garbage-collected with their
// OpenAPI doc. The WeakMap also carries the Ajv instance that compiled the
// validator, since an Ajv-compiled validator is bound to its owning instance.
const _schemaValidatorByObject = new WeakMap<object, (data: unknown) => boolean>();

function compileSchemaValidator(schema: object): (data: unknown) => boolean {
  const cached = _schemaValidatorByObject.get(schema);
  if (cached) return cached;
  // Build a per-schema Ajv: avoids a long-lived shared singleton and keeps each
  // compiled validator bound to the instance that produced it.
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const compiled = ajv.compile(schema);
  const validate = (data: unknown): boolean => {
    const ok = compiled(data) as boolean;
    // Surface the last-run errors on the wrapper so callers can read them.
    (validate as { errors?: unknown }).errors = compiled.errors;
    return ok;
  };
  _schemaValidatorByObject.set(schema, validate);
  return validate;
}

/**
 * Validate an event payload against an OpenAPI component schema_ref.
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
      { code: 'SCHEMA_TYPE_MISMATCH', eventType, schemaRef, errors: [] },
    );
  }

  const validate = compileSchemaValidator(schema as object);
  const valid = validate(payload);
  if (!valid) {
    throw new InternalExecutionError(
      `Event payload for "${eventType}" violates schema_ref "${schemaRef}"`,
      {
        code: 'SCHEMA_TYPE_MISMATCH',
        eventType,
        schemaRef,
        errors: (validate as { errors?: unknown }).errors as JsonValue,
      },
    );
  }
}

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
  /** Optional OpenAPI document for schema_ref payload validation. */
  readonly openapi?: OpenApiDoc;
  /**
   * TypeScript-reducer registry. When a (boundary, event) is registered
   * here it OVERRIDES the YAML reducer: the TS reducer runs and its returned
   * Patch[] flows through the same applyPatches path. YAML patches are used
   * only on a registry miss.
   */
  readonly tsReducerRegistry?: TsReducerRegistry;
  /**
   * Declared computed fields + their topological recompute order for this
   * boundary. When supplied, after reducer patches apply, computed fields whose
   * dependsOn intersects the touched paths are recomputed in order against
   * post-patch state. A formula error aborts projection (500), preserving atomicity.
   */
  readonly computed?: readonly DeclaredComputedField[];
  readonly computedOrder?: readonly string[];
}

/** Outcome of projecting a single event. */
export interface ProjectionResult {
  /**
   * Patch journal produced by the matching reducer(s). Every entry carries
   * `source: 'reducer'` because reducer patches are applied via the single
   * canonical applier in src/dsl/patches.ts.
   */
  readonly journal: readonly JournalEntry[];
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
export function projectEvent(input: ProjectionInput): ProjectionResult {
  const tracer = input.tracer ?? getTracer('engine');
  let result: ProjectionResult = { journal: [] };
  tracer.startActiveSpan('engine.project', (span) => {
    try {
      result = _projectEvent(input);
    } catch (err) {
      if (err instanceof Error) span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.end();
      throw err;
    }
    span.end();
  });
  return result;
}

function _projectEvent(input: ProjectionInput): ProjectionResult {
  const { event, boundary, graph, cel, validator, logger, schemaRegistry, openapi, tsReducerRegistry } = input;
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

  // Journal of reducer patches applied to this event (source='reducer').
  const reducerJournal: JournalEntry[] = [];

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
      // A registered TypeScript reducer for this (boundary, event) runs in place
      // of the YAML reducer; its returned Patch[] flows through the same
      // applyPatches path. YAML patches are consulted only on a registry miss.
      const tsReducer = tsReducerRegistry?.get(boundary.boundary, event.type);
      if (tsReducer) {
        const patches = runTsReducer(tsReducer, buf, event, cel);
        const result = applyPatches(buf, patches, 'reducer', { autoVivify: true });
        replaceInPlace(buf, result.newState as JsonObject);
        reducerJournal.push(...result.journal);
        log?.debug({ patchCount: patches.length, source: tsReducer.source }, 'Applied TS reducer');
      } else {
        // Find matching reducers (by event type key)
        const matchingReducers = boundary.reducers.filter(r => r.on === event.type);

        for (const reducer of matchingReducers) {
          const celCtx = {
            event: event as unknown as Record<string, unknown>,
            state: buf as Record<string, unknown>,
            payload: event.payload,
          };

          // Reducers express state mutation exclusively as a `patches:` list,
          // applied via the single canonical applier (src/dsl/patches.ts). Each
          // patch's value is evaluated as CEL against the state as mutated by
          // prior patches in the list, so later patches can reference earlier
          // ones (e.g. `state.totalConversions + 1`).
          if (reducer.patches) {
            reducerJournal.push(...applyReducerPatchList(buf, reducer.patches, cel, celCtx));
          }
        }
      }

      // Runtime type guard: for every value-bearing patch that landed on a
      // schema-declared field, assert the written value is assignable to that
      // field's type. guardAssignedValue silently ignores paths absent from the
      // schema (audit/computed fields), so it only rejects genuine type
      // mismatches. This runs during shadow projection (schemaRegistry is
      // supplied there), so a mismatch aborts the unit of work before any event
      // is committed.
      if (schemaRegistry) {
        for (const entry of reducerJournal) {
          if (entry.value === undefined) continue; // remove / increment (no value)
          if (
            entry.op !== 'add' &&
            entry.op !== 'replace' &&
            entry.op !== 'append' &&
            entry.op !== 'prepend'
          ) {
            continue; // merge/upsert carry composite values — validated by the entity contract
          }
          const dotPath = entry.path.replace(/^\//, '').replace(/\//g, '.');
          const mode = entry.op === 'append' || entry.op === 'prepend' ? 'append' : 'assign';
          guardAssignedValue(schemaRegistry, boundary.boundary, dotPath, entry.value, mode);
        }
      }

      // Recompute declared computed fields against post-patch state, in topological
      // order, but only those whose dependsOn intersects the paths the reducer
      // just touched. A formula error propagates out of projectEvent (the candidate
      // buffer is never swapped into the graph), so the event is rejected with 500.
      if (input.computed && input.computed.length > 0 && input.computedOrder) {
        const touchedPaths = new Set<string>(reducerJournal.map((j) => j.path));
        recomputeComputedFields(
          buf as Record<string, unknown>,
          input.computed,
          input.computedOrder,
          touchedPaths,
          { evaluate: (formula, ctx) => cel.evaluate(formula, ctx as unknown as CelContext, CelPhase.Reducer) },
        );
      }
    }

    // Step 3: Event payload schema_ref validation (non-system events only)
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

  return { journal: reducerJournal };
}

// ---------------------------------------------------------------------------
// TypeScript reducer invocation
// ---------------------------------------------------------------------------

/**
 * Invoke a registered TS reducer against the post-state buffer and the event.
 * The reducer must return an array of Patch objects; any non-array return is a
 * RUNTIME_ERR_REDUCER_NON_ARRAY (HTTP 500). The reducer sees a deep clone of
 * the state so it cannot mutate the buffer out from under applyPatches.
 */
function runTsReducer(
  reducer: RegisteredReducer,
  state: JsonObject,
  event: DomainEvent,
  cel: CelEvaluator,
): Patch[] {
  const ctx: ReducerContext = {
    now: () => new Date(Date.now() + cel.getClockOffset()).toISOString(),
    log: {
      info: () => { /* reducer logs are swallowed at projection time */ },
      warn: () => { /* swallowed */ },
      debug: () => { /* swallowed */ },
    },
  };
  const returned = reducer.fn(deepClone(state), event as unknown, ctx);
  if (!Array.isArray(returned)) {
    throw new InternalExecutionError(
      `TS reducer (${reducer.source}) for ${reducer.boundary}:${reducer.event} did not return an array of patches`,
      {
        code: 'RUNTIME_ERR_REDUCER_NON_ARRAY',
        boundary: reducer.boundary,
        event: reducer.event,
        source: reducer.source,
        returnedType: returned === null ? 'null' : typeof returned,
      },
    );
  }
  return returned as Patch[];
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

