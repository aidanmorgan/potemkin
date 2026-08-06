/**
 * Unified parser for all X-Potemkin-* control headers.
 *
 * Reads the raw request headers and returns a typed ControlHeaders object
 * covering Tiers 1-7. Each tier is namespaced for clarity; downstream code
 * reads only the slice it cares about.
 *
 * Tier 1 — Test transparency & determinism
 * Tier 2 — Side-effect control
 * Tier 3 — Identity & audit override
 * Tier 4 — Event sourcing time-travel
 * Tier 5 — Response format
 * Tier 6 — Observability injection
 * Tier 7 — Validation control (admin-gated by gateway)
 */

import {
  POTEMKIN_DRY_RUN,
  POTEMKIN_INCLUDE_EVENTS,
  POTEMKIN_ECHO,
  POTEMKIN_SEED,
  POTEMKIN_CLOCK_OFFSET,
  POTEMKIN_SKIP_SAGAS,
  POTEMKIN_SKIP_WEBHOOKS,
  POTEMKIN_SKIP_PROJECTIONS,
  POTEMKIN_SKIP_REACTIONS,
  POTEMKIN_SKIP_DISPATCH,
  POTEMKIN_MAX_CASCADE_DEPTH,
  POTEMKIN_BULK_TRANSACTIONAL,
  POTEMKIN_ACTOR_OVERRIDE,
  POTEMKIN_CAUSED_BY,
  POTEMKIN_IMPERSONATE,
  POTEMKIN_READ_AT_VERSION,
  POTEMKIN_REPLAY_EVENT,
  POTEMKIN_RESPONSE_FORMAT,
  POTEMKIN_PAGINATION_STYLE,
  POTEMKIN_MASK,
  POTEMKIN_TRACE_ID,
  POTEMKIN_SPAN_NAME,
  POTEMKIN_LOG_LEVEL,
  POTEMKIN_METRIC_TAG,
  POTEMKIN_SKIP_REQUEST_VALIDATION,
  POTEMKIN_SKIP_RESPONSE_VALIDATION,
  POTEMKIN_ALLOW_ADDITIONAL_PROPERTIES,
} from './potemkinHeaders.js';
import { ConfigurationError } from '../errors.js';
import type {
  ControlHeaders,
  FormatControls,
  IdentityControls,
  ObservabilityControls,
  PartialControlHeaders,
  SideEffectControls,
  TimeTravelControls,
  TransparencyControls,
  ValidationControls,
} from '../contracts/controlHeaders.js';
import { LogLevel, PaginationStyle, ResponseFormat } from '../contracts/controlHeaders.js';
import { isRecord } from '../contracts/value.js';

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function isResponseFormat(value: unknown): value is ResponseFormat {
  return (
    value === ResponseFormat.Hal ||
    value === ResponseFormat.JsonApi ||
    value === ResponseFormat.Plain
  );
}

function isPaginationStyle(value: unknown): value is PaginationStyle {
  return (
    value === PaginationStyle.Envelope ||
    value === PaginationStyle.Raw ||
    value === PaginationStyle.LinkHeader
  );
}

function isLogLevel(value: unknown): value is LogLevel {
  return (
    value === LogLevel.Debug ||
    value === LogLevel.Info ||
    value === LogLevel.Warn ||
    value === LogLevel.Error
  );
}

type FieldGuard = (value: unknown) => boolean;

function hasValidOptionalFields<T extends object>(
  value: unknown,
  fields: Readonly<Record<string, FieldGuard>>,
): value is T {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, fieldValue]) => {
    const guard = fields[key];
    return guard === undefined || fieldValue === undefined || guard(fieldValue);
  });
}

function isMetricTag(value: unknown): value is NonNullable<ObservabilityControls['metricTag']> {
  return isRecord(value) && typeof value.key === 'string' && typeof value.value === 'string';
}

function isTransparencyControls(value: unknown): value is TransparencyControls {
  return hasValidOptionalFields<TransparencyControls>(value, {
    dryRun: isBoolean,
    includeEvents: isBoolean,
    echo: isBoolean,
    seed: isString,
    clockOffsetMs: isInteger,
  });
}

function isSideEffectControls(value: unknown): value is SideEffectControls {
  return hasValidOptionalFields<SideEffectControls>(value, {
    skipSagas: isBoolean,
    skipWebhooks: isBoolean,
    skipProjections: isBoolean,
    skipReactions: isBoolean,
    skipDispatch: isBoolean,
    maxCascadeDepth: isNonNegativeInteger,
    bulkTransactional: isBoolean,
  });
}

function isIdentityControls(value: unknown): value is IdentityControls {
  return hasValidOptionalFields<IdentityControls>(value, {
    actorOverride: isString,
    causedBy: isString,
    impersonate: isString,
  });
}

function isTimeTravelControls(value: unknown): value is TimeTravelControls {
  return hasValidOptionalFields<TimeTravelControls>(value, {
    readAtVersion: isNonNegativeInteger,
    replayEvent: isString,
  });
}

function isFormatControls(value: unknown): value is FormatControls {
  return hasValidOptionalFields<FormatControls>(value, {
    responseFormat: isResponseFormat,
    paginationStyle: isPaginationStyle,
    maskFields: isStringArray,
  });
}

function isObservabilityControls(value: unknown): value is ObservabilityControls {
  return hasValidOptionalFields<ObservabilityControls>(value, {
    traceId: isString,
    spanName: isString,
    logLevel: isLogLevel,
    metricTag: isMetricTag,
  });
}

function isValidationControls(value: unknown): value is ValidationControls {
  return hasValidOptionalFields<ValidationControls>(value, {
    skipRequestValidation: isBoolean,
    skipResponseValidation: isBoolean,
    allowAdditionalProperties: isBoolean,
  });
}

function validateTier<T>(
  input: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is T,
): T | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!guard(value)) {
    throw new ConfigurationError(`controlHeaders.${key} has invalid values`, {
      field: `controlHeaders.${key}`,
    });
  }
  return value;
}

/** A complete, empty policy used when no authored defaults were supplied. */
export const EMPTY_CONTROL_HEADERS: ControlHeaders = Object.freeze({
  transparency: Object.freeze({}),
  sideEffects: Object.freeze({}),
  identity: Object.freeze({}),
  timeTravel: Object.freeze({}),
  format: Object.freeze({}),
  observability: Object.freeze({}),
  validation: Object.freeze({}),
});

/**
 * Merge request controls over an authored default policy.  Every nested tier
 * is copied, so request handling never mutates the TypeScript definition that
 * was installed at boot.
 */
export function mergeControlHeaders(
  defaults: PartialControlHeaders | undefined,
  request: ControlHeaders,
): ControlHeaders {
  const base = defaults ?? EMPTY_CONTROL_HEADERS;
  return {
    transparency: { ...base.transparency, ...request.transparency },
    sideEffects: { ...base.sideEffects, ...request.sideEffects },
    identity: { ...base.identity, ...request.identity },
    timeTravel: { ...base.timeTravel, ...request.timeTravel },
    format: { ...base.format, ...request.format },
    observability: { ...base.observability, ...request.observability },
    validation: { ...base.validation, ...request.validation },
  };
}

/** TypeScript authoring may omit tiers and individual controls. */
/**
 * Validate a control policy supplied by JavaScript or generated code.  Header
 * values are deliberately checked here rather than silently ignored: a bad
 * authored default would otherwise affect every request in the process.
 */
export function validateControlHeaders(raw: unknown): PartialControlHeaders {
  if (!isRecord(raw)) {
    throw new ConfigurationError('controlHeaders must be an object', { field: 'controlHeaders' });
  }
  const input = raw;
  const allowed = new Set([
    'transparency',
    'sideEffects',
    'identity',
    'timeTravel',
    'format',
    'observability',
    'validation',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key))
      throw new ConfigurationError(`controlHeaders: unknown tier "${key}"`, {
        field: `controlHeaders.${key}`,
      });
  }
  const transparency = validateTier(input, 'transparency', isTransparencyControls);
  const sideEffects = validateTier(input, 'sideEffects', isSideEffectControls);
  const identity = validateTier(input, 'identity', isIdentityControls);
  const timeTravel = validateTier(input, 'timeTravel', isTimeTravelControls);
  const format = validateTier(input, 'format', isFormatControls);
  const observability = validateTier(input, 'observability', isObservabilityControls);
  const validation = validateTier(input, 'validation', isValidationControls);
  return {
    ...(transparency === undefined ? {} : { transparency }),
    ...(sideEffects === undefined ? {} : { sideEffects }),
    ...(identity === undefined ? {} : { identity }),
    ...(timeTravel === undefined ? {} : { timeTravel }),
    ...(format === undefined ? {} : { format }),
    ...(observability === undefined ? {} : { observability }),
    ...(validation === undefined ? {} : { validation }),
  };
}

function readHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const raw = headers[name];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return undefined;
}

function parseSignedInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) return undefined;
  return n;
}

function parseNonNegInt(raw: string | undefined): number | undefined {
  const n = parseSignedInt(raw);
  if (n === undefined || n < 0) return undefined;
  return n;
}

function parseResponseFormat(raw: string | undefined): ResponseFormat | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'hal' || v === 'jsonapi' || v === 'plain') return v;
  return undefined;
}

function parsePaginationStyle(raw: string | undefined): PaginationStyle | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'envelope' || v === 'raw' || v === 'link-header') return v;
  return undefined;
}

function parseLogLevel(raw: string | undefined): LogLevel | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  return undefined;
}

function parseCsv(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseMetricTag(raw: string | undefined): ObservabilityControls['metricTag'] {
  if (raw === undefined || raw.trim() === '') return undefined;
  const eq = raw.indexOf('=');
  if (eq <= 0 || eq === raw.length - 1) return undefined;
  return { key: raw.slice(0, eq).trim(), value: raw.slice(eq + 1).trim() };
}

/**
 * Parse all X-Potemkin-* control headers from a request.
 * Returns a fully-typed ControlHeaders object; missing/malformed fields are undefined.
 */
export function parseControlHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
  defaults?: PartialControlHeaders,
): ControlHeaders {
  const request: ControlHeaders = {
    transparency: {
      ...(parseBool(readHeader(headers, POTEMKIN_DRY_RUN)) !== undefined
        ? { dryRun: parseBool(readHeader(headers, POTEMKIN_DRY_RUN)) }
        : {}),
      ...(parseBool(readHeader(headers, POTEMKIN_INCLUDE_EVENTS)) !== undefined
        ? { includeEvents: parseBool(readHeader(headers, POTEMKIN_INCLUDE_EVENTS)) }
        : {}),
      ...(parseBool(readHeader(headers, POTEMKIN_ECHO)) !== undefined
        ? { echo: parseBool(readHeader(headers, POTEMKIN_ECHO)) }
        : {}),
      ...(readHeader(headers, POTEMKIN_SEED) !== undefined
        ? { seed: readHeader(headers, POTEMKIN_SEED) }
        : {}),
      ...(parseSignedInt(readHeader(headers, POTEMKIN_CLOCK_OFFSET)) !== undefined
        ? { clockOffsetMs: parseSignedInt(readHeader(headers, POTEMKIN_CLOCK_OFFSET)) }
        : {}),
    },
    sideEffects: {
      ...(parseBool(readHeader(headers, POTEMKIN_SKIP_SAGAS)) !== undefined
        ? { skipSagas: parseBool(readHeader(headers, POTEMKIN_SKIP_SAGAS)) }
        : {}),
      ...(parseBool(readHeader(headers, POTEMKIN_SKIP_WEBHOOKS)) !== undefined
        ? { skipWebhooks: parseBool(readHeader(headers, POTEMKIN_SKIP_WEBHOOKS)) }
        : {}),
      ...(parseBool(readHeader(headers, POTEMKIN_SKIP_PROJECTIONS)) !== undefined
        ? { skipProjections: parseBool(readHeader(headers, POTEMKIN_SKIP_PROJECTIONS)) }
        : {}),
      ...(parseBool(readHeader(headers, POTEMKIN_SKIP_REACTIONS)) !== undefined
        ? { skipReactions: parseBool(readHeader(headers, POTEMKIN_SKIP_REACTIONS)) }
        : {}),
      ...(parseBool(readHeader(headers, POTEMKIN_SKIP_DISPATCH)) !== undefined
        ? { skipDispatch: parseBool(readHeader(headers, POTEMKIN_SKIP_DISPATCH)) }
        : {}),
      ...(parseNonNegInt(readHeader(headers, POTEMKIN_MAX_CASCADE_DEPTH)) !== undefined
        ? { maxCascadeDepth: parseNonNegInt(readHeader(headers, POTEMKIN_MAX_CASCADE_DEPTH)) }
        : {}),
      ...(parseBool(readHeader(headers, POTEMKIN_BULK_TRANSACTIONAL)) !== undefined
        ? { bulkTransactional: parseBool(readHeader(headers, POTEMKIN_BULK_TRANSACTIONAL)) }
        : {}),
    },
    identity: {
      ...(readHeader(headers, POTEMKIN_ACTOR_OVERRIDE) !== undefined
        ? { actorOverride: readHeader(headers, POTEMKIN_ACTOR_OVERRIDE) }
        : {}),
      ...(readHeader(headers, POTEMKIN_CAUSED_BY) !== undefined
        ? { causedBy: readHeader(headers, POTEMKIN_CAUSED_BY) }
        : {}),
      ...(readHeader(headers, POTEMKIN_IMPERSONATE) !== undefined
        ? { impersonate: readHeader(headers, POTEMKIN_IMPERSONATE) }
        : {}),
    },
    timeTravel: {
      ...(parseNonNegInt(readHeader(headers, POTEMKIN_READ_AT_VERSION)) !== undefined
        ? { readAtVersion: parseNonNegInt(readHeader(headers, POTEMKIN_READ_AT_VERSION)) }
        : {}),
      ...(readHeader(headers, POTEMKIN_REPLAY_EVENT) !== undefined
        ? { replayEvent: readHeader(headers, POTEMKIN_REPLAY_EVENT) }
        : {}),
    },
    format: {
      ...(parseResponseFormat(readHeader(headers, POTEMKIN_RESPONSE_FORMAT)) !== undefined
        ? { responseFormat: parseResponseFormat(readHeader(headers, POTEMKIN_RESPONSE_FORMAT)) }
        : {}),
      ...(parsePaginationStyle(readHeader(headers, POTEMKIN_PAGINATION_STYLE)) !== undefined
        ? { paginationStyle: parsePaginationStyle(readHeader(headers, POTEMKIN_PAGINATION_STYLE)) }
        : {}),
      ...(parseCsv(readHeader(headers, POTEMKIN_MASK)) !== undefined
        ? { maskFields: parseCsv(readHeader(headers, POTEMKIN_MASK)) }
        : {}),
    },
    observability: {
      ...(readHeader(headers, POTEMKIN_TRACE_ID) !== undefined
        ? { traceId: readHeader(headers, POTEMKIN_TRACE_ID) }
        : {}),
      ...(readHeader(headers, POTEMKIN_SPAN_NAME) !== undefined
        ? { spanName: readHeader(headers, POTEMKIN_SPAN_NAME) }
        : {}),
      ...(parseLogLevel(readHeader(headers, POTEMKIN_LOG_LEVEL)) !== undefined
        ? { logLevel: parseLogLevel(readHeader(headers, POTEMKIN_LOG_LEVEL)) }
        : {}),
      ...(parseMetricTag(readHeader(headers, POTEMKIN_METRIC_TAG)) !== undefined
        ? { metricTag: parseMetricTag(readHeader(headers, POTEMKIN_METRIC_TAG)) }
        : {}),
    },
    validation: {
      ...(parseBool(readHeader(headers, POTEMKIN_SKIP_REQUEST_VALIDATION)) !== undefined
        ? {
            skipRequestValidation: parseBool(readHeader(headers, POTEMKIN_SKIP_REQUEST_VALIDATION)),
          }
        : {}),
      ...(parseBool(readHeader(headers, POTEMKIN_SKIP_RESPONSE_VALIDATION)) !== undefined
        ? {
            skipResponseValidation: parseBool(
              readHeader(headers, POTEMKIN_SKIP_RESPONSE_VALIDATION),
            ),
          }
        : {}),
      ...(parseBool(readHeader(headers, POTEMKIN_ALLOW_ADDITIONAL_PROPERTIES)) !== undefined
        ? {
            allowAdditionalProperties: parseBool(
              readHeader(headers, POTEMKIN_ALLOW_ADDITIONAL_PROPERTIES),
            ),
          }
        : {}),
    },
  };
  return mergeControlHeaders(defaults, request);
}

/** Return true if any admin-gated header was present (validation, impersonation, actor-override). */
export function requiresAdminAuth(c: ControlHeaders): boolean {
  return Boolean(
    c.validation.skipRequestValidation ||
    c.validation.skipResponseValidation ||
    c.validation.allowAdditionalProperties ||
    c.identity.actorOverride ||
    c.identity.impersonate,
  );
}

/**
 * Mask named fields in an entity (recursively walks objects and arrays).
 * Returns a new copy with the listed top-level keys replaced by `"[MASKED]"`.
 */
export function applyMask(body: unknown, fields: readonly string[]): unknown {
  if (fields.length === 0) return body;
  if (Array.isArray(body)) return body.map((item) => applyMask(item, fields));
  if (isRecord(body)) {
    const out: Record<string, unknown> = { ...body };
    for (const field of fields) {
      if (field in out) out[field] = '[MASKED]';
    }
    // Recurse into nested values (e.g. envelope.items[]).
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (Array.isArray(v) || (v !== null && typeof v === 'object')) {
        out[k] = applyMask(v, fields);
      }
    }
    return out;
  }
  return body;
}
