import { BootError } from '../errors.js';
import { firstBareCelReference } from './celInterpolation.js';
import { parsePointer } from '../model/patches.js';
import { lexTemplate } from '../cel/grammar/templateLexer.js';
import type { Intent } from '../contracts/domain.js';
import { isJsonObject, isJsonValue, isRecord } from '../contracts/value.js';
import type { JsonObject, JsonValue } from '../contracts/value.js';
import type { DeprecationConfig, SecurityHeadersConfig } from '../contracts/response.js';
import { POTEMKIN_SIGNAL_ALIASES } from '../contracts/requestSignals.js';
import type {
  AuthConfig,
  BehaviorRule,
  BoundaryConfig,
  ComponentDefinition,
  CoverageConfig,
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
  QueryConfig,
  QuerySortConfig,
  ReactionRule,
  ReducerPatchOp,
  ReducerRule,
  PatchValue,
  RequiresGuard,
  SecondaryCommandSpec,
  SessionAuthConfig,
  SagaConfig,
  SagaStep,
  SagaTrigger,
  SagaCompensation,
  IdempotencyConfig,
  DerivedProjectionConfig,
  DerivedProjectionReduceEntry,
  ExportConfig,
  ExportStatePlan,
  ExportStep,
  UseEntry,
  VersionDecl,
  VersioningConfig,
  WebhookConfig,
} from './types.js';
import type { FallbackConfig, FallbackRule, FallbackRuleMatch, FallbackResponse } from './types.js';
import type {
  DeclaredComputedField,
  DeclaredInternalField,
  DeclaredState,
  FieldKind,
  FieldType,
} from './schemaTypes.js';
import { parse as parseCel } from '../cel/grammar/parser.js';

// Syntax validation is deliberately stateless. Evaluators carry clock and RNG
// state, so the parser must not own one at module scope merely to check CEL
// syntax. Runtime compilation creates the configured evaluator later.
function validateCelSyntax(expression: string): void {
  parseCel(expression);
}

// ---------------------------------------------------------------------------
// Field aliases accepted at parse time (alias → canonical):
//   requires[].condition  (was: expression)
//   postcondition: "<string>"  (was: { expression: "..." })
// All emit a DEBUG log; prefer the canonical names in new YAML.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isIdentityKeySource(
  value: string | undefined,
): value is NonNullable<IdentityKeyConfig['from']> {
  return value === 'path' || value === 'query' || value === 'header' || value === 'payload';
}

function parseIntent(value: unknown, ctx: string): Intent | undefined {
  if (value === undefined) return undefined;
  if (value === 'creation' || value === 'mutation' || value === 'query') return value;
  throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx} must be creation|mutation|query`, {
    context: ctx,
  });
}

function parseAuthMode(value: unknown): AuthConfig['mode'] | undefined {
  if (value === undefined) return undefined;
  if (value === 'simple' || value === 'jwt' || value === 'session') return value;
  throw new BootError('BOOT_ERR_DSL_SYNTAX', 'auth.mode must be simple|jwt|session', {
    mode: typeof value === 'string' ? value : null,
  });
}

function parseParameterType(value: string, ctx: string): ParameterType {
  switch (value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;
    default:
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: invalid parameter type "${value}"`, {
        context: ctx,
      });
  }
}

function parseParameterDefault(
  value: unknown,
  type: ParameterType,
  ctx: string,
  parameterName: string,
): string | number | boolean | undefined {
  if (value === undefined) return undefined;
  if (
    (type === 'string' && typeof value === 'string') ||
    (type === 'number' && typeof value === 'number') ||
    (type === 'boolean' && typeof value === 'boolean')
  ) {
    return value;
  }
  throw new BootError(
    'BOOT_ERR_DSL_SYNTAX',
    `${ctx}: parameter "${parameterName}" default value type mismatch — declared type is ${type} but default is ${typeof value} (${JSON.stringify(value)})`,
    { field: `${ctx}.default`, context: ctx },
  );
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

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
): string | undefined {
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

function optionalJsonValue(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
): JsonValue | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (!isJsonValue(value)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.${key} must be a JSON value`, {
      field: key,
      context: ctx,
    });
  }
  return value;
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
  const result: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: field "${key}.${k}" must be a string (got ${JSON.stringify(val)})`,
        { field: `${key}.${k}`, context: ctx },
      );
    }
    result[k] = val;
  }
  return result;
}

/** Validate one YAML expression with the CEL compiler at parse time. */
function validateCel(value: string, fieldCtx: string): void {
  try {
    validateCelSyntax(value);
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
 * interpolations. Each EXPR token is extracted and parsed for CEL syntax so
 * a malformed expression causes a BOOT_ERR_DSL_SYNTAX halt instead of a runtime
 * 500. Non-string values and strings without ${} are safe to skip.
 */
function validatePatchValueCel(value: unknown, fieldCtx: string): void {
  if (typeof value !== 'string') return;
  if (!value.includes('${')) return;
  for (const tok of lexTemplate(value)) {
    if (tok.type !== 'EXPR') continue;
    try {
      validateCelSyntax(tok.src);
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

function validateRequiresGuard<Phase extends string = 'behavior'>(
  raw: unknown,
  ctx: string,
): RequiresGuard<never, Phase> {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: requires entry must be an object`, {
      context: ctx,
    });
  }
  const name = requireString(raw, 'name', ctx);
  const conditionRaw = raw['condition'];
  if (typeof conditionRaw !== 'string' || conditionRaw.trim() === '') {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: requires entry must have a non-empty "condition" field`,
      { context: ctx },
    );
  }
  const condition: string = conditionRaw;
  validateCel(condition, `${ctx}.condition`);

  const errorCodeRaw = raw['error_code'];
  const errorMessageRaw = raw['error_message'];

  const errorCode = typeof errorCodeRaw === 'string' ? errorCodeRaw : '';
  const errorMessage = typeof errorMessageRaw === 'string' ? errorMessageRaw : '';

  // "message" field is also accepted (design.md uses message)
  const messageRaw = raw['message'];
  const resolvedMessage =
    errorMessage !== '' ? errorMessage : typeof messageRaw === 'string' ? messageRaw : '';

  const errorStatusRaw = raw['error_status'];
  let errorStatus: number | undefined;
  if (errorStatusRaw !== undefined) {
    if (
      typeof errorStatusRaw !== 'number' ||
      !Number.isInteger(errorStatusRaw) ||
      errorStatusRaw < 400 ||
      errorStatusRaw > 599
    ) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: error_status must be an integer HTTP status between 400 and 599`,
        { field: 'error_status', context: ctx },
      );
    }
    errorStatus = errorStatusRaw;
  }

  return {
    name,
    condition,
    errorCode,
    errorMessage: resolvedMessage,
    ...(errorStatus === undefined ? {} : { errorStatus }),
  };
}

function validateEmitWhenEntry(raw: unknown, ctx: string): EmitWhenEntry {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: emit_when entry must be an object`, {
      context: ctx,
    });
  }
  const when = requireString(raw, 'when', ctx);
  const emit = requireString(raw, 'emit', ctx);
  validateCel(when, `${ctx}.when`);
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
    validateCelSyntax(targetId);
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
    validateCel(condition, `${ctx}.condition`);
  }

  // Pre-compile each CEL expression in payload values to catch syntax errors at boot time.
  if (payload !== undefined) {
    for (const [fieldKey, celExpr] of Object.entries(payload)) {
      try {
        validateCelSyntax(celExpr);
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
    operationId,
    targetId,
    ...(payload !== undefined ? { payload } : {}),
    ...(condition !== undefined ? { condition } : {}),
  };
}

/** Keys allowed inside a behavior `match:` block. */
const KNOWN_BEHAVIOR_MATCH_KEYS: ReadonlySet<string> = new Set([
  'operationId',
  'condition',
  'method',
  'headers',
  'requires',
  'required_scopes',
]);

function validateBehaviorRule(raw: unknown, index: number): BehaviorRule {
  const ctx = `behaviors[${index}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  const name = requireString(raw, 'name', ctx);
  const responseStatusRaw = raw['response_status'];
  let responseStatus: number | undefined;
  if (responseStatusRaw !== undefined && responseStatusRaw !== null) {
    if (
      typeof responseStatusRaw !== 'number' ||
      !Number.isInteger(responseStatusRaw) ||
      responseStatusRaw < 100 ||
      responseStatusRaw > 599
    ) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.response_status must be an HTTP status integer between 100 and 599`,
        { field: 'response_status', context: ctx },
      );
    }
    responseStatus = responseStatusRaw;
  }
  const matchRaw = raw['match'];
  if (!isRecord(matchRaw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "match" must be an object`, {
      field: 'match',
      context: ctx,
    });
  }
  // Fail-fast on unknown match keys so typos (and dropped syntax like the former
  // `intent`) are rejected at boot rather than silently ignored.
  for (const key of Object.keys(matchRaw)) {
    if (!KNOWN_BEHAVIOR_MATCH_KEYS.has(key)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.match: unknown key "${key}" — supported keys: ${[...KNOWN_BEHAVIOR_MATCH_KEYS].sort().join(', ')}`,
        { field: `match.${key}`, context: ctx },
      );
    }
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
  validateCel(condition, `${ctx}.match.condition`);

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
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.match: "requires" must be an array`, {
        field: 'match.requires',
        context: ctx,
      });
    }
    requires = requiresRaw.map((item, i) =>
      validateRequiresGuard(item, `${ctx}.match.requires[${i}]`),
    );
  }

  // emit (optional) vs emit_when (conditional multi-emit); they are mutually exclusive
  const emitRaw = raw['emit'];
  const emitWhenRaw = raw['emit_when'];
  const dispatchRaw = raw['dispatch_commands'];

  if (
    emitRaw !== undefined &&
    emitRaw !== null &&
    emitWhenRaw !== undefined &&
    emitWhenRaw !== null
  ) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}: "emit" and "emit_when" are mutually exclusive — use one or the other`,
      { field: 'emit', context: ctx },
    );
  }

  // A behavior may emit an event, emit conditionally, or be dispatch-only.
  // Dispatch-only behaviors are useful for commands whose primary boundary is
  // intentionally unchanged while secondary work is still part of the same
  // unit of work. The TypeScript builder already exposes this shape, so YAML
  // must accept the same canonical runtime model.
  if (
    (emitRaw === undefined || emitRaw === null) &&
    (emitWhenRaw === undefined || emitWhenRaw === null) &&
    (dispatchRaw === undefined || dispatchRaw === null)
  ) {
    throw new BootError(
      'BOOT_ERR_DSL_EMIT_REQUIRED',
      `${ctx}: behavior must have "emit", "emit_when", or "dispatch_commands"`,
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
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "emit_when" must be an array`, {
        field: 'emit_when',
        context: ctx,
      });
    }
    if (emitWhenRaw.length === 0) {
      throw new BootError(
        'BOOT_ERR_DSL_EMIT_REQUIRED',
        `${ctx}: "emit_when" must have at least one entry`,
        { field: 'emit_when', context: ctx },
      );
    }
    emitWhen = emitWhenRaw.map((item, i) => validateEmitWhenEntry(item, `${ctx}.emit_when[${i}]`));
  }

  // postcondition: a plain CEL string.
  const postconditionRaw = raw['postcondition'];
  let postcondition: string | undefined;
  if (postconditionRaw !== undefined && postconditionRaw !== null) {
    if (typeof postconditionRaw !== 'string') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "postcondition" must be a CEL string`, {
        field: 'postcondition',
        context: ctx,
      });
    }
    postcondition = postconditionRaw;
    validateCel(postcondition, `${ctx}.postcondition`);
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
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "link_name" must be a non-empty string`, {
        field: 'link_name',
        context: ctx,
      });
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
    validateCel(linkConditionRaw, `${ctx}.link_condition`);
    linkCondition = linkConditionRaw;
  }

  let dispatchCommands: readonly SecondaryCommandSpec[] | undefined;
  if (dispatchRaw !== undefined && dispatchRaw !== null) {
    if (!Array.isArray(dispatchRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "dispatch_commands" must be an array`, {
        field: 'dispatch_commands',
        context: ctx,
      });
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
      ...(matchHeaders !== undefined && Object.keys(matchHeaders).length > 0
        ? { headers: matchHeaders }
        : {}),
    },
    ...(emit !== undefined ? { emit } : {}),
    ...(emitWhen !== undefined ? { emitWhen } : {}),
    ...(postcondition !== undefined ? { postcondition } : {}),
    ...(linkName !== undefined ? { linkName } : {}),
    ...(linkCondition !== undefined ? { linkCondition } : {}),
    ...(dispatchCommands !== undefined ? { dispatchCommands } : {}),
    ...(responseStatus !== undefined ? { responseStatus } : {}),
  };
}

/** Keys allowed in a reducer rule (boundary + component reducers). */
const KNOWN_REDUCER_KEYS: ReadonlySet<string> = new Set(['on', 'patches', 'replace_state']);

function validateReducerRule(raw: unknown, index: number): ReducerRule {
  const ctx = `reducers[${index}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  // Reducers express state mutation exclusively via `patches:`. Fail-fast on
  // unknown keys so typos and dropped map-forms (assign/append/assignAll) are
  // rejected at boot rather than silently ignored.
  for (const key of Object.keys(raw)) {
    if (!KNOWN_REDUCER_KEYS.has(key)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: unknown key "${key}" — supported keys: ${[...KNOWN_REDUCER_KEYS].sort().join(', ')}`,
        { key, context: ctx },
      );
    }
  }
  const on = requireString(raw, 'on', ctx);

  const patches = optionalPatchList(raw, ctx);

  let replaceState: boolean | undefined;
  if (raw['replace_state'] !== undefined) {
    const v = raw['replace_state'];
    if (typeof v !== 'boolean') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.replace_state: must be a boolean`, {
        context: ctx,
      });
    }
    replaceState = v;
  }

  return {
    on,
    ...(patches !== undefined ? { patches } : {}),
    ...(replaceState !== undefined ? { replaceState } : {}),
  };
}

function optionalPatchList(
  raw: Record<string, unknown>,
  ctx: string,
): readonly ReducerPatchOp[] | undefined {
  const val = raw['patches'];
  if (val === undefined) return undefined;
  if (!Array.isArray(val)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.patches: must be an array`, {
      context: ctx,
    });
  }
  return val.map((p, i): ReducerPatchOp => {
    if (!isRecord(p)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.patches[${i}]: must be an object`, {
        context: ctx,
      });
    }
    const op = p['op'];
    if (!isReducerPatchOperation(op)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.patches[${i}].op: invalid op "${String(op)}"`,
        { context: ctx },
      );
    }
    const path = p['path'];
    if (typeof path !== 'string') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.patches[${i}].path: must be a string`, {
        context: ctx,
      });
    }
    // Reject paths containing ${...} — patch paths are NOT CEL-interpolated;
    // a dollar-brace in a path creates a literal key with that name, silently
    // corrupting state instead of evaluating a dynamic expression.
    if (path.includes('${')) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.patches[${i}].path: "${path}" contains \${...} — patch paths are not CEL-interpolated; use a literal RFC 6901 pointer`,
        { context: ctx, path },
      );
    }
    // Validate that the path is a well-formed RFC 6901 JSON Pointer (must be
    // empty string or start with '/'). Call parsePointer so invalid values
    // surface at boot rather than exploding on the first matching event.
    try {
      parsePointer(path);
    } catch {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.patches[${i}].path: "${path}" is not a valid RFC 6901 JSON Pointer (must start with '/')`,
        { context: ctx, path },
      );
    }
    // Per-op required-field validation: each op declares which companion fields
    // it consumes at runtime (the YAML compiler resolves it before compilation).
    // Missing required fields default silently there — catch them here at boot.
    if (op === 'move' || op === 'copy') {
      if (p['from'] === undefined) {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `${ctx}.patches[${i}]: op "${op}" requires "from"`,
          { context: ctx, op, field: 'from' },
        );
      }
    }
    if (op === 'upsert') {
      if (p['key'] === undefined) {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `${ctx}.patches[${i}]: op "upsert" requires "key"`,
          { context: ctx, op, field: 'key' },
        );
      }
    }
    if (op === 'add' || op === 'replace' || op === 'append' || op === 'prepend' || op === 'merge') {
      if (!Object.prototype.hasOwnProperty.call(p, 'value')) {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `${ctx}.patches[${i}]: op "${op}" requires "value" (may be null, false, or 0)`,
          { context: ctx, op, field: 'value' },
        );
      }
    }
    const patchValue = p['value'];
    if (patchValue !== undefined && !isPatchValue(patchValue)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.patches[${i}].value: must be a JSON-compatible patch value`,
        { context: ctx, path },
      );
    }
    const patchBy = p['by'];
    if (patchBy !== undefined && typeof patchBy !== 'number') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.patches[${i}].by: must be a number`, {
        context: ctx,
      });
    }
    const patchKey = p['key'];
    if (patchKey !== undefined && typeof patchKey !== 'string') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.patches[${i}].key: must be a string`, {
        context: ctx,
      });
    }
    const patchDeep = p['deep'];
    if (patchDeep !== undefined && typeof patchDeep !== 'boolean') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.patches[${i}].deep: must be a boolean`, {
        context: ctx,
      });
    }
    const patchFrom = p['from'];
    if (patchFrom !== undefined && typeof patchFrom !== 'string') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.patches[${i}].from: must be a string`, {
        context: ctx,
      });
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
      for (const [k, v] of Object.entries(patchValue)) {
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
      op,
      path,
      ...(patchValue === undefined ? {} : { value: patchValue }),
      ...(patchBy === undefined ? {} : { by: patchBy }),
      ...(patchKey === undefined ? {} : { key: patchKey }),
      ...(patchDeep === undefined ? {} : { deep: patchDeep }),
      ...(patchFrom === undefined ? {} : { from: patchFrom }),
    };
  });
}

function isReducerPatchOperation(value: unknown): value is ReducerPatchOp['op'] {
  switch (value) {
    case 'add':
    case 'remove':
    case 'replace':
    case 'append':
    case 'prepend':
    case 'increment':
    case 'merge':
    case 'upsert':
    case 'move':
    case 'copy':
      return true;
    default:
      return false;
  }
}

function isPatchValue(value: unknown): value is PatchValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    Array.isArray(value) ||
    isRecord(value)
  );
}

function validateEventCatalogEntry(raw: unknown, index: number): EventCatalogEntry {
  const ctx = `event_catalog[${index}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  const type = requireString(raw, 'type', ctx);
  const payloadTemplate = requireStringStringMap(raw, 'payload_template', ctx) ?? {};

  for (const [field, expr] of Object.entries(payloadTemplate)) {
    validateCel(expr, `${ctx}.payload_template.${field}`);
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
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "identity.key" must be an object`, {
      field: 'identity.key',
      context: ctx,
    });
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
  if (!isIdentityKeySource(from)) {
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
    from,
    ...(name !== undefined ? { name } : {}),
    ...(pointer !== undefined ? { pointer } : {}),
  };
}

function validateIdentityConfig(raw: unknown, ctx: string): IdentityConfig {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "identity" must be an object`, {
      field: 'identity',
      context: ctx,
    });
  }

  let creation: IdentityConfig['creation'];
  const creationRaw = raw['creation'];
  if (creationRaw !== undefined && creationRaw !== null) {
    if (!isRecord(creationRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "identity.creation" must be an object`, {
        field: 'identity.creation',
        context: ctx,
      });
    }
    const generate = optionalString(creationRaw, 'generate', `${ctx}.creation`);
    creation = generate !== undefined ? { generate } : {};
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

function validateQueryConfig(raw: unknown, ctx: string): QueryConfig {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "query" must be an object`, {
      field: 'query',
      context: ctx,
    });
  }
  const known = new Set([
    'fields',
    'filter',
    'sort',
    'page_size',
    'max_page_size',
    'cursor',
    'expand',
    'pagination',
    'include_deleted',
    'fallback',
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: unknown query key "${key}" — supported keys: ${[...known].sort().join(', ')}`,
        { field: `query.${key}`, context: ctx },
      );
    }
  }

  const fields = requireStringStringMap(raw, 'fields', `${ctx}.query`);
  if (fields !== undefined) {
    for (const [name, expression] of Object.entries(fields)) {
      validateCel(expression, `${ctx}.query.fields.${name}`);
    }
  }

  const filter = optionalString(raw, 'filter', `${ctx}.query`);
  if (filter !== undefined) validateCel(filter, `${ctx}.query.filter`);

  let sort: readonly QuerySortConfig[] | undefined;
  const sortRaw = raw['sort'];
  if (sortRaw !== undefined && sortRaw !== null) {
    if (!Array.isArray(sortRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.query.sort must be an array`, {
        field: 'query.sort',
        context: ctx,
      });
    }
    sort = sortRaw.map((entry, index) => {
      const sortContext = `${ctx}.query.sort[${index}]`;
      if (!isRecord(entry)) {
        throw new BootError('BOOT_ERR_DSL_SYNTAX', `${sortContext} must be an object`, {
          field: 'query.sort',
          context: ctx,
        });
      }
      for (const key of Object.keys(entry)) {
        if (key !== 'field' && key !== 'direction') {
          throw new BootError(
            'BOOT_ERR_DSL_SYNTAX',
            `${sortContext}: unknown key "${key}" — supported keys: direction, field`,
            { field: `query.sort[${index}].${key}`, context: ctx },
          );
        }
      }
      const field = requireString(entry, 'field', sortContext);
      const direction = optionalString(entry, 'direction', sortContext) ?? 'asc';
      if (direction !== 'asc' && direction !== 'desc') {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `${sortContext}.direction must be asc or desc (got "${direction}")`,
          { field: `query.sort[${index}].direction`, context: ctx, value: direction },
        );
      }
      return { field, direction };
    });
  }

  let pageSize: string | number | undefined;
  const pageSizeRaw = raw['page_size'];
  if (pageSizeRaw !== undefined && pageSizeRaw !== null) {
    if (
      (typeof pageSizeRaw !== 'number' && typeof pageSizeRaw !== 'string') ||
      (typeof pageSizeRaw === 'number' && (!Number.isFinite(pageSizeRaw) || pageSizeRaw < 0)) ||
      (typeof pageSizeRaw === 'string' && pageSizeRaw.trim() === '')
    ) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.query.page_size must be a non-negative number or CEL string`,
        { field: 'query.page_size', context: ctx },
      );
    }
    pageSize = pageSizeRaw;
    if (typeof pageSizeRaw === 'string') validateCel(pageSizeRaw, `${ctx}.query.page_size`);
  }

  let maxPageSize: number | undefined;
  const maxPageSizeRaw = raw['max_page_size'];
  if (maxPageSizeRaw !== undefined && maxPageSizeRaw !== null) {
    if (
      typeof maxPageSizeRaw !== 'number' ||
      !Number.isInteger(maxPageSizeRaw) ||
      maxPageSizeRaw < 0
    ) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.query.max_page_size must be a non-negative integer`,
        { field: 'query.max_page_size', context: ctx },
      );
    }
    maxPageSize = maxPageSizeRaw;
  }

  const cursor = optionalString(raw, 'cursor', `${ctx}.query`);
  if (cursor !== undefined) validateCel(cursor, `${ctx}.query.cursor`);

  let expand: readonly string[] | undefined;
  const expandRaw = raw['expand'];
  if (expandRaw !== undefined && expandRaw !== null) {
    if (!Array.isArray(expandRaw) || !expandRaw.every((entry) => typeof entry === 'string')) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.query.expand must be an array of strings`,
        {
          field: 'query.expand',
          context: ctx,
        },
      );
    }
    expand = expandRaw;
  }

  let pagination: 'raw' | 'envelope' | undefined;
  const paginationRaw = optionalString(raw, 'pagination', `${ctx}.query`);
  if (paginationRaw !== undefined) {
    if (paginationRaw !== 'raw' && paginationRaw !== 'envelope') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.query.pagination must be raw or envelope`,
        { field: 'query.pagination', context: ctx, value: paginationRaw },
      );
    }
    pagination = paginationRaw;
  }

  let includeDeleted: boolean | undefined;
  const includeDeletedRaw = raw['include_deleted'];
  if (includeDeletedRaw !== undefined && includeDeletedRaw !== null) {
    if (typeof includeDeletedRaw !== 'boolean') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.query.include_deleted must be a boolean`, {
        field: 'query.include_deleted',
        context: ctx,
      });
    }
    includeDeleted = includeDeletedRaw;
  }

  let fallback: JsonValue | undefined;
  const fallbackRaw = raw['fallback'];
  if (fallbackRaw !== undefined && fallbackRaw !== null) {
    if (!isJsonValue(fallbackRaw)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.query.fallback must be a JSON value or CEL string`,
        { field: 'query.fallback', context: ctx },
      );
    }
    fallback = fallbackRaw;
    if (typeof fallbackRaw === 'string') validateCel(fallbackRaw, `${ctx}.query.fallback`);
  }

  return {
    ...(fields === undefined ? {} : { fields }),
    ...(filter === undefined ? {} : { filter }),
    ...(sort === undefined ? {} : { sort }),
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(maxPageSize === undefined ? {} : { maxPageSize }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(expand === undefined ? {} : { expand }),
    ...(pagination === undefined ? {} : { pagination }),
    ...(includeDeleted === undefined ? {} : { includeDeleted }),
    ...(fallback === undefined ? {} : { fallback }),
  };
}

function validateInitialization(raw: unknown, ctx: string): readonly JsonObject[] {
  if (!Array.isArray(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "initialization" must be an array`, {
      field: 'initialization',
      context: ctx,
    });
  }
  return raw.map((item, i) => {
    if (!isRecord(item)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.initialization[${i}]: must be an object`, {
        context: ctx,
      });
    }
    if (!isJsonObject(item)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.initialization[${i}]: must be a JSON object`,
        { context: ctx },
      );
    }
    return item;
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
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "with" must be an object`, {
      field: 'with',
      context: ctx,
    });
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
function validateBindMap(raw: unknown, ctx: string): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "bind" must be an object`, {
      field: 'bind',
      context: ctx,
    });
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
export function validateUseEntries(raw: unknown, ctx: string): readonly UseEntry[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "use" must be an array`, {
      field: 'use',
      context: ctx,
    });
  }
  return raw.map((item, i) => {
    const ectx = `${ctx}.use[${i}]`;
    if (!isRecord(item)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ectx}: must be an object`, { context: ectx });
    }
    if (item['component'] === undefined || item['component'] === null) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ectx}: "component" is required`, {
        field: 'component',
        context: ectx,
      });
    }
    const component = requireString(item, 'component', ectx);
    if (item['as'] === undefined || item['as'] === null) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ectx}: "as" is required`, {
        field: 'as',
        context: ectx,
      });
    }
    const as_ = requireString(item, 'as', ectx);
    if (item['contract_path'] === undefined || item['contract_path'] === null) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ectx}: "contract_path" is required`, {
        field: 'contract_path',
        context: ectx,
      });
    }
    const contractPath = requireString(item, 'contract_path', ectx);
    const withBindings = validateWithBindings(item['with'], ectx);
    const bindMap = validateBindMap(item['bind'], ectx);
    const knownUseKeys = new Set(['component', 'as', 'contract_path', 'with', 'bind']);
    for (const key of Object.keys(item)) {
      if (!knownUseKeys.has(key)) {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `${ectx}: unknown key "${key}" — allowed keys are: component, as, contract_path, with, bind`,
          { field: key, context: ectx },
        );
      }
    }
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
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "include" must be an array`, {
      field: 'include',
      context: ctx,
    });
  }
  return raw.map((item, i) => {
    const ectx = `${ctx}.include[${i}]`;
    if (!isRecord(item)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ectx}: must be an object`, { context: ectx });
    }
    if (item['component'] === undefined || item['component'] === null) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ectx}: "component" is required`, {
        field: 'component',
        context: ectx,
      });
    }
    const component = requireString(item, 'component', ectx);
    const withBindings = validateWithBindings(item['with'], ectx);
    const knownIncludeKeys = new Set(['component', 'with']);
    for (const key of Object.keys(item)) {
      if (!knownIncludeKeys.has(key)) {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `${ectx}: unknown key "${key}" — allowed keys are: component, with`,
          { field: key, context: ectx },
        );
      }
    }
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
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "parameters" must be an object`, {
      field: 'parameters',
      context: ctx,
    });
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
    const paramType = parseParameterType(typeRaw, pctx);
    const defaultRaw = entry['default'];
    const requiredRaw = entry['required'];

    // required must be a boolean when present.
    if (requiredRaw !== undefined && typeof requiredRaw !== 'boolean') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${pctx}: "required" must be a boolean (got ${JSON.stringify(requiredRaw)})`,
        { field: `parameters.${paramName}.required`, context: pctx },
      );
    }

    // required: true and default are mutually exclusive.
    if (requiredRaw === true && defaultRaw !== undefined) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${pctx}: parameter "${paramName}" declares both "required: true" and "default" — they are mutually exclusive`,
        { field: `parameters.${paramName}`, context: pctx },
      );
    }

    const defaultValue = parseParameterDefault(defaultRaw, paramType, pctx, paramName);

    const decl: ParameterDecl = {
      type: paramType,
      ...(defaultValue === undefined ? {} : { default: defaultValue }),
      ...(requiredRaw === undefined ? {} : { required: requiredRaw }),
    };
    out[paramName] = decl;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Top-level keys allowed in a component file. */
const KNOWN_COMPONENT_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'name',
  'parameters',
  'event_catalog',
  'reducers',
  'behaviors',
  'identity',
  'state',
  'schema',
  'reactions',
  'include',
  'fallback_override',
  'query',
  'query_mapping',
  'deprecated',
  'hateoas',
  'mask',
  'latency',
  'audit_fields',
  'strict_schema',
  'response',
  'fault_rules',
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
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'component: "event_catalog" must be an array', {
        field: 'event_catalog',
      });
    }
    eventCatalog = eventCatalogRaw.map((item, i) => validateEventCatalogEntry(item, i));
  }

  const reducersRaw = raw['reducers'];
  let reducers: readonly ReducerRule[] | undefined;
  if (reducersRaw !== undefined && reducersRaw !== null) {
    if (!Array.isArray(reducersRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'component: "reducers" must be an array', {
        field: 'reducers',
      });
    }
    reducers = reducersRaw.map((item, i) => validateReducerRule(item, i));
  }

  const behaviorsRaw = raw['behaviors'];
  let behaviors: readonly BehaviorRule[] | undefined;
  if (behaviorsRaw !== undefined && behaviorsRaw !== null) {
    if (!Array.isArray(behaviorsRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'component: "behaviors" must be an array', {
        field: 'behaviors',
      });
    }
    behaviors = behaviorsRaw.map((item, i) => validateBehaviorRule(item, i));
  }

  let identity: IdentityConfig | undefined;
  if (raw['identity'] !== undefined && raw['identity'] !== null) {
    identity = validateIdentityConfig(raw['identity'], 'component');
  }

  const state = validateDeclaredState(raw['state'], 'component');

  let fallbackOverride: boolean | undefined;
  if (raw['fallback_override'] !== undefined) {
    if (typeof raw['fallback_override'] !== 'boolean')
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'component.fallback_override must be a boolean', {
        field: 'fallback_override',
      });
    fallbackOverride = raw['fallback_override'];
  }
  const queryMapping = requireStringStringMap(raw, 'query_mapping', 'component');
  const query =
    raw['query'] === undefined ? undefined : validateQueryConfig(raw['query'], 'component');
  const deprecated = validateDeprecationConfig(raw['deprecated'], 'component');
  const hateoas = validateHateoasEntries(raw['hateoas'], 'component');
  const mask = validateMaskFields(raw['mask'], 'component');
  let strictSchema: boolean | undefined;
  if (raw['strict_schema'] !== undefined) {
    if (typeof raw['strict_schema'] !== 'boolean')
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'component.strict_schema must be a boolean', {
        field: 'strict_schema',
      });
    strictSchema = raw['strict_schema'];
  }
  let auditFields: boolean | undefined;
  if (raw['audit_fields'] !== undefined) {
    if (typeof raw['audit_fields'] !== 'boolean')
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'component.audit_fields must be a boolean', {
        field: 'audit_fields',
      });
    auditFields = raw['audit_fields'];
  }
  let faults: readonly FaultRule[] | undefined;
  if (raw['fault_rules'] !== undefined) {
    if (!Array.isArray(raw['fault_rules']))
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'component.fault_rules must be an array', {
        field: 'fault_rules',
      });
    faults = raw['fault_rules'].map((item, i) => validateFaultRule(item, i));
  }

  let schema: string | undefined;
  if (raw['schema'] !== undefined && raw['schema'] !== null) {
    schema = requireString(raw, 'schema', 'component');
  }

  const reactionsRaw = raw['reactions'];
  let reactions: readonly ReactionRule[] | undefined;
  if (reactionsRaw !== undefined && reactionsRaw !== null) {
    if (!Array.isArray(reactionsRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'component: "reactions" must be an array', {
        field: 'reactions',
      });
    }
    reactions = reactionsRaw.map((item, i) => validateReactionRule(item, i, name));
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
    ...(schema !== undefined ? { schema } : {}),
    ...(fallbackOverride !== undefined ? { fallbackOverride } : {}),
    ...(query !== undefined ? { query } : {}),
    ...(queryMapping !== undefined ? { queryMapping } : {}),
    ...(deprecated !== undefined ? { deprecated } : {}),
    ...(hateoas !== undefined ? { hateoas } : {}),
    ...(mask !== undefined ? { mask } : {}),
    ...(strictSchema !== undefined ? { strictSchema } : {}),
    ...(auditFields !== undefined ? { auditFields } : {}),
    ...(faults !== undefined ? { faults } : {}),
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
 * YamlLinkedProgram.use but contributes no boundary module bodies to global merging.
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
  'boundary',
  'contract_path',
  'fallback_override',
  'identity',
  'query',
  'query_mapping',
  'behaviors',
  'reducers',
  'event_catalog',
  'initialization',
  'deprecated',
  'hateoas',
  'mask',
  'state',
  'strict_schema',
  'latency',
  'audit_fields',
  'fault_rules',
  'reactions',
  'response',
  'schema',
  // Cross-file composition keys (C1)
  'include',
  // Spec-endpoint cross-check keys consumed by configLoader.
  'spec_id',
  'out_of_contract',
  'methods',
  'export',
]);

function validateExportStep(raw: unknown, ctx: string): ExportStep {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx} must be a mapping`, { context: ctx });
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'operationId' && key !== 'body' && key !== 'headers') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: unknown key "${key}" — supported keys: body, headers, operationId`,
        { context: ctx, key },
      );
    }
  }
  const operationId = requireString(raw, 'operationId', ctx);
  const body = raw['body'];
  if (body !== undefined && !isJsonObject(body)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.body must be a JSON object`, {
      context: ctx,
    });
  }
  const headers = requireStringStringMap(raw, 'headers', ctx);
  return {
    operationId,
    ...(body === undefined ? {} : { body }),
    ...(headers === undefined ? {} : { headers }),
  };
}

function validateExportConfig(raw: unknown, ctx: string): ExportConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx} must be a mapping`, { context: ctx });
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'states') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: unknown key "${key}" — supported keys: states`,
        { context: ctx, key },
      );
    }
  }
  const states = raw['states'];
  if (!Array.isArray(states) || states.length === 0) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.states must be a non-empty array`, {
      context: ctx,
    });
  }
  const names = new Set<string>();
  const parsed = states.map((entry, index): ExportStatePlan => {
    const stateCtx = `${ctx}.states[${index}]`;
    if (!isRecord(entry)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${stateCtx} must be a mapping`, {
        context: stateCtx,
      });
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'name' && key !== 'steps' && key !== 'saga') {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `${stateCtx}: unknown key "${key}" — supported keys: name, saga, steps`,
          { context: stateCtx, key },
        );
      }
    }
    const name = requireString(entry, 'name', stateCtx);
    if (names.has(name)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${stateCtx}: duplicate state name "${name}"`, {
        context: stateCtx,
        name,
      });
    }
    names.add(name);
    const steps = entry['steps'];
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${stateCtx}.steps must be a non-empty array`, {
        context: stateCtx,
      });
    }
    const saga = optionalString(entry, 'saga', stateCtx);
    return {
      name,
      steps: steps.map((step, stepIndex) =>
        validateExportStep(step, `${stateCtx}.steps[${stepIndex}]`),
      ),
      ...(saga === undefined ? {} : { saga }),
    };
  });
  return { states: parsed };
}

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
    if (typeof boundaryRaw !== 'string' || boundaryRaw.trim() === '') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: optional field "boundary" must be a string (got ${JSON.stringify(boundaryRaw)})`,
        { field: 'boundary', context: ctx },
      );
    }
    boundary = boundaryRaw;
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
      validateCelSyntax(when);
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
      validateCelSyntax(target);
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
        validateCelSyntax(celExpr);
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
    throw new BootError('BOOT_ERR_DSL_SYNTAX', 'DSL module root must be a YAML mapping object', {
      received: typeof raw,
    });
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
  const query = raw['query'] === undefined ? undefined : validateQueryConfig(raw['query'], 'root');

  const behaviorsRaw = raw['behaviors'];
  let behaviors: readonly BehaviorRule[] = [];
  if (behaviorsRaw !== undefined && behaviorsRaw !== null) {
    if (!Array.isArray(behaviorsRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'root: "behaviors" must be an array', {
        field: 'behaviors',
      });
    }
    behaviors = behaviorsRaw.map((item, i) => validateBehaviorRule(item, i));
  }

  const reducersRaw = raw['reducers'];
  let reducers: readonly ReducerRule[] = [];
  if (reducersRaw !== undefined && reducersRaw !== null) {
    if (!Array.isArray(reducersRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'root: "reducers" must be an array', {
        field: 'reducers',
      });
    }
    reducers = reducersRaw.map((item, i) => validateReducerRule(item, i));
  }

  const eventCatalogRaw = raw['event_catalog'];
  let eventCatalog: readonly EventCatalogEntry[] = [];
  if (eventCatalogRaw !== undefined && eventCatalogRaw !== null) {
    if (!Array.isArray(eventCatalogRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'root: "event_catalog" must be an array', {
        field: 'event_catalog',
      });
    }
    eventCatalog = eventCatalogRaw.map((item, i) => validateEventCatalogEntry(item, i));
  }

  let initialization: readonly JsonObject[] | undefined;
  if (raw['initialization'] !== undefined && raw['initialization'] !== null) {
    initialization = validateInitialization(raw['initialization'], 'root');
  }

  const deprecated = validateDeprecationConfig(raw['deprecated'], 'root');
  const hateoas = validateHateoasEntries(raw['hateoas'], 'root');
  const mask = validateMaskFields(raw['mask'], 'root');
  const state = validateDeclaredState(raw['state'], 'root');

  let strictSchema: boolean | undefined;
  if (raw['strict_schema'] !== undefined) {
    const v = raw['strict_schema'];
    if (typeof v !== 'boolean') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `root: "strict_schema" must be a boolean`, {
        field: 'strict_schema',
      });
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
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'root: "fault_rules" must be an array', {
        field: 'fault_rules',
      });
    }
    faults = faultRulesRaw.map((item, i) => validateFaultRule(item, i));
  }

  let reactions: readonly ReactionRule[] | undefined;
  const reactionsRaw = raw['reactions'];
  if (reactionsRaw !== undefined && reactionsRaw !== null) {
    if (!Array.isArray(reactionsRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'root: "reactions" must be an array', {
        field: 'reactions',
      });
    }
    reactions = reactionsRaw.map((item, i) => validateReactionRule(item, i, boundary));
  }

  let response: string | undefined;
  if (raw['response'] !== undefined && raw['response'] !== null) {
    response = requireString(raw, 'response', 'root');
  }

  const include = validateIncludeEntries(raw['include'], 'root');
  const exportConfig = validateExportConfig(raw['export'], 'root.export');

  let schema: string | undefined;
  if (raw['schema'] !== undefined && raw['schema'] !== null) {
    if (typeof raw['schema'] !== 'string' || raw['schema'].length === 0) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `root: "schema" must be a non-empty string (a components.schemas name)`,
        { field: 'schema' },
      );
    }
    schema = raw['schema'];
  }

  crossValidate({ behaviors, reducers, eventCatalog, boundary });

  return {
    boundary,
    contractPath,
    ...(schema !== undefined ? { schema } : {}),
    fallbackOverride,
    ...(identity !== undefined ? { identity } : {}),
    ...(query !== undefined ? { query } : {}),
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
    ...(response === undefined ? {} : { response }),
    ...(include !== undefined ? { include } : {}),
    ...(exportConfig !== undefined ? { export: exportConfig } : {}),
  };
}

/**
 * Parse an optional `state:` block of declared computed and internal fields.
 * computed entries are { name, formula, depends_on } — the formula is a CEL
 * expression compiled at parse time. internal entries are { name, type }
 * where type names a scalar/array/object field kind.
 */
function validateDeclaredState(raw: unknown, ctx: string): DeclaredState | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.state must be a mapping`, {
      field: 'state',
    });
  }

  let computed: DeclaredComputedField[] | undefined;
  const computedRaw = raw['computed'];
  if (computedRaw !== undefined && computedRaw !== null) {
    if (!Array.isArray(computedRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.state.computed must be an array`, {
        field: 'state.computed',
      });
    }
    computed = computedRaw.map((item, i) => {
      const ictx = `${ctx}.state.computed[${i}]`;
      if (!isRecord(item)) {
        throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ictx} must be a mapping`, { context: ictx });
      }
      const name = requireString(item, 'name', ictx);
      const formula = requireString(item, 'formula', ictx);
      try {
        validateCelSyntax(formula);
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
          throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ictx}.depends_on must be an array`, {
            context: ictx,
          });
        }
        dependsOn = dependsOnRaw.map((d, j) => {
          if (typeof d !== 'string' || d.trim() === '') {
            throw new BootError(
              'BOOT_ERR_DSL_SYNTAX',
              `${ictx}.depends_on[${j}] must be a non-empty string`,
              { context: ictx },
            );
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
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.state.internal must be an array`, {
        field: 'state.internal',
      });
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

const SCALAR_FIELD_KINDS = new Set([
  'string',
  'integer',
  'number',
  'boolean',
  'null',
  'array',
  'object',
]);

function fieldTypeFromName(typeName: string, ctx: string): FieldType {
  if (!SCALAR_FIELD_KINDS.has(typeName)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}.type "${typeName}" is not a known field kind (${[...SCALAR_FIELD_KINDS].join(', ')})`,
      { context: ctx, type: typeName },
    );
  }
  if (!isFieldKind(typeName)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.type "${typeName}" is not a field kind`, {
      context: ctx,
    });
  }
  return { kind: typeName, confidence: 'known' };
}

function isFieldKind(value: string): value is FieldKind {
  switch (value) {
    case 'string':
    case 'integer':
    case 'number':
    case 'boolean':
    case 'null':
    case 'array':
    case 'object':
    case 'unknown':
      return true;
    default:
      return false;
  }
}

/** Parse an optional `deprecated:` envelope { date?, sunset?, replacement? }. */
function validateDeprecationConfig(raw: unknown, ctx: string): DeprecationConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.deprecated must be a mapping`, {
      field: 'deprecated',
    });
  }
  const date = optionalString(raw, 'date', `${ctx}.deprecated`);
  if (date !== undefined && !Number.isFinite(new Date(date).getTime())) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}.deprecated.date: "${date}" is not a parseable date — use an ISO-8601 or RFC-2822 date string`,
      { field: `${ctx}.deprecated.date`, value: date },
    );
  }
  const sunset = optionalString(raw, 'sunset', `${ctx}.deprecated`);
  const replacement = optionalString(raw, 'replacement', `${ctx}.deprecated`);
  return {
    date: date ?? new Date(0).toISOString(),
    ...(sunset !== undefined ? { sunset } : {}),
    ...(replacement !== undefined ? { replacement } : {}),
  };
}

/** Parse an optional `hateoas:` list of { rel, href } entries. */
function validateHateoasEntries(
  raw: unknown,
  ctx: string,
): readonly HateoasLinkEntry[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.hateoas must be an array`, {
      field: 'hateoas',
    });
  }
  return raw.map((item, i) => {
    if (!isRecord(item)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.hateoas[${i}] must be a mapping`, {
        context: ctx,
      });
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
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.mask must be an array of field names`, {
      field: 'mask',
    });
  }
  return raw.map((item, i) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.mask[${i}] must be a non-empty string`, {
        context: ctx,
      });
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
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: intent must be creation|mutation|query`, {
      context: ctx,
    });
  }
  const operationId = requireString(raw, 'operationId', ctx);
  const targetId = optionalString(raw, 'target_id', ctx);
  if (targetId !== undefined) {
    try {
      validateCelSyntax(targetId);
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
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: intent must be creation|mutation|query`, {
      context: ctx,
    });
  }
  const operationId = requireString(raw, 'operationId', ctx);
  const targetId = optionalString(raw, 'target_id', ctx);
  if (targetId !== undefined) {
    try {
      validateCelSyntax(targetId);
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
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: intent must be creation|mutation|query`, {
      context: ctx,
    });
  }
  const condition = requireString(raw, 'condition', ctx);
  try {
    validateCelSyntax(condition);
  } catch (err) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}.condition: invalid CEL: ${err instanceof Error ? err.message : String(err)}`,
      { context: ctx },
    );
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
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "trigger" must be an object`, {
      context: ctx,
    });
  }
  const trigger = validateSagaTrigger(raw['trigger'], `${ctx}.trigger`);
  if (!Array.isArray(raw['steps'])) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "steps" must be an array`, {
      context: ctx,
    });
  }
  const steps = raw['steps'].map((s, i) => validateSagaStep(s, i));
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

function validateDerivedProjectionReduceEntry(
  raw: unknown,
  idx: number,
): DerivedProjectionReduceEntry {
  const ctx = `derived_projections[].reduce[${idx}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be an object`, { context: ctx });
  }
  // Fail-fast on unknown keys, consistent with boundary reducers — derived
  // reduce entries support only on + patches.
  for (const key of Object.keys(raw)) {
    if (key !== 'on' && key !== 'patches') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}: unknown key "${key}" — supported keys: on, patches`,
        { key, context: ctx },
      );
    }
  }
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
    validateCelSyntax(key);
  } catch (err) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}.key: invalid CEL: ${err instanceof Error ? err.message : String(err)}`,
      { context: ctx },
    );
  }

  if (!Array.isArray(raw['subscribe'])) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "subscribe" must be an array`, {
      context: ctx,
    });
  }
  const subscribe = raw['subscribe'].map((s, i) => {
    if (typeof s !== 'string') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.subscribe[${i}]: must be a string`, {
        context: ctx,
      });
    }
    return s;
  });

  if (!Array.isArray(raw['reduce'])) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: "reduce" must be an array`, {
      context: ctx,
    });
  }
  const reduce = raw['reduce'].map((r, i) => validateDerivedProjectionReduceEntry(r, i));

  return { name, key, subscribe, reduce };
}

export interface GlobalConfig<E = never> {
  readonly sagas?: readonly SagaConfig<E>[];
  readonly idempotency?: IdempotencyConfig;
  readonly derivedProjections?: readonly DerivedProjectionConfig<E>[];
  readonly auth?: AuthConfig;
  readonly hateoas?: HateoasConfig;
  readonly versioning?: VersioningConfig;
  readonly securityHeaders?: SecurityHeadersConfig;
  readonly faults?: readonly FaultRule<E>[];
  readonly webhooks?: readonly WebhookConfig<E>[];
  readonly reactions?: readonly ReactionRule<E>[];
  readonly fallback?: FallbackConfig;
  readonly coverage?: Readonly<Record<string, CoverageConfig>>;
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
  'fallback',
  'coverage',
]);

function validateStringList(value: unknown, context: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${context} must be an array of strings`, {
      context,
    });
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${context}[${index}] must be a non-empty string`,
        { context, index },
      );
    }
    return entry;
  });
}

function validateCoverageConfig(raw: unknown): Readonly<Record<string, CoverageConfig>> {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', 'coverage must be a mapping of aggregate names');
  }
  const result: Record<string, CoverageConfig> = {};
  for (const [aggregate, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) {
      throw new BootError(`BOOT_ERR_DSL_SYNTAX`, `coverage.${aggregate} must be a mapping`, {
        aggregate,
      });
    }
    const allowed = new Set([
      'strict',
      'initial_states',
      'terminal_states',
      'operations',
      'suppress_states',
    ]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        throw new BootError('BOOT_ERR_DSL_SYNTAX', `coverage.${aggregate}: unknown key "${key}"`, {
          aggregate,
          key,
        });
      }
    }
    const strict = entry['strict'];
    if (strict !== undefined && typeof strict !== 'boolean') {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `coverage.${aggregate}.strict must be boolean`, {
        aggregate,
      });
    }
    const initialStates =
      entry['initial_states'] === undefined
        ? undefined
        : validateStringList(entry['initial_states'], `coverage.${aggregate}.initial_states`);
    const terminalStates =
      entry['terminal_states'] === undefined
        ? undefined
        : validateStringList(entry['terminal_states'], `coverage.${aggregate}.terminal_states`);
    const operations =
      entry['operations'] === undefined
        ? undefined
        : validateStringList(entry['operations'], `coverage.${aggregate}.operations`);
    const suppressStates =
      entry['suppress_states'] === undefined
        ? undefined
        : validateStringList(entry['suppress_states'], `coverage.${aggregate}.suppress_states`);
    result[aggregate] = {
      ...(strict === undefined ? {} : { strict }),
      ...(initialStates === undefined ? {} : { initial_states: initialStates }),
      ...(terminalStates === undefined ? {} : { terminal_states: terminalStates }),
      ...(operations === undefined ? {} : { operations }),
      ...(suppressStates === undefined ? {} : { suppress_states: suppressStates }),
    };
  }
  return result;
}

function validateAuthConfig(raw: unknown): AuthConfig {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', 'auth must be a mapping', { received: typeof raw });
  }
  const mode = parseAuthMode(raw['mode']);
  const jwtRaw = raw['jwt'];
  let jwt: JwtAuthConfig | undefined;
  if (jwtRaw !== undefined && jwtRaw !== null) {
    if (!isRecord(jwtRaw)) throw new BootError('BOOT_ERR_DSL_SYNTAX', 'auth.jwt must be a mapping');
    const secret = jwtRaw['secret'];
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'auth.jwt.secret is required');
    }
    const requiredClaims = requireStringStringMap(jwtRaw, 'required_claims', 'auth.jwt');
    // The engine's own gateway validator only implements HS256. Reject any other
    // value loudly rather than silently casting it — RS256/JWKS is handled by the
    // Specmatic plugin (the canonical auth front door), not the standalone engine.
    if (jwtRaw['algorithm'] !== undefined && jwtRaw['algorithm'] !== 'HS256') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `auth.jwt.algorithm: only "HS256" is supported by the engine (got ${JSON.stringify(jwtRaw['algorithm'])}) — RS256/JWKS is enforced by the Specmatic plugin`,
        { field: 'auth.jwt.algorithm' },
      );
    }
    jwt = {
      secret,
      ...(jwtRaw['algorithm'] === 'HS256' ? { algorithm: 'HS256' } : {}),
      ...(typeof jwtRaw['issuer'] === 'string' ? { issuer: jwtRaw['issuer'] } : {}),
      ...(typeof jwtRaw['audience'] === 'string' ? { audience: jwtRaw['audience'] } : {}),
      ...(typeof jwtRaw['subject_claim'] === 'string'
        ? { subjectClaim: jwtRaw['subject_claim'] }
        : {}),
      ...(typeof jwtRaw['scopes_claim'] === 'string'
        ? { scopesClaim: jwtRaw['scopes_claim'] }
        : {}),
      ...(requiredClaims !== undefined ? { requiredClaims } : {}),
    };
  }
  const sessionRaw = raw['session'];
  let session: SessionAuthConfig | undefined;
  if (sessionRaw !== undefined && sessionRaw !== null) {
    if (!isRecord(sessionRaw))
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'auth.session must be a mapping');
    session = {
      ...(typeof sessionRaw['cookie_name'] === 'string'
        ? { cookieName: sessionRaw['cookie_name'] }
        : {}),
      ...(typeof sessionRaw['ttl_seconds'] === 'number'
        ? { ttlSeconds: sessionRaw['ttl_seconds'] }
        : {}),
      ...(typeof sessionRaw['csrf'] === 'boolean' ? { csrf: sessionRaw['csrf'] } : {}),
      ...(typeof sessionRaw['csrf_header'] === 'string'
        ? { csrfHeader: sessionRaw['csrf_header'] }
        : {}),
      ...(typeof sessionRaw['login_path'] === 'string'
        ? { loginPath: sessionRaw['login_path'] }
        : {}),
      ...(typeof sessionRaw['logout_path'] === 'string'
        ? { logoutPath: sessionRaw['logout_path'] }
        : {}),
    };
  }
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(jwt !== undefined ? { jwt } : {}),
    ...(session !== undefined ? { session } : {}),
  };
}

/** Parse the global `hateoas:` block. */
function validateGlobalHateoas(raw: unknown): HateoasConfig {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "hateoas" must be a mapping', {
      received: typeof raw,
    });
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
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      'Global config: "security_headers" must be a mapping',
      { received: typeof raw },
    );
  }
  const customHeaders = requireStringStringMap(raw, 'custom_headers', 'security_headers');
  return {
    ...(typeof raw['enabled'] === 'boolean' ? { enabled: raw['enabled'] } : {}),
    ...(typeof raw['hsts'] === 'boolean' ? { hsts: raw['hsts'] } : {}),
    ...(typeof raw['nosniff'] === 'boolean' ? { nosniff: raw['nosniff'] } : {}),
    ...(typeof raw['frame_deny'] === 'boolean' ? { frame_deny: raw['frame_deny'] } : {}),
    ...(typeof raw['referrer_policy'] === 'string'
      ? { referrer_policy: raw['referrer_policy'] }
      : {}),
    ...(customHeaders !== undefined ? { custom_headers: customHeaders } : {}),
  };
}

/** Parse the global `versioning:` block. Exactly one version may be marked default. */
function validateGlobalVersioning(raw: unknown): VersioningConfig {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "versioning" must be a mapping', {
      received: typeof raw,
    });
  }
  let versions: VersionDecl[] | undefined;
  if (raw['versions'] !== undefined && raw['versions'] !== null) {
    if (!Array.isArray(raw['versions'])) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        'Global config: "versioning.versions" must be an array',
        { field: 'versioning.versions' },
      );
    }
    versions = raw['versions'].map((v, i) => {
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
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        'Global config: "versioning" declares more than one default version',
        {
          defaults: defaults.map((d) => d.version),
        },
      );
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
  const expandedHeaders: Record<string, string> = { ...headers };
  if (potemkin) {
    for (const [alias, value] of Object.entries(potemkin)) {
      const headerName = POTEMKIN_SIGNAL_ALIASES[alias];
      if (headerName === undefined) {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `${ctx}.match.potemkin: unknown alias "${alias}"`,
          { context: ctx, alias },
        );
      }
      expandedHeaders[headerName] = value;
    }
  }

  const responseRaw = raw['response'];
  if (!isRecord(responseRaw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.response must be a mapping`, {
      context: ctx,
    });
  }
  if (typeof responseRaw['status'] !== 'number') {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.response.status must be a number`, {
      context: ctx,
    });
  }
  const responseHeaders = requireStringStringMap(responseRaw, 'headers', `${ctx}.response`);
  const responseBody = optionalJsonValue(responseRaw, 'body', `${ctx}.response`);
  // delay_ms may sit under `response:` or at the top level.
  const delayMs =
    typeof responseRaw['delay_ms'] === 'number'
      ? responseRaw['delay_ms']
      : typeof raw['delay_ms'] === 'number'
        ? raw['delay_ms']
        : undefined;

  const intentRaw = matchRaw['intent'];
  const intent = parseIntent(intentRaw, `${ctx}.match.intent`);
  const operationId =
    matchRaw['operationId'] === undefined
      ? undefined
      : requireString(matchRaw, 'operationId', `${ctx}.match`);
  const method =
    matchRaw['method'] === undefined
      ? undefined
      : requireString(matchRaw, 'method', `${ctx}.match`).toUpperCase();
  const probabilityRaw = matchRaw['probability'];

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
    requiredScopes = requiredScopesRaw.map((item, index) => {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `${ctx}.match.required_scopes[${index}]: must be a non-empty string`,
          { context: ctx },
        );
      }
      return item;
    });
  }

  let requires: readonly RequiresGuard<never, 'fault'>[] | undefined;
  const requiresRaw = matchRaw['requires'];
  if (requiresRaw !== undefined && requiresRaw !== null) {
    if (!Array.isArray(requiresRaw)) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.match: "requires" must be an array`, {
        field: 'match.requires',
        context: ctx,
      });
    }
    requires = requiresRaw.map((item, index) =>
      validateRequiresGuard<'fault'>(item, `${ctx}.match.requires[${index}]`),
    );
  }

  return {
    name,
    match: {
      ...(typeof matchRaw['boundary'] === 'string' ? { boundary: matchRaw['boundary'] } : {}),
      ...(intent === undefined ? {} : { intent }),
      ...(operationId === undefined ? {} : { operationId }),
      ...(method === undefined ? {} : { method }),
      ...(Object.keys(expandedHeaders).length > 0 ? { headers: expandedHeaders } : {}),
      condition,
      ...(requiredScopes === undefined ? {} : { requiredScopes }),
      ...(requires === undefined ? {} : { requires }),
      ...(typeof probabilityRaw === 'number' ? { probability: probabilityRaw } : {}),
    },
    response: {
      status: responseRaw['status'],
      ...(responseBody === undefined ? {} : { body: responseBody }),
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
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.trigger must be a mapping`, {
      context: ctx,
    });
  }
  const condition = typeof triggerRaw['condition'] === 'string' ? triggerRaw['condition'] : 'true';
  const intent = parseIntent(triggerRaw['intent'], `${ctx}.trigger.intent`);

  const payload = requireStringStringMap(raw, 'payload', ctx);

  let retry: WebhookConfig['retry'];
  if (raw['retry'] !== undefined && raw['retry'] !== null) {
    if (!isRecord(raw['retry'])) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.retry must be a mapping`, {
        context: ctx,
      });
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
      ...(intent === undefined ? {} : { intent }),
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
 * in compileYaml. Unknown top-level keys are a BOOT_ERR.
 */
function validateFallbackResponse(raw: unknown, ctx: string): FallbackResponse {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be a mapping with a status`, {
      context: ctx,
    });
  }
  const status = raw['status'];
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `${ctx}.status: must be an HTTP status integer 100-599`,
      { context: ctx },
    );
  }
  const body = optionalJsonValue(raw, 'body', ctx);
  return {
    status,
    ...(body === undefined ? {} : { body }),
  };
}

function validateFallbackRule(raw: unknown, index: number): FallbackRule {
  const ctx = `fallback.rules[${index}]`;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}: must be a mapping`, { context: ctx });
  }
  const matchRaw = raw['match'];
  if (!isRecord(matchRaw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `${ctx}.match: must be a mapping`, { context: ctx });
  }
  for (const k of Object.keys(matchRaw)) {
    if (k !== 'path' && k !== 'method' && k !== 'in_contract') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `${ctx}.match: unknown key "${k}" — expected path, method, in_contract`,
        { context: ctx },
      );
    }
  }
  const match: FallbackRuleMatch = {
    ...(typeof matchRaw['path'] === 'string' ? { path: matchRaw['path'] } : {}),
    ...(typeof matchRaw['method'] === 'string' ? { method: matchRaw['method'] } : {}),
    ...(typeof matchRaw['in_contract'] === 'boolean'
      ? { inContract: matchRaw['in_contract'] }
      : {}),
  };
  const respond = validateFallbackResponse(raw['respond'], `${ctx}.respond`);
  return { match, respond };
}

function validateFallbackConfig(raw: unknown): FallbackConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', 'fallback: must be a mapping', {
      received: typeof raw,
    });
  }
  for (const k of Object.keys(raw)) {
    if (k !== 'rules' && k !== 'default') {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `fallback: unknown key "${k}" — expected rules, default`,
        { field: k },
      );
    }
  }
  let rules: readonly FallbackRule[] | undefined;
  if (raw['rules'] !== undefined && raw['rules'] !== null) {
    if (!Array.isArray(raw['rules'])) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'fallback.rules: must be an array', {
        field: 'rules',
      });
    }
    rules = raw['rules'].map((r, i) => validateFallbackRule(r, i));
  }
  const def =
    raw['default'] !== undefined && raw['default'] !== null
      ? validateFallbackResponse(raw['default'], 'fallback.default')
      : undefined;
  return {
    ...(rules !== undefined ? { rules } : {}),
    ...(def !== undefined ? { default: def } : {}),
  };
}

export function validateGlobalConfig(raw: unknown): GlobalConfig {
  if (!isRecord(raw)) {
    throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config must be a YAML mapping object', {
      received: typeof raw,
    });
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
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "sagas" must be an array', {
        field: 'sagas',
      });
    }
    sagas = raw['sagas'].map((s, i) => validateSagaConfig(s, i));
  }

  let idempotency: IdempotencyConfig | undefined;
  if (raw['idempotency'] !== undefined && raw['idempotency'] !== null) {
    idempotency = validateIdempotencyConfig(raw['idempotency']);
  }

  let derivedProjections: readonly DerivedProjectionConfig[] | undefined;
  if (raw['derived_projections'] !== undefined && raw['derived_projections'] !== null) {
    if (!Array.isArray(raw['derived_projections'])) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        'Global config: "derived_projections" must be an array',
        { field: 'derived_projections' },
      );
    }
    derivedProjections = raw['derived_projections'].map((p, i) =>
      validateDerivedProjectionConfig(p, i),
    );
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
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "fault_rules" must be an array', {
        field: 'fault_rules',
      });
    }
    faults = raw['fault_rules'].map((f, i) => validateFaultRule(f, i));
  }

  let webhooks: readonly WebhookConfig[] | undefined;
  if (raw['webhooks'] !== undefined && raw['webhooks'] !== null) {
    if (!Array.isArray(raw['webhooks'])) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "webhooks" must be an array', {
        field: 'webhooks',
      });
    }
    webhooks = raw['webhooks'].map((w, i) => validateWebhookConfig(w, i));
  }

  let reactions: readonly ReactionRule[] | undefined;
  if (raw['reactions'] !== undefined && raw['reactions'] !== null) {
    if (!Array.isArray(raw['reactions'])) {
      throw new BootError('BOOT_ERR_DSL_SYNTAX', 'Global config: "reactions" must be an array', {
        field: 'reactions',
      });
    }
    // fileBoundary is undefined — boundary field is required on each entry
    reactions = raw['reactions'].map((r, i) => validateReactionRule(r, i, undefined));
  }

  const fallback = validateFallbackConfig(raw['fallback']);
  const coverage =
    raw['coverage'] === undefined || raw['coverage'] === null
      ? undefined
      : validateCoverageConfig(raw['coverage']);

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
    ...(fallback !== undefined ? { fallback } : {}),
    ...(coverage !== undefined ? { coverage } : {}),
  };
}
