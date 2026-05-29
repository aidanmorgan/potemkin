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
  POTEMKIN_DRY_RUN, POTEMKIN_INCLUDE_EVENTS, POTEMKIN_ECHO,
  POTEMKIN_SEED, POTEMKIN_CLOCK_OFFSET,
  POTEMKIN_SKIP_SAGAS, POTEMKIN_SKIP_WEBHOOKS, POTEMKIN_SKIP_PROJECTIONS,
  POTEMKIN_SKIP_DISPATCH, POTEMKIN_MAX_CASCADE_DEPTH, POTEMKIN_BULK_TRANSACTIONAL,
  POTEMKIN_ACTOR_OVERRIDE, POTEMKIN_CAUSED_BY, POTEMKIN_IMPERSONATE,
  POTEMKIN_READ_AT_VERSION, POTEMKIN_REPLAY_EVENT, POTEMKIN_SNAPSHOT_MODE,
  POTEMKIN_RESPONSE_FORMAT, POTEMKIN_PAGINATION_STYLE, POTEMKIN_MASK, POTEMKIN_EXPAND_DEPTH,
  POTEMKIN_TRACE_ID, POTEMKIN_SPAN_NAME, POTEMKIN_LOG_LEVEL, POTEMKIN_METRIC_TAG,
  POTEMKIN_SKIP_REQUEST_VALIDATION, POTEMKIN_SKIP_RESPONSE_VALIDATION,
  POTEMKIN_ALLOW_ADDITIONAL_PROPERTIES,
} from './potemkinHeaders.js';

export interface TransparencyControls {
  readonly dryRun?: boolean;
  readonly includeEvents?: boolean;
  readonly echo?: boolean;
  readonly seed?: string;
  /** Signed integer milliseconds; positive moves clock forward. */
  readonly clockOffsetMs?: number;
}

export interface SideEffectControls {
  readonly skipSagas?: boolean;
  readonly skipWebhooks?: boolean;
  readonly skipProjections?: boolean;
  readonly skipDispatch?: boolean;
  readonly maxCascadeDepth?: number;
  readonly bulkTransactional?: boolean;
}

export interface IdentityControls {
  /** Override actor: format `<id>:<scope1>,<scope2>`. */
  readonly actorOverride?: string;
  /** Force causedBy on emitted events. */
  readonly causedBy?: string;
  /** Admin-gated impersonation target. */
  readonly impersonate?: string;
}

export interface TimeTravelControls {
  readonly readAtVersion?: number;
  readonly replayEvent?: string;
  readonly snapshotMode?: 'replay' | 'cached';
}

export type ResponseFormat = 'hal' | 'jsonapi' | 'plain';
export type PaginationStyle = 'envelope' | 'raw' | 'link-header';

export interface FormatControls {
  readonly responseFormat?: ResponseFormat;
  readonly paginationStyle?: PaginationStyle;
  readonly maskFields?: readonly string[];
  readonly expandDepth?: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ObservabilityControls {
  readonly traceId?: string;
  readonly spanName?: string;
  readonly logLevel?: LogLevel;
  /** Tag `{key, value}` parsed from `key=value`. */
  readonly metricTag?: { readonly key: string; readonly value: string };
}

export interface ValidationControls {
  readonly skipRequestValidation?: boolean;
  readonly skipResponseValidation?: boolean;
  readonly allowAdditionalProperties?: boolean;
}

export interface ControlHeaders {
  readonly transparency: TransparencyControls;
  readonly sideEffects: SideEffectControls;
  readonly identity: IdentityControls;
  readonly timeTravel: TimeTravelControls;
  readonly format: FormatControls;
  readonly observability: ObservabilityControls;
  readonly validation: ValidationControls;
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
  if (v === '' ) return undefined;
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

function parseSnapshotMode(raw: string | undefined): TimeTravelControls['snapshotMode'] {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'replay' || v === 'cached') return v;
  return undefined;
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
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
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
): ControlHeaders {
  return {
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
        ? { skipSagas: parseBool(readHeader(headers, POTEMKIN_SKIP_SAGAS)) } : {}),
      ...(parseBool(readHeader(headers, POTEMKIN_SKIP_WEBHOOKS)) !== undefined
        ? { skipWebhooks: parseBool(readHeader(headers, POTEMKIN_SKIP_WEBHOOKS)) } : {}),
      ...(parseBool(readHeader(headers, POTEMKIN_SKIP_PROJECTIONS)) !== undefined
        ? { skipProjections: parseBool(readHeader(headers, POTEMKIN_SKIP_PROJECTIONS)) } : {}),
      ...(parseBool(readHeader(headers, POTEMKIN_SKIP_DISPATCH)) !== undefined
        ? { skipDispatch: parseBool(readHeader(headers, POTEMKIN_SKIP_DISPATCH)) } : {}),
      ...(parseNonNegInt(readHeader(headers, POTEMKIN_MAX_CASCADE_DEPTH)) !== undefined
        ? { maxCascadeDepth: parseNonNegInt(readHeader(headers, POTEMKIN_MAX_CASCADE_DEPTH)) } : {}),
      ...(parseBool(readHeader(headers, POTEMKIN_BULK_TRANSACTIONAL)) !== undefined
        ? { bulkTransactional: parseBool(readHeader(headers, POTEMKIN_BULK_TRANSACTIONAL)) } : {}),
    },
    identity: {
      ...(readHeader(headers, POTEMKIN_ACTOR_OVERRIDE) !== undefined
        ? { actorOverride: readHeader(headers, POTEMKIN_ACTOR_OVERRIDE) } : {}),
      ...(readHeader(headers, POTEMKIN_CAUSED_BY) !== undefined
        ? { causedBy: readHeader(headers, POTEMKIN_CAUSED_BY) } : {}),
      ...(readHeader(headers, POTEMKIN_IMPERSONATE) !== undefined
        ? { impersonate: readHeader(headers, POTEMKIN_IMPERSONATE) } : {}),
    },
    timeTravel: {
      ...(parseNonNegInt(readHeader(headers, POTEMKIN_READ_AT_VERSION)) !== undefined
        ? { readAtVersion: parseNonNegInt(readHeader(headers, POTEMKIN_READ_AT_VERSION)) } : {}),
      ...(readHeader(headers, POTEMKIN_REPLAY_EVENT) !== undefined
        ? { replayEvent: readHeader(headers, POTEMKIN_REPLAY_EVENT) } : {}),
      ...(parseSnapshotMode(readHeader(headers, POTEMKIN_SNAPSHOT_MODE)) !== undefined
        ? { snapshotMode: parseSnapshotMode(readHeader(headers, POTEMKIN_SNAPSHOT_MODE)) } : {}),
    },
    format: {
      ...(parseResponseFormat(readHeader(headers, POTEMKIN_RESPONSE_FORMAT)) !== undefined
        ? { responseFormat: parseResponseFormat(readHeader(headers, POTEMKIN_RESPONSE_FORMAT)) } : {}),
      ...(parsePaginationStyle(readHeader(headers, POTEMKIN_PAGINATION_STYLE)) !== undefined
        ? { paginationStyle: parsePaginationStyle(readHeader(headers, POTEMKIN_PAGINATION_STYLE)) } : {}),
      ...(parseCsv(readHeader(headers, POTEMKIN_MASK)) !== undefined
        ? { maskFields: parseCsv(readHeader(headers, POTEMKIN_MASK)) } : {}),
      ...(parseNonNegInt(readHeader(headers, POTEMKIN_EXPAND_DEPTH)) !== undefined
        ? { expandDepth: parseNonNegInt(readHeader(headers, POTEMKIN_EXPAND_DEPTH)) } : {}),
    },
    observability: {
      ...(readHeader(headers, POTEMKIN_TRACE_ID) !== undefined
        ? { traceId: readHeader(headers, POTEMKIN_TRACE_ID) } : {}),
      ...(readHeader(headers, POTEMKIN_SPAN_NAME) !== undefined
        ? { spanName: readHeader(headers, POTEMKIN_SPAN_NAME) } : {}),
      ...(parseLogLevel(readHeader(headers, POTEMKIN_LOG_LEVEL)) !== undefined
        ? { logLevel: parseLogLevel(readHeader(headers, POTEMKIN_LOG_LEVEL)) } : {}),
      ...(parseMetricTag(readHeader(headers, POTEMKIN_METRIC_TAG)) !== undefined
        ? { metricTag: parseMetricTag(readHeader(headers, POTEMKIN_METRIC_TAG)) } : {}),
    },
    validation: {
      ...(parseBool(readHeader(headers, POTEMKIN_SKIP_REQUEST_VALIDATION)) !== undefined
        ? { skipRequestValidation: parseBool(readHeader(headers, POTEMKIN_SKIP_REQUEST_VALIDATION)) } : {}),
      ...(parseBool(readHeader(headers, POTEMKIN_SKIP_RESPONSE_VALIDATION)) !== undefined
        ? { skipResponseValidation: parseBool(readHeader(headers, POTEMKIN_SKIP_RESPONSE_VALIDATION)) } : {}),
      ...(parseBool(readHeader(headers, POTEMKIN_ALLOW_ADDITIONAL_PROPERTIES)) !== undefined
        ? { allowAdditionalProperties: parseBool(readHeader(headers, POTEMKIN_ALLOW_ADDITIONAL_PROPERTIES)) } : {}),
    },
  };
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
export function applyMask(
  body: unknown,
  fields: readonly string[],
): unknown {
  if (fields.length === 0) return body;
  if (Array.isArray(body)) return body.map(item => applyMask(item, fields));
  if (body !== null && typeof body === 'object') {
    const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
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
