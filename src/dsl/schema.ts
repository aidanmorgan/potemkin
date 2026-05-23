import { BootError } from '../errors.js';
import type { JsonObject } from '../types.js';
import type {
  BehaviorRule,
  BoundaryConfig,
  EventCatalogEntry,
  IdentityConfig,
  ReducerRule,
  SecondaryCommandSpec,
} from './types.js';
import { createCelEvaluator } from '../cel/evaluator.js';

// F-04: Module-level CEL evaluator used to pre-check dispatch_commands payload
// values for syntactic validity at boot/compile time. This surfaces CEL parse
// errors as BOOT_ERR_DSL_SYNTAX rather than deferring them to runtime.
const celEvaluator = createCelEvaluator();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: field "${key}" must be a non-empty string (got ${JSON.stringify(v)})`,
      { field: key, context: ctx },
    );
  }
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string, ctx: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: optional field "${key}" must be a string (got ${JSON.stringify(v)})`,
      { field: key, context: ctx },
    );
  }
  return v;
}

function requireStringStringMap(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
): Record<string, string> | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (!isRecord(v)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: field "${key}" must be an object (got ${JSON.stringify(v)})`,
      { field: key, context: ctx },
    );
  }
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: field "${key}.${k}" must be a string (got ${JSON.stringify(val)})`,
        { field: `${key}.${k}`, context: ctx },
      );
    }
  }
  return v as Record<string, string>;
}

// Validates a map where values are either strings or objects (for append blocks).
function requireStringMixedMap(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
): Record<string, string> | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (!isRecord(v)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: field "${key}" must be an object (got ${JSON.stringify(v)})`,
      { field: key, context: ctx },
    );
  }
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string' && !isRecord(val)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: field "${key}.${k}" must be a string or object (got ${JSON.stringify(val)})`,
        { field: `${key}.${k}`, context: ctx },
      );
    }
  }
  // Serialise object values as JSON strings (CEL-compatible representation)
  const result: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    result[k] = typeof val === 'string' ? val : JSON.stringify(val);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sub-validators
// ---------------------------------------------------------------------------

function validateSecondaryCommandSpec(raw: unknown, ctx: string): SecondaryCommandSpec {
  if (!isRecord(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: dispatch_commands entry must be an object`,
      { context: ctx },
    );
  }
  const boundary = requireString(raw, 'boundary', ctx);
  const intentRaw = requireString(raw, 'intent', ctx);
  if (intentRaw !== 'creation' && intentRaw !== 'mutation' && intentRaw !== 'query') {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: intent must be one of creation|mutation|query (got "${intentRaw}")`,
      { field: 'intent', value: intentRaw, context: ctx },
    );
  }
  const targetId = requireString(raw, 'target_id', ctx);
  const payload = requireStringStringMap(raw, 'payload', ctx);

  // F-04: Pre-compile each CEL expression in payload values to catch syntax errors
  // at boot time rather than deferring them to runtime evaluation.
  if (payload !== undefined) {
    for (const [fieldKey, celExpr] of Object.entries(payload)) {
      try {
        celEvaluator.compile(celExpr);
      } catch (err) {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `${ctx}: payload field "${fieldKey}" is not a valid CEL expression: ${err instanceof Error ? err.message : String(err)}`,
          { field: `payload.${fieldKey}`, context: ctx, expression: celExpr },
        );
      }
    }
  }

  return {
    boundary,
    intent: intentRaw,
    targetId,
    ...(payload !== undefined ? { payload } : {}),
  };
}

function validateBehaviorRule(raw: unknown, index: number): BehaviorRule {
  const ctx = `behaviors[${index}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  const name = requireString(raw, 'name', ctx);
  const matchRaw = raw['match'];
  if (!isRecord(matchRaw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "match" must be an object`,
      { field: 'match', context: ctx },
    );
  }
  const intentRaw = requireString(matchRaw, 'intent', `${ctx}.match`);
  if (intentRaw !== 'creation' && intentRaw !== 'mutation' && intentRaw !== 'query') {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}.match.intent must be one of creation|mutation|query (got "${intentRaw}")`,
      { field: 'match.intent', value: intentRaw, context: ctx },
    );
  }
  const condition = requireString(matchRaw, 'condition', `${ctx}.match`);
  // F-06: Per design §7.2, `emit` is the mandatory link to the event catalog.
  // Every behavior MUST emit an event; use `dispatch_commands` only for secondary
  // effects that follow the primary event emission, not as a substitute for it.
  const emitRaw = raw['emit'];
  if (typeof emitRaw !== 'string' || emitRaw.trim() === '') {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: field "emit" must be a non-empty string (got ${JSON.stringify(emitRaw)}). ` +
        `Per §7.2, every behavior must emit an event from the event_catalog. ` +
        `Use "dispatch_commands" for secondary effects only, not as a substitute for "emit".`,
      { field: 'emit', context: ctx },
    );
  }
  const emit: string = emitRaw;

  let dispatchCommands: readonly SecondaryCommandSpec[] | undefined;
  const dispatchRaw = raw['dispatch_commands'];
  if (dispatchRaw !== undefined && dispatchRaw !== null) {
    if (!Array.isArray(dispatchRaw)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: "dispatch_commands" must be an array`,
        { field: 'dispatch_commands', context: ctx },
      );
    }
    dispatchCommands = dispatchRaw.map((item, i) =>
      validateSecondaryCommandSpec(item, `${ctx}.dispatch_commands[${i}]`),
    );
  }

  return {
    name,
    match: { intent: intentRaw, condition },
    emit,
    ...(dispatchCommands !== undefined ? { dispatchCommands } : {}),
  };
}

function validateReducerRule(raw: unknown, index: number): ReducerRule {
  const ctx = `reducers[${index}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  const on = requireString(raw, 'on', ctx);
  const assign = requireStringStringMap(raw, 'assign', ctx);
  const append = requireStringMixedMap(raw, 'append', ctx);
  return {
    on,
    ...(assign !== undefined ? { assign } : {}),
    ...(append !== undefined ? { append } : {}),
  };
}

function validateEventCatalogEntry(raw: unknown, index: number): EventCatalogEntry {
  const ctx = `event_catalog[${index}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  const type = requireString(raw, 'type', ctx);
  const payloadTemplate = requireStringStringMap(raw, 'payload_template', ctx) ?? {};
  return { type, payloadTemplate };
}

function validateIdentityConfig(raw: unknown, ctx: string): IdentityConfig {
  if (!isRecord(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "identity" must be an object`,
      { field: 'identity', context: ctx },
    );
  }
  const creationRaw = raw['creation'];
  if (creationRaw === undefined || creationRaw === null) {
    return {};
  }
  if (!isRecord(creationRaw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "identity.creation" must be an object`,
      { field: 'identity.creation', context: ctx },
    );
  }
  const generate = optionalString(creationRaw, 'generate', `${ctx}.creation`);
  return { creation: { ...(generate !== undefined ? { generate } : {}) } };
}

function validateInitialization(raw: unknown, ctx: string): readonly JsonObject[] {
  if (!Array.isArray(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "initialization" must be an array`,
      { field: 'initialization', context: ctx },
    );
  }
  return raw.map((item, i) => {
    if (!isRecord(item)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.initialization[${i}]: must be an object`,
        { context: ctx },
      );
    }
    return item as JsonObject;
  });
}

// ---------------------------------------------------------------------------
// Cross-reference validation
// ---------------------------------------------------------------------------

function crossValidate(config: {
  behaviors: readonly BehaviorRule[];
  reducers: readonly ReducerRule[];
  eventCatalog: readonly EventCatalogEntry[];
  boundary: string;
}): void {
  const catalogTypes = new Set(config.eventCatalog.map((e) => e.type));

  for (const behavior of config.behaviors) {
    if (!catalogTypes.has(behavior.emit)) {
      throw new BootError(
        'BOOT_ERR_DSL_REFERENCE',
        `Boundary "${config.boundary}": behavior "${behavior.name}" emits unknown event type "${behavior.emit}" (not in event_catalog)`,
        { boundary: config.boundary, behavior: behavior.name, missingType: behavior.emit },
      );
    }
  }

  for (const reducer of config.reducers) {
    if (!catalogTypes.has(reducer.on)) {
      throw new BootError(
        'BOOT_ERR_DSL_REFERENCE',
        `Boundary "${config.boundary}": reducer subscribed to unknown event type "${reducer.on}" (not in event_catalog)`,
        { boundary: config.boundary, missingType: reducer.on },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a raw (unknown) object against the BoundaryConfig schema.
 * Converts snake_case YAML keys to camelCase TypeScript fields.
 * @throws {BootError} with code `BOOT_ERR_DSL_SYNTAX` if the shape is invalid.
 * @throws {BootError} with code `BOOT_ERR_DSL_REFERENCE` if cross-references are broken.
 */
export function validateBoundaryConfig(raw: unknown): BoundaryConfig {
  if (!isRecord(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      'DSL module root must be a YAML mapping object',
      { received: typeof raw },
    );
  }

  // Required top-level fields
  const boundary = requireString(raw, 'boundary', 'root');
  const contractPath = requireString(raw, 'contract_path', 'root');

  // Optional top-level fields
  const fallbackOverrideRaw = raw['fallback_override'];
  let fallbackOverride = false;
  if (fallbackOverrideRaw !== undefined && fallbackOverrideRaw !== null) {
    if (typeof fallbackOverrideRaw !== 'boolean') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `root: "fallback_override" must be a boolean (got ${JSON.stringify(fallbackOverrideRaw)})`,
        { field: 'fallback_override' },
      );
    }
    fallbackOverride = fallbackOverrideRaw;
  }

  let identity: IdentityConfig | undefined;
  if (raw['identity'] !== undefined && raw['identity'] !== null) {
    identity = validateIdentityConfig(raw['identity'], 'root');
  }

  const queryMapping = requireStringStringMap(raw, 'query_mapping', 'root');

  // Arrays — default to empty
  const behaviorsRaw = raw['behaviors'];
  let behaviors: readonly BehaviorRule[] = [];
  if (behaviorsRaw !== undefined && behaviorsRaw !== null) {
    if (!Array.isArray(behaviorsRaw)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        'root: "behaviors" must be an array',
        { field: 'behaviors' },
      );
    }
    behaviors = behaviorsRaw.map((item, i) => validateBehaviorRule(item, i));
  }

  const reducersRaw = raw['reducers'];
  let reducers: readonly ReducerRule[] = [];
  if (reducersRaw !== undefined && reducersRaw !== null) {
    if (!Array.isArray(reducersRaw)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        'root: "reducers" must be an array',
        { field: 'reducers' },
      );
    }
    reducers = reducersRaw.map((item, i) => validateReducerRule(item, i));
  }

  const eventCatalogRaw = raw['event_catalog'];
  let eventCatalog: readonly EventCatalogEntry[] = [];
  if (eventCatalogRaw !== undefined && eventCatalogRaw !== null) {
    if (!Array.isArray(eventCatalogRaw)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        'root: "event_catalog" must be an array',
        { field: 'event_catalog' },
      );
    }
    eventCatalog = eventCatalogRaw.map((item, i) => validateEventCatalogEntry(item, i));
  }

  let initialization: readonly JsonObject[] | undefined;
  if (raw['initialization'] !== undefined && raw['initialization'] !== null) {
    initialization = validateInitialization(raw['initialization'], 'root');
  }

  // Cross-reference validation
  crossValidate({ behaviors, reducers, eventCatalog, boundary });

  return {
    boundary,
    contractPath,
    fallbackOverride,
    ...(identity !== undefined ? { identity } : {}),
    ...(queryMapping !== undefined ? { queryMapping } : {}),
    behaviors,
    reducers,
    eventCatalog,
    ...(initialization !== undefined ? { initialization } : {}),
  };
}
