/**
 * Response-pipeline helpers for the /_engine/forward handler.
 *
 * Each concern the forwarding path shares with the HTTP gateway is expressed as
 * a small, independently-testable function here so the handler reads as a linear
 * sequence of steps. Header keys produced by these helpers are lowercased,
 * matching the ForwardedResponse convention used throughout the forwarding
 * surface (the plugin lowercases all header keys on the wire).
 */

import type { BoundaryConfig, CompiledDsl, FaultRule, LatencyConfig } from '../dsl/types.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { Intent, JsonObject, JsonValue } from '../types.js';
import { applyHateoasLinks } from '../engine/hateoas.js';

// ---------------------------------------------------------------------------
// CORS (OPTIONS preflight) — mirrors gateway.ts constants.
// ---------------------------------------------------------------------------

const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS';
const CORS_ALLOW_HEADERS = 'Content-Type, If-Match, x-specmatic-fault';

/** CORS response headers (lowercased keys) for a forwarded OPTIONS preflight. */
export function corsPreflightHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': process.env['ALLOWED_ORIGINS']
      ? (process.env['ALLOWED_ORIGINS'].split(',')[0]?.trim() ?? '*')
      : '*',
    'access-control-allow-methods': CORS_ALLOW_METHODS,
    'access-control-allow-headers': CORS_ALLOW_HEADERS,
  };
}

// ---------------------------------------------------------------------------
// Boundary latency
// ---------------------------------------------------------------------------

/**
 * Resolve the pre-response delay (ms) implied by a boundary's `latency:` block.
 * fixed_ms is additive; a [min_ms, max_ms] range contributes a uniform-random
 * sample. Returns 0 when no latency is configured.
 */
export function resolveBoundaryLatencyMs(latency: LatencyConfig | undefined): number {
  if (latency === undefined) return 0;
  let ms = 0;
  if (typeof latency.fixed_ms === 'number' && latency.fixed_ms > 0) ms += latency.fixed_ms;
  const lo = typeof latency.min_ms === 'number' ? latency.min_ms : undefined;
  const hi = typeof latency.max_ms === 'number' ? latency.max_ms : undefined;
  if (lo !== undefined && hi !== undefined && hi >= lo) {
    ms += lo + Math.random() * (hi - lo);
  } else if (hi !== undefined) {
    ms += Math.random() * hi;
  } else if (lo !== undefined) {
    ms += lo;
  }
  return Math.min(ms, 30_000);
}

/** Sleep for `ms` milliseconds (no-op when ms <= 0). */
export function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Conditional requests (RFC 7232) for single-entity GETs
// ---------------------------------------------------------------------------

export interface ConditionalInput {
  /** The current quoted ETag (e.g. `"5"`), if any. */
  readonly etag?: string;
  /** The entity's Last-Modified value (HTTP-date), if any. */
  readonly lastModified?: string;
  /** Raw If-None-Match request header (any casing already resolved). */
  readonly ifNoneMatch?: string;
  /** Raw If-Modified-Since request header. */
  readonly ifModifiedSince?: string;
}

/**
 * Decide whether a single-entity GET should short-circuit to 304 Not Modified.
 *
 *  - If-None-Match: compares ignoring surrounding quotes; a match → 304.
 *  - If-Modified-Since: a valid HTTP-date at/after the entity's Last-Modified
 *    → 304. A malformed date is ignored (no 304).
 *
 * Returns true only when the response should be 304. Collections and non-GET
 * verbs must not call this; 404s are handled before this runs.
 */
export function shouldReturnNotModified(input: ConditionalInput): boolean {
  const { etag, lastModified, ifNoneMatch, ifModifiedSince } = input;

  if (ifNoneMatch !== undefined && etag !== undefined) {
    const strip = (s: string): string => s.trim().replace(/^"|"$/g, '');
    if (strip(ifNoneMatch) === strip(etag)) return true;
  }

  if (ifModifiedSince !== undefined && lastModified !== undefined) {
    const since = Date.parse(ifModifiedSince);
    const modified = Date.parse(lastModified);
    if (Number.isFinite(since) && Number.isFinite(modified) && modified <= since) {
      return true;
    }
  }

  return false;
}

/**
 * Derive the Last-Modified HTTP-date from an entity body's `updatedAt` field.
 * Returns undefined when absent or unparseable.
 */
export function lastModifiedFromBody(body: JsonValue | null | undefined): string | undefined {
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }
  const updatedAt = (body as JsonObject)['updatedAt'];
  if (typeof updatedAt !== 'string') return undefined;
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return undefined;
  return new Date(ts).toUTCString();
}

/** True when the response body is a single entity object (not a collection/envelope). */
export function isSingleEntityBody(body: JsonValue | null | undefined): boolean {
  return body !== null && body !== undefined && typeof body === 'object' && !Array.isArray(body);
}

// ---------------------------------------------------------------------------
// HATEOAS
// ---------------------------------------------------------------------------

/**
 * Apply HATEOAS `_links` to a query response body (global `hateoas:` block).
 * No-op when HATEOAS is disabled or the body is not entity-shaped.
 */
export function applyHateoasToQueryBody(
  body: JsonValue | null | undefined,
  boundary: BoundaryConfig,
  dsl: CompiledDsl,
  cel: CelEvaluator,
  queryParams: Record<string, string | string[]>,
): JsonValue | null | undefined {
  if (body === null || body === undefined) return body;
  if (!dsl.hateoas?.enabled) return body;
  return applyHateoasLinks({ body, boundary, dsl, cel, queryParams });
}

// ---------------------------------------------------------------------------
// Debug envelope (include-events / echo) — mirrors gateway.ts
// ---------------------------------------------------------------------------

export interface DebugEnvelopeInput {
  readonly body: JsonValue | null | undefined;
  readonly includeEvents: boolean;
  readonly echo: boolean;
  readonly events: readonly {
    eventId: string;
    type: string;
    aggregateId: string;
    sequenceVersion: number;
    timestamp: string;
    payload: JsonValue;
    causedBy: string | null;
  }[];
  readonly boundary: string;
  readonly intent: Intent;
  readonly targetId: string | null;
  readonly dryRun: boolean;
  readonly method: string;
  readonly path: string;
}

/**
 * Build the include-events / echo debug envelope around a response body. When
 * neither flag is set, returns the body unchanged.
 */
export function applyDebugEnvelope(input: DebugEnvelopeInput): JsonValue | null | undefined {
  const { body, includeEvents, echo } = input;
  if (!includeEvents && !echo) return body;

  const base: Record<string, unknown> =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>) }
      : { value: body ?? null };

  if (includeEvents) {
    base['_events'] = input.events.map((e) => ({
      eventId: e.eventId,
      type: e.type,
      aggregateId: e.aggregateId,
      sequenceVersion: e.sequenceVersion,
      timestamp: e.timestamp,
      payload: e.payload,
      causedBy: e.causedBy,
    }));
  }
  if (echo) {
    base['_debug'] = {
      boundary: input.boundary,
      intent: input.intent,
      targetId: input.targetId,
      dryRun: input.dryRun,
      method: input.method,
      path: input.path,
    };
  }
  return base as JsonValue;
}

// ---------------------------------------------------------------------------
// Command headers
// ---------------------------------------------------------------------------

/** Lowercase every key in a forwarded-headers map (values preserved as strings). */
export function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Fault-rule evaluation inputs
// ---------------------------------------------------------------------------

/**
 * Collect the boundary-scoped fault rules from the global rule set. A global
 * rule whose `match.boundary` names this boundary is treated as boundary-scoped;
 * everything else stays global. This mirrors the gateway's split so dynamic >
 * boundary > global precedence is preserved by evaluateFaultRules.
 */
export function splitBoundaryFaults(
  faults: readonly FaultRule[] | undefined,
  boundaryName: string,
): { boundary: FaultRule[]; global: FaultRule[] } {
  const boundary: FaultRule[] = [];
  const global: FaultRule[] = [];
  for (const rule of faults ?? []) {
    if (rule.match.boundary !== undefined && rule.match.boundary === boundaryName) {
      boundary.push(rule);
    } else {
      global.push(rule);
    }
  }
  return { boundary, global };
}
