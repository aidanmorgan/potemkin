import { BootError } from '../errors.js';
import { assertNoRemovedReducerKeys, assertNoInlineScripts } from './removedSyntax.js';
import { firstBareCelReference } from './celInterpolation.js';
import { lexTemplate } from '../cel/grammar/templateLexer.js';
import type { JsonObject, JsonValue, Intent } from '../types.js';
import { POTEMKIN_SIGNAL_ALIASES } from '../http/potemkinHeaders.js';
import type {
  AuthConfig,
  BehaviorRule,
  BoundaryConfig,
  ComponentDefinition,
  DeprecationConfig,
  EmitWhenEntry,
  EventCatalogEntry,
  FaultRule,
  HateoasConfig,
  HateoasLinkEntry,
  IdentityConfig,
  IdentityKeyConfig,
  IncludeEntry,
  JwtAuthConfig,
  ParameterDecl,
  ParameterType,
  ReactionRule,
  ReducerPatchOp,
  ReducerRule,
  RequiresGuard,
  SecondaryCommandSpec,
  SecurityHeadersConfig,
  SessionAuthConfig,
  SagaConfig,
  SagaStep,
  SagaTrigger,
  SagaCompensation,
  IdempotencyConfig,
  DerivedProjectionConfig,
  DerivedProjectionReduceEntry,
  UseEntry,
  VersionDecl,
  VersioningConfig,
  WebhookConfig,
} from './types.js';
import type { DeclaredComputedField, DeclaredInternalField, DeclaredState, FieldKind, FieldType } from './schemaInference.js';
import { createCelEvaluator } from '../cel/evaluator.js';
import { createLogger } from '../observability/logger.js';

// Module-level CEL evaluator used to pre-check dispatch_commands payload
// values for syntactic validity at boot time. This surfaces CEL parse
// errors as BOOT_ERR_DSL_SYNTAX rather than deferring them to runtime.
const celEvaluator = createCelEvaluator();

const dslLogger = createLogger({ name: 'dsl' });

// ---------------------------------------------------------------------------
// Legacy field aliases accepted at parse time (canonical → legacy):
//   requires[].condition  (was: expression)
//   postcondition: "<string>"  (was: { expression: "..." })
// All emit a DEBUG log; prefer the canonical names in new YAML.
// ---------------------------------------------------------------------------

// Sentinel prefix for inline TypeScript references
const TS_SENTINEL = 'ts:';
// Valid script name pattern after the ts: prefix
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


/**
 * Validate a CEL expression or ts: sentinel for non-reducer phases.
 * ts: sentinels in reducer positions are rejected at boot.
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
        `${fieldCtx}: ts: sentinel is not allowed in reducer-phase fields. Value: "${value}"`,
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

/**
 * Boot-time compile check for a DSL template value that may contain ${expr}
 * interpolations. Each EXPR token is extracted and compiled via celEvaluator so
 * a malformed expression causes a BOOT_ERR_DSL_SYNTAX halt instead of a runtime
 * 500. Non-string values and strings without ${} are safe to skip.
 */
function validatePatchValueCel(value: unknown, fieldCtx: string): void {
  if (typeof value !== 'string') return;
  if (!value.includes('${')) return;
  for (const tok of lexTemplate(value)) {
    if (tok.type !== 'EXPR') continue;
    try {
      celEvaluator.compile(tok.src);
    } catch (err) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${fieldCtx}: invalid CEL in \${...}: ${err instanceof Error ? err.message : String(err)}`,
        { field: fieldCtx, expression: tok.src },
      );
    }
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
  // Canonical field: "condition".  Legacy alias: "expression".
  // Both are accepted for backward compatibility; prefer "condition".
  const conditionRaw = raw['condition'] ?? raw['expression'];
  if (raw['condition'] === undefined && raw['expression'] !== undefined) {
    dslLogger.debug(`DSL: deprecated field 'expression' in ${ctx}, use 'condition' instead`);
  }
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
  const operationId = requireString(raw, 'operationId', ctx);
  const targetId = requireString(raw, 'target_id', ctx);
  try {
    celEvaluator.compile(targetId);
  } catch (err) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: target_id is not a valid CEL expression: ${err instanceof Error ? err.message : String(err)}`,
      { field: 'target_id', context: ctx, expression: targetId },
    );
  }
  const payload = requireStringStringMap(raw, 'payload', ctx);

  // Optional condition for dispatch gating
  const condition = optionalString(raw, 'condition', ctx);
  if (condition !== undefined) {
    validateCelOrScript(condition, `${ctx}.condition`, 'behavior');
  }

  // Pre-compile each CEL expression in payload values to catch syntax errors at boot time.
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
    operationId,
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
  // `intent` was removed from behavior match in favour of operationId.
  if (matchRaw['intent'] !== undefined) {
    throw new BootError(
      'BOOT_ERR_REMOVED_SYNTAX',
      `${ctx}.match.intent is no longer supported — use match.operationId (the OpenAPI operationId this behavior handles)`,
      { field: 'match.intent', context: ctx },
    );
  }
  if (matchRaw['operationId'] === undefined) {
    throw new BootError(
      'BOOT_ERR_MISSING_OPERATION_ID',
      `${ctx}.match.operationId is required — declare the OpenAPI operationId this behavior handles`,
      { field: 'match.operationId', context: ctx },
    );
  }
  const operationId = requireString(matchRaw, 'operationId', `${ctx}.match`);
  const condition = requireString(matchRaw, 'condition', `${ctx}.match`);
  validateCelOrScript(condition, `${ctx}.match.condition`, 'behavior');

  // Parse required_scopes[] array
  let requiredScopes: readonly string[] | undefined;
  const requiredScopesRaw = matchRaw['required_scopes'];
  if (requiredScopesRaw !== undefined && requiredScopesRaw !== null) {
    if (!Array.isArray(requiredScopesRaw)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.match: "required_scopes" must be an array`,
        { field: 'match.required_scopes', context: ctx },
      );
    }
    requiredScopes = requiredScopesRaw.map((item, i) => {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `${ctx}.match.required_scopes[${i}]: must be a non-empty string`,
          { context: ctx },
        );
      }
      return item;
    });
  }

  // Parse requires[] array
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

  // emit (optional) vs emit_when (conditional multi-emit); they are mutually exclusive
  const emitRaw = raw['emit'];
  const emitWhenRaw = raw['emit_when'];

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
      `${ctx}: behavior must have "emit" or "emit_when"`,
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

  // postcondition: canonical form is a plain string; legacy object { expression: "..." }
  // is still accepted for backward compatibility.
  const postconditionRaw = raw['postcondition'];
  let postcondition: string | undefined;
  if (postconditionRaw !== undefined && postconditionRaw !== null) {
    if (typeof postconditionRaw === 'string') {
      postcondition = postconditionRaw;
    } else if (isRecord(postconditionRaw)) {
      // Legacy object form: { expression: "..." }
      dslLogger.debug(`DSL: deprecated object form for 'postcondition' in ${ctx}, use a plain string instead`);
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

  // Optional HTTP method filter on the matcher (uppercased for case-insensitive matching).
  let method: string | undefined;
  const methodRaw = matchRaw['method'];
  if (methodRaw !== undefined && methodRaw !== null) {
    if (typeof methodRaw !== 'string' || methodRaw.trim() === '') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.match: "method" must be a non-empty string`,
        { field: 'match.method', context: ctx },
      );
    }
    method = methodRaw.trim().toUpperCase();
  }

  // Header matching: name → expected value or "present". AND semantics.
  const matchHeaders = requireStringStringMap(matchRaw, 'headers', `${ctx}.match`);

  // HATEOAS: optional link_name + link_condition advertised by this behavior.
  let linkName: string | undefined;
  const linkNameRaw = raw['link_name'];
  if (linkNameRaw !== undefined && linkNameRaw !== null) {
    if (typeof linkNameRaw !== 'string' || linkNameRaw.trim() === '') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: "link_name" must be a non-empty string`,
        { field: 'link_name', context: ctx },
      );
    }
    linkName = linkNameRaw;
  }

  let linkCondition: string | undefined;
  const linkConditionRaw = raw['link_condition'];
  if (linkConditionRaw !== undefined && linkConditionRaw !== null) {
    if (typeof linkConditionRaw !== 'string' || linkConditionRaw.trim() === '') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: "link_condition" must be a non-empty string`,
        { field: 'link_condition', context: ctx },
      );
    }
    validateCelOrScript(linkConditionRaw, `${ctx}.link_condition`, 'behavior');
    linkCondition = linkConditionRaw;
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
      operationId,
      condition,
      ...(method !== undefined ? { method } : {}),
      ...(requires !== undefined ? { requires } : {}),
      ...(requiredScopes !== undefined ? { requiredScopes } : {}),
      ...(matchHeaders !== undefined && Object.keys(matchHeaders).length > 0 ? { headers: matchHeaders } : {}),
    },
    ...(emit !== undefined ? { emit } : {}),
    ...(emitWhen !== undefined ? { emitWhen } : {}),
    ...(postcondition !== undefined ? { postcondition } : {}),
    ...(linkName !== undefined ? { linkName } : {}),
    ...(linkCondition !== undefined ? { linkCondition } : {}),
    ...(dispatchCommands !== undefined ? { dispatchCommands } : {}),
  };
}

function validateReducerRule(raw: unknown, index: number): ReducerRule {
  const ctx = `reducers[${index}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  const on = requireString(raw, 'on', ctx);

  // Reducers express state mutation exclusively via `patches:`.
  // Legacy assign:/append:/assignAll: keys are rejected at boot.
  assertNoRemovedReducerKeys(raw, ctx);

  const patches = optionalPatchList(raw, ctx);

  const implRaw = raw['implementation'];
  if (implRaw !== undefined && implRaw !== 'typescript') {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}.implementation: unsupported value "${implRaw as string}" — only "typescript" is allowed`,
      { context: ctx },
    );
  }
  const implementation = implRaw === 'typescript' ? 'typescript' : undefined;

  return {
    on,
    ...(patches !== undefined ? { patches } : {}),
    ...(implementation !== undefined ? { implementation } : {}),
  };
}

function optionalPatchList(raw: Record<string, unknown>, ctx: string): readonly ReducerPatchOp[] | undefined {
  const val = raw['patches'];
  if (val === undefined) return undefined;
  if (!Array.isArray(val)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.patches: must be an array`, { context: ctx });
  }
  const known = new Set(['add', 'remove', 'replace', 'append', 'prepend', 'increment', 'merge', 'upsert', 'move', 'copy']);
  return val.map((p, i): ReducerPatchOp => {
    if (!isRecord(p)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.patches[${i}]: must be an object`, { context: ctx });
    }
    const op = p['op'];
    if (typeof op !== 'string' || !known.has(op)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.patches[${i}].op: invalid op "${op as unknown}"`, { context: ctx });
    }
    const path = p['path'];
    if (typeof path !== 'string') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.patches[${i}].path: must be a string`, { context: ctx });
    }
    // Reducer-phase values are CEL only — reject ts: script sentinels.
    const patchValue = p['value'];
    if (typeof patchValue === 'string' && patchValue.startsWith(TS_SENTINEL)) {
      throw new BootError(
        'BOOT_ERR_SCRIPT_IN_REDUCER',
        `${ctx}.patches[${i}].value: ts: sentinel is not allowed in reducer-phase fields. Value: "${patchValue}"`,
        { field: `${ctx}.patches[${i}].value`, value: patchValue },
      );
    }
    // A CEL context reference (state./event./command./$builtin) must be
    // wrapped in ${...}. A bare reference is almost certainly an un-interpolated
    // mistake — reject it with a clear message.
    if (typeof patchValue === 'string') {
      const bare = firstBareCelReference(patchValue);
      if (bare !== null) {
        throw new BootError(
          'BOOT_ERR_CEL_NEEDS_INTERP',
          `${ctx}.patches[${i}].value: CEL reference "${bare}" must be interpolated as \${...} — write "\${${patchValue}}" (or wrap the referencing sub-expression). Value: "${patchValue}"`,
          { field: `${ctx}.patches[${i}].value`, value: patchValue, reference: bare },
        );
      }
    }
    // Boot-compile any ${...} CEL expressions in string values so a malformed
    // expression halts boot rather than producing a runtime 500.
    if (typeof patchValue === 'string') {
      validatePatchValueCel(patchValue, `${ctx}.patches[${i}].value`);
    }
    // Object-valued ops (merge, upsert) may contain ${...} in their nested
    // string fields — compile each leaf string value.
    if (typeof patchValue === 'object' && patchValue !== null && !Array.isArray(patchValue)) {
      for (const [k, v] of Object.entries(patchValue as Record<string, unknown>)) {
        if (typeof v === 'string') {
          validatePatchValueCel(v, `${ctx}.patches[${i}].value.${k}`);
        }
      }
    }
    // Guard: Infinity/NaN would round-trip through JSON.stringify to null,
    // silently corrupting the field.
    if (typeof patchValue === 'number' && !Number.isFinite(patchValue)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.patches[${i}].value: numeric value must be finite (got ${String(patchValue)}) — YAML .inf/.nan are not allowed as patch values`,
        { field: `${ctx}.patches[${i}].value`, path },
      );
    }
    // Guard for increment operand: `by` is the canonical field; `value` is accepted
    // as an alias. Non-finite numbers become null via JSON.stringify, silently
    // corrupting the field — reject them early.
    const patchBy = p['by'];
    if (typeof patchBy === 'number' && !Number.isFinite(patchBy)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.patches[${i}].by: increment operand must be finite (got ${String(patchBy)}) — YAML .inf/.nan are not allowed`,
        { field: `${ctx}.patches[${i}].by`, path },
      );
    }
    // When `value` is used as the alias for `by` on an increment op, it is
    // numeric — apply the same non-finite guard (string values are covered by
    // the ${...} CEL compile above).
    if (op === 'increment' && typeof patchValue === 'number' && !Number.isFinite(patchValue)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.patches[${i}].value: increment operand must be finite (got ${String(patchValue)}) — YAML .inf/.nan are not allowed`,
        { field: `${ctx}.patches[${i}].value`, path },
      );
    }
    return {
      op: op as ReducerPatchOp['op'],
      path,
      ...(p['value'] !== undefined ? { value: p['value'] as ReducerPatchOp['value'] } : {}),
      ...(p['by'] !== undefined ? { by: p['by'] as number } : {}),
      ...(p['key'] !== undefined ? { key: p['key'] as string } : {}),
      ...(p['deep'] !== undefined ? { deep: p['deep'] as boolean } : {}),
      ...(p['from'] !== undefined ? { from: p['from'] as string } : {}),
    };
  });
}

function validateEventCatalogEntry(raw: unknown, index: number): EventCatalogEntry {
  const ctx = `event_catalog[${index}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  const type = requireString(raw, 'type', ctx);
  const payloadTemplate = requireStringStringMap(raw, 'payload_template', ctx) ?? {};

  for (const [field, expr] of Object.entries(payloadTemplate)) {
    validateCelOrScript(expr, `${ctx}.payload_template.${field}`, 'eventHydration');
  }

  const schemaRef = optionalString(raw, 'schema_ref', ctx);

  return {
    type,
    payloadTemplate,
    ...(schemaRef !== undefined ? { schemaRef } : {}),
  };
}

function validateIdentityKeyConfig(raw: unknown, ctx: string): IdentityKeyConfig {
  if (!isRecord(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "identity.key" must be an object`,
      { field: 'identity.key', context: ctx },
    );
  }
  // CEL-based key extraction is not supported: key resolution runs during
  // command assembly (the key IS the targetId), so a CEL context referencing
  // the command would be circular. Reject it at boot rather than silently
  // returning null at runtime.
  if (optionalString(raw, 'cel', ctx) !== undefined) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "identity.key.cel" is not supported; use "from" with one of: path, query, header, payload`,
      { field: 'identity.key.cel', context: ctx },
    );
  }

  const from = optionalString(raw, 'from', ctx);
  if (from === undefined || !['path', 'query', 'header', 'payload'].includes(from)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "identity.key.from" is required and must be one of: path, query, header, payload (got "${String(from)}")`,
      { field: 'identity.key.from', context: ctx },
    );
  }
  const name = optionalString(raw, 'name', ctx);
  const pointer = optionalString(raw, 'pointer', ctx);
  // Each source needs a locator so the key cannot silently resolve to null at
  // runtime: path/query/header require `name`; payload requires `name`/`pointer`.
  if (from === 'payload') {
    if (name === undefined && pointer === undefined) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: "identity.key" with from: payload requires "pointer" (or "name")`,
        { field: 'identity.key.pointer', context: ctx },
      );
    }
  } else if (name === undefined) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "identity.key" with from: ${from} requires "name"`,
      { field: 'identity.key.name', context: ctx },
    );
  }
  return {
    from: from as IdentityKeyConfig['from'],
    ...(name !== undefined ? { name } : {}),
    ...(pointer !== undefined ? { pointer } : {}),
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

  let creation: IdentityConfig['creation'];
  const creationRaw = raw['creation'];
  if (creationRaw !== undefined && creationRaw !== null) {
    if (!isRecord(creationRaw)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: "identity.creation" must be an object`,
        { field: 'identity.creation', context: ctx },
      );
    }
    const generate = optionalString(creationRaw, 'generate', `${ctx}.creation`);
    creation = { ...(generate !== undefined ? { generate } : {}) };
  }

  let key: IdentityKeyConfig | undefined;
  const keyRaw = raw['key'];
  if (keyRaw !== undefined && keyRaw !== null) {
    key = validateIdentityKeyConfig(keyRaw, `${ctx}.key`);
  }

  return {
    ...(creation !== undefined ? { creation } : {}),
    ...(key !== undefined ? { key } : {}),
  };
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

    // ts: reference resolution is deferred to boot time (validateBoundaryTsRefs),
    // because scanned @Script ids are only available after the TypeScript scanner
    // runs. crossValidate only has access to inline scriptNames.
  }

  // event_catalog payload_template ts: reference resolution is also deferred to
  // boot time for the same reason.

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
// Boot-time ts: reference validation (runs after TypeScript scanner)
// ---------------------------------------------------------------------------

/**
 * Collect all ts:<id> script ids referenced in a boundary config.
 * Returns the raw ids (without the "ts:" prefix).
 */
function collectBoundaryTsRefs(config: {
  behaviors: readonly BehaviorRule[];
  eventCatalog: readonly EventCatalogEntry[];
}): string[] {
  const refs: string[] = [];

  for (const behavior of config.behaviors) {
    if (behavior.match.condition.startsWith(TS_SENTINEL)) {
      refs.push(behavior.match.condition.slice(TS_SENTINEL.length));
    }
    for (const req of behavior.match.requires ?? []) {
      if (req.condition.startsWith(TS_SENTINEL)) {
        refs.push(req.condition.slice(TS_SENTINEL.length));
      }
    }
    if (behavior.postcondition?.startsWith(TS_SENTINEL)) {
      refs.push(behavior.postcondition.slice(TS_SENTINEL.length));
    }
    for (const ew of behavior.emitWhen ?? []) {
      if (ew.when.startsWith(TS_SENTINEL)) {
        refs.push(ew.when.slice(TS_SENTINEL.length));
      }
    }
    for (const dc of behavior.dispatchCommands ?? []) {
      if (dc.condition?.startsWith(TS_SENTINEL)) {
        refs.push(dc.condition.slice(TS_SENTINEL.length));
      }
      if (dc.targetId.startsWith(TS_SENTINEL)) {
        refs.push(dc.targetId.slice(TS_SENTINEL.length));
      }
      for (const v of Object.values(dc.payload ?? {})) {
        if (v.startsWith(TS_SENTINEL)) {
          refs.push(v.slice(TS_SENTINEL.length));
        }
      }
    }
  }

  for (const entry of config.eventCatalog) {
    for (const expr of Object.values(entry.payloadTemplate)) {
      if (expr.startsWith(TS_SENTINEL)) {
        refs.push(expr.slice(TS_SENTINEL.length));
      }
    }
  }

  return refs;
}

/**
 * Validate that every ts:<id> reference in a boundary resolves to a scanned
 * @Script id. Called at boot time after the TypeScript scanner has run.
 *
 * @throws {BootError} BOOT_ERR_DSL_REFERENCE when an id resolves to no scanned @Script.
 */
export function validateBoundaryTsRefs(
  config: {
    boundary: string;
    behaviors: readonly BehaviorRule[];
    eventCatalog: readonly EventCatalogEntry[];
  },
  scannedScriptIds: ReadonlySet<string>,
): void {
  const refs = collectBoundaryTsRefs(config);
  for (const ref of refs) {
    if (!scannedScriptIds.has(ref)) {
      throw new BootError(
        'BOOT_ERR_DSL_REFERENCE',
        `Boundary "${config.boundary}": ts: reference "ts:${ref}" does not resolve to any scanned @Script id`,
        { boundary: config.boundary, scriptId: ref },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cross-file composition validators (C1)
// ---------------------------------------------------------------------------

const VALID_PARAMETER_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'boolean']);

/**
 * Parse a `with:` block (parameter bindings) from a use: or include: entry.
 * Values may be string, number, or boolean. Returns undefined when absent.
 */
function validateWithBindings(
  raw: unknown,
  ctx: string,
): Record<string, string | number | boolean> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "with" must be an object`,
      { field: 'with', context: ctx },
    );
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: "with.${k}" must be a string, number, or boolean (got ${JSON.stringify(v)})`,
        { field: `with.${k}`, context: ctx },
      );
    }
    out[k] = v;
  }
  return out;
}

/**
 * Parse a `bind:` block (sibling alias → concrete name map) from a use: entry.
 * Values must be strings. Returns undefined when absent.
 */
function validateBindMap(
  raw: unknown,
  ctx: string,
): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "bind" must be an object`,
      { field: 'bind', context: ctx },
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: "bind.${k}" must be a string (got ${JSON.stringify(v)})`,
        { field: `bind.${k}`, context: ctx },
      );
    }
    out[k] = v;
  }
  return out;
}

/**
 * Parse a `use:` array. Each entry must have component, as, and contract_path.
 * Returns undefined when absent.
 */
export function validateUseEntries(
  raw: unknown,
  ctx: string,
): readonly UseEntry[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "use" must be an array`,
      { field: 'use', context: ctx },
    );
  }
  return raw.map((item, i) => {
    const ectx = `${ctx}.use[${i}]`;
    if (!isRecord(item)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ectx}: must be an object`,
        { context: ectx },
      );
    }
    if (item['component'] === undefined || item['component'] === null) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ectx}: "component" is required`,
        { field: 'component', context: ectx },
      );
    }
    const component = requireString(item, 'component', ectx);
    if (item['as'] === undefined || item['as'] === null) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ectx}: "as" is required`,
        { field: 'as', context: ectx },
      );
    }
    const as_ = requireString(item, 'as', ectx);
    if (item['contract_path'] === undefined || item['contract_path'] === null) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ectx}: "contract_path" is required`,
        { field: 'contract_path', context: ectx },
      );
    }
    const contractPath = requireString(item, 'contract_path', ectx);
    const withBindings = validateWithBindings(item['with'], ectx);
    const bindMap = validateBindMap(item['bind'], ectx);
    return {
      component,
      as: as_,
      contractPath,
      ...(withBindings !== undefined ? { with: withBindings } : {}),
      ...(bindMap !== undefined ? { bind: bindMap } : {}),
    } satisfies UseEntry;
  });
}

/**
 * Parse an `include:` array. Each entry must have component.
 * Returns undefined when absent.
 */
export function validateIncludeEntries(
  raw: unknown,
  ctx: string,
): readonly IncludeEntry[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "include" must be an array`,
      { field: 'include', context: ctx },
    );
  }
  return raw.map((item, i) => {
    const ectx = `${ctx}.include[${i}]`;
    if (!isRecord(item)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ectx}: must be an object`,
        { context: ectx },
      );
    }
    if (item['component'] === undefined || item['component'] === null) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ectx}: "component" is required`,
        { field: 'component', context: ectx },
      );
    }
    const component = requireString(item, 'component', ectx);
    const withBindings = validateWithBindings(item['with'], ectx);
    return {
      component,
      ...(withBindings !== undefined ? { with: withBindings } : {}),
    } satisfies IncludeEntry;
  });
}

/**
 * Parse the `parameters:` block of a component definition.
 * Each entry is { type, default?, required? }.
 */
function validateParametersBlock(
  raw: unknown,
  ctx: string,
): Record<string, ParameterDecl> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "parameters" must be an object`,
      { field: 'parameters', context: ctx },
    );
  }
  const out: Record<string, ParameterDecl> = {};
  for (const [paramName, entry] of Object.entries(raw)) {
    const pctx = `${ctx}.parameters.${paramName}`;
    if (!isRecord(entry)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${pctx}: parameter declaration must be an object`,
        { field: `parameters.${paramName}`, context: pctx },
      );
    }
    const typeRaw = entry['type'];
    if (typeof typeRaw !== 'string' || !VALID_PARAMETER_TYPES.has(typeRaw)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${pctx}: "type" must be one of string|number|boolean (got ${JSON.stringify(typeRaw)})`,
        { field: `parameters.${paramName}.type`, context: pctx },
      );
    }
    const paramType = typeRaw as ParameterType;
    const defaultRaw = entry['default'];
    const requiredRaw = entry['required'];
    const decl: ParameterDecl = {
      type: paramType,
      ...(defaultRaw !== undefined ? { default: defaultRaw as string | number | boolean } : {}),
      ...(requiredRaw !== undefined ? { required: requiredRaw as boolean } : {}),
    };
    out[paramName] = decl;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Top-level keys allowed in a component file. */
const KNOWN_COMPONENT_KEYS: ReadonlySet<string> = new Set([
  'kind', 'name',
  'parameters',
  'event_catalog', 'reducers', 'behaviors',
  'identity', 'state', 'reactions', 'include',
]);

/**
 * Validate and parse a `kind: component` YAML file into a ComponentDefinition.
 * Components have no contract_path and produce no live boundary.
 */
export function validateComponentConfig(raw: unknown): ComponentDefinition {
  if (!isRecord(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      'Component file root must be a YAML mapping object',
      { received: typeof raw },
    );
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_COMPONENT_KEYS.has(key)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `Unknown component key "${key}" — supported keys: ${[...KNOWN_COMPONENT_KEYS].sort().join(', ')}`,
        { key },
      );
    }
  }

  const kind = raw['kind'];
  if (kind !== 'component') {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `component file "kind" must be "component" (got ${JSON.stringify(kind)})`,
      { field: 'kind' },
    );
  }

  const name = requireString(raw, 'name', 'component');
  const parameters = validateParametersBlock(raw['parameters'], 'component');

  const eventCatalogRaw = raw['event_catalog'];
  let eventCatalog: readonly EventCatalogEntry[] | undefined;
  if (eventCatalogRaw !== undefined && eventCatalogRaw !== null) {
    if (!Array.isArray(eventCatalogRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'component: "event_catalog" must be an array', { field: 'event_catalog' });
    }
    eventCatalog = eventCatalogRaw.map((item, i) => validateEventCatalogEntry(item, i));
  }

  const reducersRaw = raw['reducers'];
  let reducers: readonly ReducerRule[] | undefined;
  if (reducersRaw !== undefined && reducersRaw !== null) {
    if (!Array.isArray(reducersRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'component: "reducers" must be an array', { field: 'reducers' });
    }
    reducers = reducersRaw.map((item, i) => validateReducerRule(item, i));
  }

  const behaviorsRaw = raw['behaviors'];
  let behaviors: readonly BehaviorRule[] | undefined;
  if (behaviorsRaw !== undefined && behaviorsRaw !== null) {
    if (!Array.isArray(behaviorsRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'component: "behaviors" must be an array', { field: 'behaviors' });
    }
    behaviors = behaviorsRaw.map((item, i) => validateBehaviorRule(item, i));
  }

  let identity: IdentityConfig | undefined;
  if (raw['identity'] !== undefined && raw['identity'] !== null) {
    identity = validateIdentityConfig(raw['identity'], 'component');
  }

  const state = validateDeclaredState(raw['state'], 'component');

  const reactionsRaw = raw['reactions'];
  let reactions: readonly ReactionRule[] | undefined;
  if (reactionsRaw !== undefined && reactionsRaw !== null) {
    if (!Array.isArray(reactionsRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'component: "reactions" must be an array', { field: 'reactions' });
    }
    reactions = reactionsRaw.map((item, i) => validateReactionRule(item, i, undefined));
  }

  const include = validateIncludeEntries(raw['include'], 'component');

  // Phase-1 intra-component cross-reference validation: reducers and behaviors
  // must reference event types declared in this component's own event_catalog.
  // (Binding-dependent cross-component references are deferred to C2/C3.)
  if (eventCatalog !== undefined || reducers !== undefined || behaviors !== undefined) {
    const componentForCrossValidate = {
      boundary: name,
      behaviors: behaviors ?? [],
      reducers: reducers ?? [],
      eventCatalog: eventCatalog ?? [],
    };
    crossValidate(componentForCrossValidate);
  }

  return {
    kind: 'component',
    name,
    ...(parameters !== undefined ? { parameters } : {}),
    ...(eventCatalog !== undefined ? { eventCatalog } : {}),
    ...(reducers !== undefined ? { reducers } : {}),
    ...(behaviors !== undefined ? { behaviors } : {}),
    ...(identity !== undefined ? { identity } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(reactions !== undefined ? { reactions } : {}),
    ...(include !== undefined ? { include } : {}),
  };
}

/**
 * Validate and parse a use-only mapping file: a file with only a `use:` key
 * (no `boundary:`, no `kind:`). These files activate components as concrete
 * boundaries. The `use:` entries are stashed and returned for the C3 linker.
 *
 * Decision: a use-only file is classified as a "mapping file" — distinct from
 * both boundary modules and global modules. It contributes `use:` entries to
 * CompiledDsl.use but contributes no boundary module bodies to global merging.
 * The loader routes it to a third bucket (useMappingModules).
 */
export function validateUseMappingConfig(raw: unknown): readonly UseEntry[] {
  if (!isRecord(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      'Use-mapping file root must be a YAML mapping object',
      { received: typeof raw },
    );
  }
  const use = validateUseEntries(raw['use'], 'root');
  if (use === undefined || use.length === 0) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      'Use-mapping file must have a non-empty "use" array',
      { field: 'use' },
    );
  }
  return use;
}

/**
 * Every valid top-level key in a boundary DSL module — used for fail-fast
 * rejection of typos, symmetric with KNOWN_GLOBAL_KEYS for the global config.
 */
const KNOWN_BOUNDARY_KEYS: ReadonlySet<string> = new Set([
  'boundary', 'contract_path', 'fallback_override', 'identity', 'query_mapping',
  'behaviors', 'reducers', 'event_catalog', 'initialization',
  // 'scripts' is retained in the allowed-key set so the unknown-key guard does
  // not fire before assertNoInlineScripts can emit BOOT_ERR_REMOVED_SYNTAX.
  'scripts',
  'deprecated', 'hateoas', 'mask', 'state', 'strict_schema', 'latency',
  'audit_fields', 'fault_rules', 'reactions',
  // Cross-file composition keys (C1)
  'include',
  // Spec-endpoint cross-check keys consumed by configLoader (camelCase + snake_case).
  'specId', 'spec_id', 'outOfContract', 'out_of_contract', 'method', 'methods',
]);

/**
 * Validate a single `reactions[i]` entry.
 * When `fileBoundary` is provided (boundary-file context), the `boundary` field
 * defaults to it. When absent (global-file context), `boundary` is required.
 */
function validateReactionRule(raw: unknown, idx: number, fileBoundary?: string): ReactionRule {
  const ctx = `reactions[${idx}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }

  const name = optionalString(raw, 'name', ctx);
  const on = requireString(raw, 'on', ctx);
  const emit = requireString(raw, 'emit', ctx);

  // boundary: required in global context, optional in boundary-file context
  const boundaryRaw = raw['boundary'];
  let boundary: string | undefined;
  if (boundaryRaw !== undefined && boundaryRaw !== null) {
    if (typeof boundaryRaw !== 'string' || (boundaryRaw as string).trim() === '') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: optional field "boundary" must be a string (got ${JSON.stringify(boundaryRaw)})`,
        { field: 'boundary', context: ctx },
      );
    }
    boundary = boundaryRaw as string;
  } else if (fileBoundary !== undefined) {
    boundary = fileBoundary;
  } else {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "boundary" is required when reactions are declared in the global config`,
      { field: 'boundary', context: ctx },
    );
  }

  // intent: optional, must be 'mutation' or 'creation'
  let intent: ReactionRule['intent'];
  const intentRaw = raw['intent'];
  if (intentRaw !== undefined && intentRaw !== null) {
    if (intentRaw !== 'mutation' && intentRaw !== 'creation') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: "intent" must be "mutation" or "creation" (got ${JSON.stringify(intentRaw)})`,
        { field: 'intent', context: ctx },
      );
    }
    intent = intentRaw;
  }

  // when: optional CEL gate
  const when = optionalString(raw, 'when', ctx);
  if (when !== undefined) {
    try {
      celEvaluator.compile(when);
    } catch (err) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: "when" is not a valid CEL expression: ${err instanceof Error ? err.message : String(err)}`,
        { field: 'when', context: ctx, expression: when },
      );
    }
  }

  // target: optional CEL resolving to aggregate id
  const target = optionalString(raw, 'target', ctx);
  if (target !== undefined) {
    try {
      celEvaluator.compile(target);
    } catch (err) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: "target" is not a valid CEL expression: ${err instanceof Error ? err.message : String(err)}`,
        { field: 'target', context: ctx, expression: target },
      );
    }
  }

  // payload: optional map<string, CEL string>
  const payload = requireStringStringMap(raw, 'payload', ctx);
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
    ...(name !== undefined ? { name } : {}),
    on,
    ...(when !== undefined ? { when } : {}),
    boundary,
    emit,
    ...(intent !== undefined ? { intent } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(payload !== undefined ? { payload } : {}),
  };
}

export function validateBoundaryConfig(raw: unknown): BoundaryConfig {
  if (!isRecord(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      'DSL module root must be a YAML mapping object',
      { received: typeof raw },
    );
  }

  // Fail-fast on unknown top-level keys so typos (e.g. `reducerss:`) are
  // rejected at boot rather than silently dropped.
  for (const key of Object.keys(raw)) {
    if (!KNOWN_BOUNDARY_KEYS.has(key)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `Unknown boundary key "${key}" — supported keys: ${[...KNOWN_BOUNDARY_KEYS].sort().join(', ')}`,
        { key, ...(typeof raw['boundary'] === 'string' ? { boundary: raw['boundary'] } : {}) },
      );
    }
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

  // Inline scripts are removed — halt boot immediately if the key is present.
  assertNoInlineScripts(raw, 'root');

  const deprecated = validateDeprecationConfig(raw['deprecated'], 'root');
  const hateoas = validateHateoasEntries(raw['hateoas'], 'root');
  const mask = validateMaskFields(raw['mask'], 'root');
  const state = validateDeclaredState(raw['state'], 'root');

  let strictSchema: boolean | undefined;
  if (raw['strict_schema'] !== undefined || raw['strictSchema'] !== undefined) {
    const v = raw['strict_schema'] ?? raw['strictSchema'];
    if (typeof v !== 'boolean') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `root: "strict_schema" must be a boolean`, { field: 'strict_schema' });
    }
    strictSchema = v;
  }

  let auditFields: boolean | undefined;
  const auditFieldsRaw = raw['audit_fields'];
  if (auditFieldsRaw !== undefined && auditFieldsRaw !== null) {
    if (typeof auditFieldsRaw !== 'boolean') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `root: "audit_fields" must be a boolean (got ${JSON.stringify(auditFieldsRaw)})`,
        { field: 'audit_fields' },
      );
    }
    auditFields = auditFieldsRaw;
  }

  let faults: readonly FaultRule[] | undefined;
  const faultRulesRaw = raw['fault_rules'];
  if (faultRulesRaw !== undefined && faultRulesRaw !== null) {
    if (!Array.isArray(faultRulesRaw)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        'root: "fault_rules" must be an array',
        { field: 'fault_rules' },
      );
    }
    faults = faultRulesRaw.map((item, i) => validateFaultRule(item, i));
  }

  let reactions: readonly ReactionRule[] | undefined;
  const reactionsRaw = raw['reactions'];
  if (reactionsRaw !== undefined && reactionsRaw !== null) {
    if (!Array.isArray(reactionsRaw)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        'root: "reactions" must be an array',
        { field: 'reactions' },
      );
    }
    reactions = reactionsRaw.map((item, i) => validateReactionRule(item, i, boundary));
  }

  const include = validateIncludeEntries(raw['include'], 'root');

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
    ...(deprecated !== undefined ? { deprecated } : {}),
    ...(hateoas !== undefined ? { hateoas } : {}),
    ...(mask !== undefined ? { mask } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(strictSchema !== undefined ? { strictSchema } : {}),
    ...(auditFields !== undefined ? { auditFields } : {}),
    ...(faults !== undefined ? { faults } : {}),
    ...(reactions !== undefined ? { reactions } : {}),
    ...(include !== undefined ? { include } : {}),
  };
}

/**
 * Parse an optional `state:` block of declared computed and internal fields.
 * computed entries are { name, formula, depends_on } — the formula is a CEL
 * expression compiled at parse time. internal entries are { name, type }
 * where type names a scalar/array/object field kind.
 */
function validateDeclaredState(
  raw: unknown,
  ctx: string,
): DeclaredState | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.state must be a mapping`, { field: 'state' });
  }

  let computed: DeclaredComputedField[] | undefined;
  const computedRaw = raw['computed'];
  if (computedRaw !== undefined && computedRaw !== null) {
    if (!Array.isArray(computedRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.state.computed must be an array`, { field: 'state.computed' });
    }
    computed = computedRaw.map((item, i) => {
      const ictx = `${ctx}.state.computed[${i}]`;
      if (!isRecord(item)) {
        throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ictx} must be a mapping`, { context: ictx });
      }
      const name = requireString(item, 'name', ictx);
      const formula = requireString(item, 'formula', ictx);
      try {
        celEvaluator.compile(formula);
      } catch (err) {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `${ictx}.formula is not a valid CEL expression: ${err instanceof Error ? err.message : String(err)}`,
          { context: ictx, formula },
        );
      }
      const dependsOnRaw = item['depends_on'] ?? item['dependsOn'];
      let dependsOn: string[] = [];
      if (dependsOnRaw !== undefined && dependsOnRaw !== null) {
        if (!Array.isArray(dependsOnRaw)) {
          throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ictx}.depends_on must be an array`, { context: ictx });
        }
        dependsOn = dependsOnRaw.map((d, j) => {
          if (typeof d !== 'string' || d.trim() === '') {
            throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ictx}.depends_on[${j}] must be a non-empty string`, { context: ictx });
          }
          return d;
        });
      }
      return { name, formula, dependsOn };
    });
  }

  let internal: DeclaredInternalField[] | undefined;
  const internalRaw = raw['internal'];
  if (internalRaw !== undefined && internalRaw !== null) {
    if (!Array.isArray(internalRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.state.internal must be an array`, { field: 'state.internal' });
    }
    internal = internalRaw.map((item, i) => {
      const ictx = `${ctx}.state.internal[${i}]`;
      if (!isRecord(item)) {
        throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ictx} must be a mapping`, { context: ictx });
      }
      const name = requireString(item, 'name', ictx);
      const typeName = requireString(item, 'type', ictx);
      return { name, type: fieldTypeFromName(typeName, ictx) };
    });
  }

  return {
    ...(computed !== undefined ? { computed } : {}),
    ...(internal !== undefined ? { internal } : {}),
  };
}

const SCALAR_FIELD_KINDS = new Set(['string', 'integer', 'number', 'boolean', 'null', 'array', 'object']);

function fieldTypeFromName(
  typeName: string,
  ctx: string,
): FieldType {
  if (!SCALAR_FIELD_KINDS.has(typeName)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}.type "${typeName}" is not a known field kind (${[...SCALAR_FIELD_KINDS].join(', ')})`,
      { context: ctx, type: typeName },
    );
  }
  return { kind: typeName as FieldKind, confidence: 'known' };
}

/** Parse an optional `deprecated:` envelope { date?, sunset?, replacement? }. */
function validateDeprecationConfig(raw: unknown, ctx: string): DeprecationConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.deprecated must be a mapping`, { field: 'deprecated' });
  }
  const date = optionalString(raw, 'date', `${ctx}.deprecated`);
  const sunset = optionalString(raw, 'sunset', `${ctx}.deprecated`);
  const replacement = optionalString(raw, 'replacement', `${ctx}.deprecated`);
  return {
    date: date ?? new Date(0).toISOString(),
    ...(sunset !== undefined ? { sunset } : {}),
    ...(replacement !== undefined ? { replacement } : {}),
  };
}

/** Parse an optional `hateoas:` list of { rel, href } entries. */
function validateHateoasEntries(raw: unknown, ctx: string): readonly HateoasLinkEntry[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.hateoas must be an array`, { field: 'hateoas' });
  }
  return raw.map((item, i) => {
    if (!isRecord(item)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.hateoas[${i}] must be a mapping`, { context: ctx });
    }
    const rel = requireString(item, 'rel', `${ctx}.hateoas[${i}]`);
    const href = requireString(item, 'href', `${ctx}.hateoas[${i}]`);
    return { rel, href };
  });
}

/** Parse an optional `mask:` list of field names (RFC 6901 pointers or bare names). */
function validateMaskFields(raw: unknown, ctx: string): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.mask must be an array of field names`, { field: 'mask' });
  }
  return raw.map((item, i) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.mask[${i}] must be a non-empty string`, { context: ctx });
    }
    return item;
  });
}

// ---------------------------------------------------------------------------
// Global config validation (sagas, idempotency, derived_projections)
// ---------------------------------------------------------------------------

function validateSagaCompensation(raw: unknown, ctx: string): SagaCompensation {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  const intentRaw = requireString(raw, 'intent', ctx);
  if (intentRaw !== 'creation' && intentRaw !== 'mutation' && intentRaw !== 'query') {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: intent must be creation|mutation|query`, { context: ctx });
  }
  const operationId = requireString(raw, 'operationId', ctx);
  const targetId = optionalString(raw, 'target_id', ctx);
  if (targetId !== undefined) {
    try {
      celEvaluator.compile(targetId);
    } catch (err) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: target_id is not a valid CEL expression: ${err instanceof Error ? err.message : String(err)}`,
        { field: 'target_id', context: ctx, expression: targetId },
      );
    }
  }
  const payload = requireStringStringMap(raw, 'payload', ctx);
  return {
    intent: intentRaw,
    operationId,
    ...(targetId !== undefined ? { targetId } : {}),
    ...(payload !== undefined ? { payload } : {}),
  };
}

function validateSagaStep(raw: unknown, idx: number): SagaStep {
  const ctx = `sagas[].steps[${idx}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  const name = requireString(raw, 'name', ctx);
  const boundary = requireString(raw, 'boundary', ctx);
  const intentRaw = requireString(raw, 'intent', ctx);
  if (intentRaw !== 'creation' && intentRaw !== 'mutation' && intentRaw !== 'query') {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: intent must be creation|mutation|query`, { context: ctx });
  }
  const operationId = requireString(raw, 'operationId', ctx);
  const targetId = optionalString(raw, 'target_id', ctx);
  if (targetId !== undefined) {
    try {
      celEvaluator.compile(targetId);
    } catch (err) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: target_id is not a valid CEL expression: ${err instanceof Error ? err.message : String(err)}`,
        { field: 'target_id', context: ctx, expression: targetId },
      );
    }
  }
  const payload = requireStringStringMap(raw, 'payload', ctx);
  let compensation: SagaCompensation | undefined;
  if (raw['compensation'] !== undefined && raw['compensation'] !== null) {
    compensation = validateSagaCompensation(raw['compensation'], `${ctx}.compensation`);
  }
  return {
    name,
    boundary,
    intent: intentRaw,
    operationId,
    ...(targetId !== undefined ? { targetId } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(compensation !== undefined ? { compensation } : {}),
  };
}

function validateSagaTrigger(raw: unknown, ctx: string): SagaTrigger {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  const boundary = requireString(raw, 'boundary', ctx);
  const intentRaw = requireString(raw, 'intent', ctx);
  if (intentRaw !== 'creation' && intentRaw !== 'mutation' && intentRaw !== 'query') {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: intent must be creation|mutation|query`, { context: ctx });
  }
  const condition = requireString(raw, 'condition', ctx);
  try {
    celEvaluator.compile(condition);
  } catch (err) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.condition: invalid CEL: ${err instanceof Error ? err.message : String(err)}`, { context: ctx });
  }
  return { boundary, intent: intentRaw, condition };
}

function validateSagaConfig(raw: unknown, idx: number): SagaConfig {
  const ctx = `sagas[${idx}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  const name = requireString(raw, 'name', ctx);
  if (!isRecord(raw['trigger'])) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "trigger" must be an object`, { context: ctx });
  }
  const trigger = validateSagaTrigger(raw['trigger'], `${ctx}.trigger`);
  if (!Array.isArray(raw['steps'])) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "steps" must be an array`, { context: ctx });
  }
  const steps = (raw['steps'] as unknown[]).map((s, i) => validateSagaStep(s, i));
  return { name, trigger, steps };
}

function validateIdempotencyConfig(raw: unknown): IdempotencyConfig {
  const ctx = 'idempotency';
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  const enabled = raw['enabled'] !== false; // default true
  const ttlSeconds = typeof raw['ttl_seconds'] === 'number' ? raw['ttl_seconds'] : 86400;
  const hashIncludesBody = raw['hash_includes_body'] !== false; // default true
  return { enabled, ttlSeconds, hashIncludesBody };
}

function validateDerivedProjectionReduceEntry(raw: unknown, idx: number): DerivedProjectionReduceEntry {
  const ctx = `derived_projections[].reduce[${idx}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  // The legacy assign:/append: reducer map form was removed. Reject it here so
  // derived-projection reduce entries are consistent with boundary reducers.
  assertNoRemovedReducerKeys(raw, ctx);
  const on = requireString(raw, 'on', ctx);
  const patches = optionalPatchList(raw, ctx);
  return {
    on,
    ...(patches !== undefined ? { patches } : {}),
  };
}

function validateDerivedProjectionConfig(raw: unknown, idx: number): DerivedProjectionConfig {
  const ctx = `derived_projections[${idx}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  const name = requireString(raw, 'name', ctx);
  const key = requireString(raw, 'key', ctx);
  try {
    celEvaluator.compile(key);
  } catch (err) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.key: invalid CEL: ${err instanceof Error ? err.message : String(err)}`, { context: ctx });
  }

  if (!Array.isArray(raw['subscribe'])) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "subscribe" must be an array`, { context: ctx });
  }
  const subscribe = (raw['subscribe'] as unknown[]).map((s, i) => {
    if (typeof s !== 'string') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.subscribe[${i}]: must be a string`, { context: ctx });
    }
    return s;
  });

  if (!Array.isArray(raw['reduce'])) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "reduce" must be an array`, { context: ctx });
  }
  const reduce = (raw['reduce'] as unknown[]).map((r, i) => validateDerivedProjectionReduceEntry(r, i));

  return { name, key, subscribe, reduce };
}

export interface GlobalConfig {
  readonly sagas?: readonly SagaConfig[];
  readonly idempotency?: IdempotencyConfig;
  readonly derivedProjections?: readonly DerivedProjectionConfig[];
  readonly auth?: AuthConfig;
  readonly hateoas?: HateoasConfig;
  readonly versioning?: VersioningConfig;
  readonly securityHeaders?: SecurityHeadersConfig;
  readonly faults?: readonly FaultRule[];
  readonly webhooks?: readonly WebhookConfig[];
  readonly reactions?: readonly ReactionRule[];
}

/**
 * Top-level keys that validateGlobalConfig knows how to parse. Any other
 * top-level key is a BOOT_ERR so misspelled or unsupported blocks are never
 * silently dropped.
 */
const KNOWN_GLOBAL_KEYS: ReadonlySet<string> = new Set([
  'sagas',
  'idempotency',
  'derived_projections',
  'auth',
  'hateoas',
  'versioning',
  'security_headers',
  'fault_rules',
  'webhooks',
  'reactions',
]);

function validateAuthConfig(raw: unknown): AuthConfig {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', 'auth must be a mapping', { received: typeof raw });
  }
  const mode = raw['mode'];
  if (mode !== undefined && mode !== 'simple' && mode !== 'jwt' && mode !== 'session') {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', 'auth.mode must be simple|jwt|session', { mode: typeof mode === 'string' ? mode : null });
  }
  const jwtRaw = raw['jwt'];
  let jwt: JwtAuthConfig | undefined;
  if (jwtRaw !== undefined && jwtRaw !== null) {
    if (!isRecord(jwtRaw)) throw new BootError('BOOT_ERR_DSL_SYNTAX', 'auth.jwt must be a mapping');
    const secret = jwtRaw['secret'];
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'auth.jwt.secret is required');
    }
    const requiredClaims = requireStringStringMap(jwtRaw, 'required_claims', 'auth.jwt');
    jwt = {
      secret,
      ...(typeof jwtRaw['algorithm'] === 'string' ? { algorithm: jwtRaw['algorithm'] as 'HS256' } : {}),
      ...(typeof jwtRaw['issuer'] === 'string' ? { issuer: jwtRaw['issuer'] } : {}),
      ...(typeof jwtRaw['audience'] === 'string' ? { audience: jwtRaw['audience'] } : {}),
      ...(typeof jwtRaw['subject_claim'] === 'string' ? { subjectClaim: jwtRaw['subject_claim'] } : {}),
      ...(typeof jwtRaw['scopes_claim'] === 'string' ? { scopesClaim: jwtRaw['scopes_claim'] } : {}),
      ...(requiredClaims !== undefined ? { requiredClaims } : {}),
    };
  }
  const sessionRaw = raw['session'];
  let session: SessionAuthConfig | undefined;
  if (sessionRaw !== undefined && sessionRaw !== null) {
    if (!isRecord(sessionRaw)) throw new BootError('BOOT_ERR_DSL_SYNTAX', 'auth.session must be a mapping');
    session = {
      ...(typeof sessionRaw['cookie_name'] === 'string' ? { cookieName: sessionRaw['cookie_name'] } : {}),
      ...(typeof sessionRaw['ttl_seconds'] === 'number' ? { ttlSeconds: sessionRaw['ttl_seconds'] } : {}),
      ...(typeof sessionRaw['csrf'] === 'boolean' ? { csrf: sessionRaw['csrf'] } : {}),
      ...(typeof sessionRaw['csrf_header'] === 'string' ? { csrfHeader: sessionRaw['csrf_header'] } : {}),
      ...(typeof sessionRaw['login_path'] === 'string' ? { loginPath: sessionRaw['login_path'] } : {}),
      ...(typeof sessionRaw['logout_path'] === 'string' ? { logoutPath: sessionRaw['logout_path'] } : {}),
    };
  }
  return {
    ...(typeof mode === 'string' ? { mode: mode as 'simple' | 'jwt' | 'session' } : {}),
    ...(jwt !== undefined ? { jwt } : {}),
    ...(session !== undefined ? { session } : {}),
  };
}

/** Parse the global `hateoas:` block. */
function validateGlobalHateoas(raw: unknown): HateoasConfig {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "hateoas" must be a mapping', { received: typeof raw });
  }
  return {
    ...(typeof raw['enabled'] === 'boolean' ? { enabled: raw['enabled'] } : {}),
    ...(typeof raw['base_url'] === 'string' ? { baseUrl: raw['base_url'] } : {}),
    ...(typeof raw['self_links'] === 'boolean' ? { selfLinks: raw['self_links'] } : {}),
  };
}

/** Parse the global `security_headers:` block. */
function validateGlobalSecurityHeaders(raw: unknown): SecurityHeadersConfig {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "security_headers" must be a mapping', { received: typeof raw });
  }
  const customHeaders = requireStringStringMap(raw, 'custom_headers', 'security_headers');
  return {
    ...(typeof raw['enabled'] === 'boolean' ? { enabled: raw['enabled'] } : {}),
    ...(typeof raw['hsts'] === 'boolean' ? { hsts: raw['hsts'] } : {}),
    ...(typeof raw['nosniff'] === 'boolean' ? { nosniff: raw['nosniff'] } : {}),
    ...(typeof raw['frame_deny'] === 'boolean' ? { frame_deny: raw['frame_deny'] } : {}),
    ...(typeof raw['referrer_policy'] === 'string' ? { referrer_policy: raw['referrer_policy'] } : {}),
    ...(customHeaders !== undefined ? { custom_headers: customHeaders } : {}),
  };
}

/** Parse the global `versioning:` block. Exactly one version may be marked default. */
function validateGlobalVersioning(raw: unknown): VersioningConfig {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "versioning" must be a mapping', { received: typeof raw });
  }
  let versions: VersionDecl[] | undefined;
  if (raw['versions'] !== undefined && raw['versions'] !== null) {
    if (!Array.isArray(raw['versions'])) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "versioning.versions" must be an array', { field: 'versioning.versions' });
    }
    versions = (raw['versions'] as unknown[]).map((v, i) => {
      const ctx = `versioning.versions[${i}]`;
      if (!isRecord(v)) {
        throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx} must be a mapping`, { context: ctx });
      }
      const version = requireString(v, 'version', ctx);
      const prefix = requireString(v, 'prefix', ctx);
      return {
        version,
        prefix,
        ...(typeof v['default'] === 'boolean' ? { default: v['default'] } : {}),
      };
    });
    const defaults = versions.filter((v) => v.default === true);
    if (defaults.length > 1) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "versioning" declares more than one default version', {
        defaults: defaults.map((d) => d.version),
      });
    }
  }
  return {
    ...(typeof raw['enabled'] === 'boolean' ? { enabled: raw['enabled'] } : {}),
    ...(versions !== undefined ? { versions } : {}),
  };
}

/** Parse a single `fault_rules[i]` entry into a FaultRule. */
function validateFaultRule(raw: unknown, i: number): FaultRule {
  const ctx = `fault_rules[${i}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx} must be a mapping`, { context: ctx });
  }
  const name = requireString(raw, 'name', ctx);

  const matchRaw = raw['match'];
  if (!isRecord(matchRaw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.match must be a mapping`, { context: ctx });
  }
  const condition = typeof matchRaw['condition'] === 'string' ? matchRaw['condition'] : 'true';
  const headers = requireStringStringMap(matchRaw, 'headers', `${ctx}.match`);
  const potemkin = requireStringStringMap(matchRaw, 'potemkin', `${ctx}.match`);

  // Expand `potemkin:` convenience aliases (e.g. rate_limit) into concrete
  // X-Potemkin-* header matchers.
  const expandedHeaders: Record<string, string> = { ...(headers ?? {}) };
  if (potemkin) {
    for (const [alias, value] of Object.entries(potemkin)) {
      const headerName = POTEMKIN_SIGNAL_ALIASES[alias];
      if (headerName === undefined) {
        throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.match.potemkin: unknown alias "${alias}"`, { context: ctx, alias });
      }
      expandedHeaders[headerName] = value;
    }
  }

  const responseRaw = raw['response'];
  if (!isRecord(responseRaw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.response must be a mapping`, { context: ctx });
  }
  if (typeof responseRaw['status'] !== 'number') {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.response.status must be a number`, { context: ctx });
  }
  const responseHeaders = requireStringStringMap(responseRaw, 'headers', `${ctx}.response`);
  // delay_ms may sit under `response:` or at the top level.
  const delayMs = typeof responseRaw['delay_ms'] === 'number'
    ? responseRaw['delay_ms']
    : (typeof raw['delay_ms'] === 'number' ? raw['delay_ms'] : undefined);

  const intentRaw = matchRaw['intent'];
  const probabilityRaw = matchRaw['probability'];

  return {
    name,
    match: {
      ...(typeof matchRaw['boundary'] === 'string' ? { boundary: matchRaw['boundary'] } : {}),
      ...(typeof intentRaw === 'string' ? { intent: intentRaw as Intent } : {}),
      ...(Object.keys(expandedHeaders).length > 0 ? { headers: expandedHeaders } : {}),
      condition,
      ...(typeof probabilityRaw === 'number' ? { probability: probabilityRaw } : {}),
    },
    response: {
      status: responseRaw['status'],
      ...(responseRaw['body'] !== undefined ? { body: responseRaw['body'] as JsonValue } : {}),
      ...(responseHeaders !== undefined ? { headers: responseHeaders } : {}),
    },
    ...(delayMs !== undefined ? { delay_ms: delayMs } : {}),
  };
}

/** Parse a single `webhooks[i]` entry into a WebhookConfig. */
function validateWebhookConfig(raw: unknown, i: number): WebhookConfig {
  const ctx = `webhooks[${i}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx} must be a mapping`, { context: ctx });
  }
  const name = requireString(raw, 'name', ctx);
  const url = requireString(raw, 'url', ctx);

  const triggerRaw = raw['trigger'];
  if (!isRecord(triggerRaw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.trigger must be a mapping`, { context: ctx });
  }
  const condition = typeof triggerRaw['condition'] === 'string' ? triggerRaw['condition'] : 'true';

  const payload = requireStringStringMap(raw, 'payload', ctx);

  let retry: WebhookConfig['retry'];
  if (raw['retry'] !== undefined && raw['retry'] !== null) {
    if (!isRecord(raw['retry'])) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.retry must be a mapping`, { context: ctx });
    }
    const r = raw['retry'];
    retry = {
      ...(typeof r['maxAttempts'] === 'number' ? { maxAttempts: r['maxAttempts'] } : {}),
      ...(typeof r['delayMs'] === 'number' ? { delayMs: r['delayMs'] } : {}),
    };
  }

  return {
    name,
    trigger: {
      ...(typeof triggerRaw['boundary'] === 'string' ? { boundary: triggerRaw['boundary'] } : {}),
      ...(typeof triggerRaw['intent'] === 'string' ? { intent: triggerRaw['intent'] as Intent } : {}),
      condition,
    },
    url,
    ...(typeof raw['secret'] === 'string' ? { secret: raw['secret'] } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(retry !== undefined ? { retry } : {}),
  };
}

/**
 * Validate a raw global config object parsed from an optional globalYaml string
 * in compileDsl. Unknown top-level keys are a BOOT_ERR.
 */
export function validateGlobalConfig(raw: unknown): GlobalConfig {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config must be a YAML mapping object', { received: typeof raw });
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_GLOBAL_KEYS.has(key)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `Global config: unknown top-level key "${key}". Supported keys: ${[...KNOWN_GLOBAL_KEYS].sort().join(', ')}`,
        { key, supported: [...KNOWN_GLOBAL_KEYS].sort() },
      );
    }
  }

  let sagas: readonly SagaConfig[] | undefined;
  if (raw['sagas'] !== undefined && raw['sagas'] !== null) {
    if (!Array.isArray(raw['sagas'])) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "sagas" must be an array', { field: 'sagas' });
    }
    sagas = (raw['sagas'] as unknown[]).map((s, i) => validateSagaConfig(s, i));
  }

  let idempotency: IdempotencyConfig | undefined;
  if (raw['idempotency'] !== undefined && raw['idempotency'] !== null) {
    idempotency = validateIdempotencyConfig(raw['idempotency']);
  }

  let derivedProjections: readonly DerivedProjectionConfig[] | undefined;
  if (raw['derived_projections'] !== undefined && raw['derived_projections'] !== null) {
    if (!Array.isArray(raw['derived_projections'])) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "derived_projections" must be an array', { field: 'derived_projections' });
    }
    derivedProjections = (raw['derived_projections'] as unknown[]).map((p, i) => validateDerivedProjectionConfig(p, i));
  }

  let auth: AuthConfig | undefined;
  if (raw['auth'] !== undefined && raw['auth'] !== null) {
    auth = validateAuthConfig(raw['auth']);
  }

  let hateoas: HateoasConfig | undefined;
  if (raw['hateoas'] !== undefined && raw['hateoas'] !== null) {
    hateoas = validateGlobalHateoas(raw['hateoas']);
  }

  let versioning: VersioningConfig | undefined;
  if (raw['versioning'] !== undefined && raw['versioning'] !== null) {
    versioning = validateGlobalVersioning(raw['versioning']);
  }

  let securityHeaders: SecurityHeadersConfig | undefined;
  if (raw['security_headers'] !== undefined && raw['security_headers'] !== null) {
    securityHeaders = validateGlobalSecurityHeaders(raw['security_headers']);
  }

  let faults: readonly FaultRule[] | undefined;
  if (raw['fault_rules'] !== undefined && raw['fault_rules'] !== null) {
    if (!Array.isArray(raw['fault_rules'])) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "fault_rules" must be an array', { field: 'fault_rules' });
    }
    faults = (raw['fault_rules'] as unknown[]).map((f, i) => validateFaultRule(f, i));
  }

  let webhooks: readonly WebhookConfig[] | undefined;
  if (raw['webhooks'] !== undefined && raw['webhooks'] !== null) {
    if (!Array.isArray(raw['webhooks'])) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "webhooks" must be an array', { field: 'webhooks' });
    }
    webhooks = (raw['webhooks'] as unknown[]).map((w, i) => validateWebhookConfig(w, i));
  }

  let reactions: readonly ReactionRule[] | undefined;
  if (raw['reactions'] !== undefined && raw['reactions'] !== null) {
    if (!Array.isArray(raw['reactions'])) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "reactions" must be an array', { field: 'reactions' });
    }
    // fileBoundary is undefined — boundary field is required on each entry
    reactions = (raw['reactions'] as unknown[]).map((r, i) => validateReactionRule(r, i, undefined));
  }

  return {
    ...(sagas !== undefined ? { sagas } : {}),
    ...(idempotency !== undefined ? { idempotency } : {}),
    ...(derivedProjections !== undefined ? { derivedProjections } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(hateoas !== undefined ? { hateoas } : {}),
    ...(versioning !== undefined ? { versioning } : {}),
    ...(securityHeaders !== undefined ? { securityHeaders } : {}),
    ...(faults !== undefined ? { faults } : {}),
    ...(webhooks !== undefined ? { webhooks } : {}),
    ...(reactions !== undefined ? { reactions } : {}),
  };
}
