import { BootError } from '../errors.js';
import type { JsonObject } from '../types.js';
import type {
  BehaviorRule,
  BoundaryConfig,
  EmitWhenEntry,
  EventCatalogEntry,
  IdentityConfig,
  ReducerRule,
  RequiresGuard,
  ScriptDeclaration,
  SecondaryCommandSpec,
} from './types.js';
import { createCelEvaluator } from '../cel/evaluator.js';

// F-04: Module-level CEL evaluator used to pre-check dispatch_commands payload
// values for syntactic validity at boot/compile time. This surfaces CEL parse
// errors as BOOT_ERR_DSL_SYNTAX rather than deferring them to runtime.
const celEvaluator = createCelEvaluator();

// REQ-67: sentinel prefix for inline TypeScript references
const TS_SENTINEL = 'ts:';
// REQ-67: valid script name pattern after the ts: prefix
const TS_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

/**
 * Validate a CEL expression or ts: sentinel for non-reducer phases.
 * ts: sentinels in REDUCER positions are rejected at boot (REQ-71).
 */
function validateCelOrScript(
  value: string,
  fieldCtx: string,
  phase: 'behavior' | 'eventHydration' | 'reducer',
): void {
  if (value.startsWith(TS_SENTINEL)) {
    if (phase === 'reducer') {
      throw new BootError(
        'BOOT_ERR_SCRIPT_IN_REDUCER',
        `${fieldCtx}: ts: sentinel is not allowed in Reducer-phase fields (REQ-71). Value: "${value}"`,
        { field: fieldCtx, value },
      );
    }
    // Validate the name portion
    const scriptName = value.slice(TS_SENTINEL.length);
    if (!TS_NAME_RE.test(scriptName)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${fieldCtx}: ts: sentinel has invalid script name "${scriptName}" (must match [A-Za-z_][A-Za-z0-9_]*)`,
        { field: fieldCtx, value },
      );
    }
    return; // ts: references are not CEL — skip CEL compile
  }

  // Validate as CEL
  try {
    celEvaluator.compile(value);
  } catch (err) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${fieldCtx}: not a valid CEL expression: ${err instanceof Error ? err.message : String(err)}`,
      { field: fieldCtx, expression: value },
    );
  }
}

// ---------------------------------------------------------------------------
// Sub-validators
// ---------------------------------------------------------------------------

function validateRequiresGuard(raw: unknown, ctx: string): RequiresGuard {
  if (!isRecord(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: requires entry must be an object`,
      { context: ctx },
    );
  }
  const name = requireString(raw, 'name', ctx);
  // Support both "condition" (task spec) and "expression" (design.md) field names
  const conditionRaw = raw['condition'] ?? raw['expression'];
  if (typeof conditionRaw !== 'string' || conditionRaw.trim() === '') {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: requires entry must have a non-empty "condition" (or "expression") field`,
      { context: ctx },
    );
  }
  const condition: string = conditionRaw;
  validateCelOrScript(condition, `${ctx}.condition`, 'behavior');

  // Support both camelCase and snake_case for error_code / error_message
  const errorCodeRaw = raw['error_code'] ?? raw['errorCode'];
  const errorMessageRaw = raw['error_message'] ?? raw['errorMessage'];

  const errorCode = typeof errorCodeRaw === 'string' ? errorCodeRaw : '';
  const errorMessage = typeof errorMessageRaw === 'string' ? errorMessageRaw : '';

  // "message" field is also accepted (design.md uses message)
  const messageRaw = raw['message'];
  const resolvedMessage = errorMessage !== '' ? errorMessage : (typeof messageRaw === 'string' ? messageRaw : '');

  return { name, condition, errorCode, errorMessage: resolvedMessage };
}

function validateEmitWhenEntry(raw: unknown, ctx: string): EmitWhenEntry {
  if (!isRecord(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: emit_when entry must be an object`,
      { context: ctx },
    );
  }
  const when = requireString(raw, 'when', ctx);
  const emit = requireString(raw, 'emit', ctx);
  validateCelOrScript(when, `${ctx}.when`, 'behavior');
  return { when, emit };
}

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

  // REQ-63: optional condition for dispatch gating
  const condition = optionalString(raw, 'condition', ctx);
  if (condition !== undefined) {
    validateCelOrScript(condition, `${ctx}.condition`, 'behavior');
  }

  // F-04: Pre-compile each CEL expression in payload values to catch syntax errors
  // at boot time rather than deferring them to runtime evaluation.
  if (payload !== undefined) {
    for (const [fieldKey, celExpr] of Object.entries(payload)) {
      // Skip ts: sentinels (they're validated separately)
      if (!celExpr.startsWith(TS_SENTINEL)) {
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
  }

  return {
    boundary,
    intent: intentRaw,
    targetId,
    ...(payload !== undefined ? { payload } : {}),
    ...(condition !== undefined ? { condition } : {}),
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
  validateCelOrScript(condition, `${ctx}.match.condition`, 'behavior');

  // REQ-61: parse requires[] array
  let requires: readonly RequiresGuard[] | undefined;
  const requiresRaw = matchRaw['requires'];
  if (requiresRaw !== undefined && requiresRaw !== null) {
    if (!Array.isArray(requiresRaw)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.match: "requires" must be an array`,
        { field: 'match.requires', context: ctx },
      );
    }
    requires = requiresRaw.map((item, i) =>
      validateRequiresGuard(item, `${ctx}.match.requires[${i}]`),
    );
  }

  // REQ-64: emit (optional) vs emit_when (conditional multi-emit)
  const emitRaw = raw['emit'];
  const emitWhenRaw = raw['emit_when'];

  // REQ-64 mutual exclusion: emit and emit_when cannot coexist
  if (emitRaw !== undefined && emitRaw !== null &&
      emitWhenRaw !== undefined && emitWhenRaw !== null) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "emit" and "emit_when" are mutually exclusive — use one or the other`,
      { field: 'emit', context: ctx },
    );
  }

  // Must have at least emit OR emit_when
  if ((emitRaw === undefined || emitRaw === null) &&
      (emitWhenRaw === undefined || emitWhenRaw === null)) {
    throw new BootError(
      'BOOT_ERR_DSL_EMIT_REQUIRED',
      `${ctx}: behavior must have "emit" or "emit_when" (per §7.2/REQ-64)`,
      { field: 'emit', context: ctx },
    );
  }

  let emit: string | undefined;
  if (emitRaw !== undefined && emitRaw !== null) {
    if (typeof emitRaw !== 'string' || emitRaw.trim() === '') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: field "emit" must be a non-empty string (got ${JSON.stringify(emitRaw)})`,
        { field: 'emit', context: ctx },
      );
    }
    emit = emitRaw;
  }

  let emitWhen: readonly EmitWhenEntry[] | undefined;
  if (emitWhenRaw !== undefined && emitWhenRaw !== null) {
    if (!Array.isArray(emitWhenRaw)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: "emit_when" must be an array`,
        { field: 'emit_when', context: ctx },
      );
    }
    if (emitWhenRaw.length === 0) {
      throw new BootError(
        'BOOT_ERR_DSL_EMIT_REQUIRED',
        `${ctx}: "emit_when" must have at least one entry`,
        { field: 'emit_when', context: ctx },
      );
    }
    emitWhen = emitWhenRaw.map((item, i) =>
      validateEmitWhenEntry(item, `${ctx}.emit_when[${i}]`),
    );
  }

  // REQ-62: postcondition (optional CEL or ts: expression)
  const postconditionRaw = raw['postcondition'];
  let postcondition: string | undefined;
  if (postconditionRaw !== undefined && postconditionRaw !== null) {
    // Support postcondition as either a string or { expression: string }
    if (typeof postconditionRaw === 'string') {
      postcondition = postconditionRaw;
    } else if (isRecord(postconditionRaw)) {
      const exprRaw = postconditionRaw['expression'];
      if (typeof exprRaw !== 'string' || exprRaw.trim() === '') {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `${ctx}.postcondition: "expression" must be a non-empty string`,
          { field: 'postcondition.expression', context: ctx },
        );
      }
      postcondition = exprRaw;
    } else {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: "postcondition" must be a string or object with "expression" field`,
        { field: 'postcondition', context: ctx },
      );
    }
    validateCelOrScript(postcondition, `${ctx}.postcondition`, 'behavior');
  }

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
    match: {
      intent: intentRaw,
      condition,
      ...(requires !== undefined ? { requires } : {}),
    },
    ...(emit !== undefined ? { emit } : {}),
    ...(emitWhen !== undefined ? { emitWhen } : {}),
    ...(postcondition !== undefined ? { postcondition } : {}),
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

  // REQ-71: reject ts: sentinels in reducer-phase fields at boot
  if (assign) {
    for (const [k, v] of Object.entries(assign)) {
      if (v.startsWith(TS_SENTINEL)) {
        throw new BootError(
          'BOOT_ERR_SCRIPT_IN_REDUCER',
          `${ctx}.assign.${k}: ts: sentinel is not allowed in Reducer-phase fields (REQ-71). Value: "${v}"`,
          { field: `${ctx}.assign.${k}`, value: v },
        );
      }
    }
  }
  if (append) {
    for (const [k, v] of Object.entries(append)) {
      if (v.startsWith(TS_SENTINEL)) {
        throw new BootError(
          'BOOT_ERR_SCRIPT_IN_REDUCER',
          `${ctx}.append.${k}: ts: sentinel is not allowed in Reducer-phase fields (REQ-71). Value: "${v}"`,
          { field: `${ctx}.append.${k}`, value: v },
        );
      }
    }
  }

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

  // Validate payload template values as CEL or ts: references
  for (const [field, expr] of Object.entries(payloadTemplate)) {
    validateCelOrScript(expr, `${ctx}.payload_template.${field}`, 'eventHydration');
  }

  // REQ-65: optional schema_ref
  const schemaRef = optionalString(raw, 'schema_ref', ctx);

  return {
    type,
    payloadTemplate,
    ...(schemaRef !== undefined ? { schemaRef } : {}),
  };
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

function validateScriptDeclaration(raw: unknown, index: number, boundaryCtx: string): ScriptDeclaration {
  const ctx = `scripts[${index}] (boundary: ${boundaryCtx})`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  const name = requireString(raw, 'name', ctx);

  // Support both "code" (task spec) and "source" (design.md/requirements)
  const codeRaw = raw['code'] ?? raw['source'];
  if (typeof codeRaw !== 'string' || codeRaw.trim() === '') {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: script must have a non-empty "code" (or "source") field`,
      { field: 'code', context: ctx },
    );
  }
  return { name, code: codeRaw };
}

// ---------------------------------------------------------------------------
// Cross-reference validation
// ---------------------------------------------------------------------------

function collectTsRefs(emitCond: string | undefined, conditions: string[]): string[] {
  const refs: string[] = [];
  for (const c of conditions) {
    if (c.startsWith(TS_SENTINEL)) {
      refs.push(c.slice(TS_SENTINEL.length));
    }
  }
  if (emitCond !== undefined && emitCond.startsWith(TS_SENTINEL)) {
    refs.push(emitCond.slice(TS_SENTINEL.length));
  }
  return refs;
}

function crossValidate(config: {
  behaviors: readonly BehaviorRule[];
  reducers: readonly ReducerRule[];
  eventCatalog: readonly EventCatalogEntry[];
  boundary: string;
  scripts?: readonly ScriptDeclaration[];
}): void {
  const catalogTypes = new Set(config.eventCatalog.map((e) => e.type));
  const scriptNames = new Set(config.scripts?.map((s) => s.name) ?? []);

  // Validate script name uniqueness
  if (config.scripts) {
    const seen = new Set<string>();
    for (const s of config.scripts) {
      if (seen.has(s.name)) {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `Boundary "${config.boundary}": duplicate script name "${s.name}"`,
          { boundary: config.boundary, scriptName: s.name },
        );
      }
      seen.add(s.name);
    }
  }

  for (const behavior of config.behaviors) {
    // Validate emit references
    if (behavior.emit !== undefined && !catalogTypes.has(behavior.emit)) {
      throw new BootError(
        'BOOT_ERR_DSL_REFERENCE',
        `Boundary "${config.boundary}": behavior "${behavior.name}" emits unknown event type "${behavior.emit}" (not in event_catalog)`,
        { boundary: config.boundary, behavior: behavior.name, missingType: behavior.emit },
      );
    }

    // Validate emitWhen references
    if (behavior.emitWhen) {
      for (const ew of behavior.emitWhen) {
        if (!catalogTypes.has(ew.emit)) {
          throw new BootError(
            'BOOT_ERR_DSL_REFERENCE',
            `Boundary "${config.boundary}": behavior "${behavior.name}" emit_when references unknown event type "${ew.emit}" (not in event_catalog)`,
            { boundary: config.boundary, behavior: behavior.name, missingType: ew.emit },
          );
        }
      }
    }

    // Validate ts: references resolve to known scripts
    const tsRefs: string[] = [];
    // match.condition
    if (behavior.match.condition.startsWith(TS_SENTINEL)) {
      tsRefs.push(behavior.match.condition.slice(TS_SENTINEL.length));
    }
    // requires conditions
    for (const req of behavior.match.requires ?? []) {
      if (req.condition.startsWith(TS_SENTINEL)) {
        tsRefs.push(req.condition.slice(TS_SENTINEL.length));
      }
    }
    // postcondition
    if (behavior.postcondition?.startsWith(TS_SENTINEL)) {
      tsRefs.push(behavior.postcondition.slice(TS_SENTINEL.length));
    }
    // emitWhen.when
    for (const ew of behavior.emitWhen ?? []) {
      if (ew.when.startsWith(TS_SENTINEL)) {
        tsRefs.push(ew.when.slice(TS_SENTINEL.length));
      }
    }
    // dispatchCommands
    for (const dc of behavior.dispatchCommands ?? []) {
      if (dc.condition?.startsWith(TS_SENTINEL)) {
        tsRefs.push(dc.condition.slice(TS_SENTINEL.length));
      }
      if (dc.targetId.startsWith(TS_SENTINEL)) {
        tsRefs.push(dc.targetId.slice(TS_SENTINEL.length));
      }
      for (const v of Object.values(dc.payload ?? {})) {
        if (v.startsWith(TS_SENTINEL)) {
          tsRefs.push(v.slice(TS_SENTINEL.length));
        }
      }
    }

    for (const ref of tsRefs) {
      if (!scriptNames.has(ref)) {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `Boundary "${config.boundary}": behavior "${behavior.name}" references unknown script "ts:${ref}"`,
          { boundary: config.boundary, behavior: behavior.name, scriptName: ref },
        );
      }
    }
  }

  // Validate event_catalog payload_template ts: references
  for (const entry of config.eventCatalog) {
    for (const [field, expr] of Object.entries(entry.payloadTemplate)) {
      if (expr.startsWith(TS_SENTINEL)) {
        const scriptName = expr.slice(TS_SENTINEL.length);
        if (!scriptNames.has(scriptName)) {
          throw new BootError(
            'BOOT_ERR_DSL_SYNTAX',
            `Boundary "${config.boundary}": event_catalog "${entry.type}" payload_template field "${field}" references unknown script "ts:${scriptName}"`,
            { boundary: config.boundary, eventType: entry.type, scriptName },
          );
        }
      }
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
 * @throws {BootError} with code `BOOT_ERR_SCRIPT_IN_REDUCER` if ts: in reducer phase.
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

  // REQ-66: parse scripts[] block
  let scripts: readonly ScriptDeclaration[] | undefined;
  const scriptsRaw = raw['scripts'];
  if (scriptsRaw !== undefined && scriptsRaw !== null) {
    if (!Array.isArray(scriptsRaw)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        'root: "scripts" must be an array',
        { field: 'scripts' },
      );
    }
    scripts = scriptsRaw.map((item, i) => validateScriptDeclaration(item, i, boundary));
  }

  // Cross-reference validation
  crossValidate({ behaviors, reducers, eventCatalog, boundary, scripts });

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
    ...(scripts !== undefined ? { scripts } : {}),
  };
}
