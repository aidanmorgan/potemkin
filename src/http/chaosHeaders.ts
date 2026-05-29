/**
 * Header-triggered chaos behaviors.
 *
 * Every chaos-engineering primitive supported by the simulator can be
 * triggered two ways:
 *
 *   1. YAML rule (no client header required): an `if` block in a fault rule
 *      matches normally on intent/condition/probability/etc.
 *
 *   2. Client-supplied X-Potemkin-* header on the request. Each header has
 *      a sensible DEFAULT BEHAVIOUR (built into the engine). YAML rules
 *      can OVERRIDE the default response shape by including the same header
 *      in their `match.headers:` (or `match.potemkin:`) block. When a rule
 *      matches the client's actual header value, its response is used
 *      instead of the generic default.
 *
 * Recognised direct-chaos headers (all values are strings — parse as needed):
 *
 *   X-Potemkin-Use-Fault: <rule-name>
 *     Highest precedence. Invoke the named YAML fault rule's response verbatim.
 *
 *   X-Potemkin-Force-Status: <100..599>
 *     Short-circuit with the given HTTP status (generic body unless a YAML
 *     rule matches the same header at that value).
 *
 *   X-Potemkin-Error-Class: timeout|throttle|outage|bad_gateway|conflict|auth|forbidden
 *     Map a chaos vocabulary to a real HTTP status (504/429/503/502/409/401/403).
 *
 *   X-Potemkin-Force-Latency: <int ms>
 *     Add fixed latency (stacks with boundary `latency:` config).
 *
 *   X-Potemkin-Slow-Response: <int ms>
 *     Synonym for X-Potemkin-Force-Latency, named for chaos vocabulary.
 *
 *   X-Potemkin-Jitter: <max-ms> | <min>:<max>
 *     Add uniform-random jitter to the response time.
 *
 *   X-Potemkin-Drop-Connection: <int ms>
 *     Sleep then close the socket with no body. The client times out.
 *
 *   X-Potemkin-Success-Rate: <0..1> | <0..100>
 *     Probabilistic gate. Below the threshold → success; above → 503.
 *
 *   X-Potemkin-Retry-After: <int seconds>
 *     Attach Retry-After to a chaos response (Force-Status / Error-Class).
 *
 *   X-Potemkin-Body-Truncate: <int bytes>
 *     Serialise the normal body, then slice to N bytes.
 *
 * Precedence (highest first):
 *   Use-Fault > Force-Status > Error-Class > Drop-Connection > Success-Rate
 *   Latency/Slow-Response/Jitter stack additively with each other AND with
 *   boundary-level `latency:` config.
 *   Body-Truncate and Retry-After are applied to whatever response wins.
 */

import type { FaultResponse, FaultRule } from '../dsl/types.js';
import type { JsonValue } from '../types.js';
import {
  POTEMKIN_FORCE_LATENCY,
  POTEMKIN_FORCE_STATUS_CHAOS,
  POTEMKIN_USE_FAULT,
  POTEMKIN_JITTER,
  POTEMKIN_SLOW_RESPONSE,
  POTEMKIN_DROP_CONNECTION,
  POTEMKIN_SUCCESS_RATE,
  POTEMKIN_ERROR_CLASS,
  POTEMKIN_RETRY_AFTER,
  POTEMKIN_BODY_TRUNCATE,
} from './potemkinHeaders.js';

export interface ChaosHeaderOutcome {
  /** Optional override response — when set, gateway should short-circuit. */
  readonly response?: FaultResponse;
  /** Additional sleep (ms) to apply before sending the response. */
  readonly extraLatencyMs: number;
  /** Name of the YAML rule that resolved the response, when applicable. */
  readonly matchedRuleName?: string;
  /** When true, the connection should be closed without writing a body. */
  readonly dropConnection?: boolean;
  /** Maximum body byte length for truncation, when set. */
  readonly bodyTruncateBytes?: number;
}

const ERROR_CLASS_DEFAULTS: Record<string, { status: number; error: string; message: string }> = {
  timeout:      { status: 504, error: 'GATEWAY_TIMEOUT',     message: 'Upstream timed out (chaos)' },
  throttle:     { status: 429, error: 'TOO_MANY_REQUESTS',   message: 'Throttled (chaos)' },
  outage:      { status: 503, error: 'SERVICE_UNAVAILABLE', message: 'Service outage (chaos)' },
  bad_gateway:  { status: 502, error: 'BAD_GATEWAY',         message: 'Upstream bad gateway (chaos)' },
  conflict:    { status: 409, error: 'CONFLICT',            message: 'Conflict (chaos)' },
  auth:        { status: 401, error: 'UNAUTHENTICATED',     message: 'Authentication required (chaos)' },
  forbidden:   { status: 403, error: 'FORBIDDEN',           message: 'Forbidden (chaos)' },
};

function readHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const raw = headers[name];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Find the first YAML fault rule whose `match.headers` includes `headerName`
 * with value `"*"` or exactly `value`. Other match constraints (boundary,
 * intent, condition) are not enforced here — the client opted in by sending
 * the chaos header.
 */
function findRuleByHeader(
  faultRules: readonly FaultRule[],
  headerName: string,
  value: string,
): FaultRule | undefined {
  for (const rule of faultRules) {
    const matchHeaders = rule.match.headers;
    if (!matchHeaders) continue;
    const expected = matchHeaders[headerName];
    if (expected === undefined) continue;
    if (expected === '*' || expected === value) return rule;
  }
  return undefined;
}

/** Parse jitter spec: `"500"` → [0, 500], `"100:500"` → [100, 500]. */
function parseJitter(raw: string): [number, number] | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.includes(':')) {
    const [lo, hi] = trimmed.split(':', 2).map(Number);
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && hi >= lo) return [lo, hi];
    return null;
  }
  const n = Number(trimmed);
  if (Number.isFinite(n) && n >= 0) return [0, n];
  return null;
}

/** Parse success-rate: `"0.7"` → 0.7, `"70"` → 0.7. */
function parseSuccessRate(raw: string): number | null {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return null;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return null;
}

/** Merge `Retry-After: N` into a chaos response when present on the request. */
function attachRetryAfter(
  base: FaultResponse,
  retryAfterRaw: string | undefined,
): FaultResponse {
  if (retryAfterRaw === undefined || retryAfterRaw.trim() === '') return base;
  const seconds = Number(retryAfterRaw);
  if (!Number.isFinite(seconds) || seconds < 0) return base;
  const merged: Record<string, string> = { ...(base.headers ?? {}) };
  merged['Retry-After'] = String(Math.floor(seconds));
  return { ...base, headers: merged };
}

export function resolveChaosHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
  faultRules: readonly FaultRule[],
): ChaosHeaderOutcome {
  let extraLatencyMs = 0;
  let response: FaultResponse | undefined;
  let matchedRuleName: string | undefined;
  let dropConnection = false;
  let bodyTruncateBytes: number | undefined;

  const retryAfter = readHeader(headers, POTEMKIN_RETRY_AFTER);

  // 1. X-Potemkin-Use-Fault — explicit named rule lookup wins outright.
  const useFault = readHeader(headers, POTEMKIN_USE_FAULT);
  if (useFault !== undefined && useFault.trim() !== '') {
    const rule = faultRules.find(r => r.name === useFault);
    if (rule) {
      response = rule.response;
      matchedRuleName = rule.name;
    }
  }

  // 2. X-Potemkin-Force-Status — YAML matcher first; generic fallback otherwise.
  if (response === undefined) {
    const forceStatus = readHeader(headers, POTEMKIN_FORCE_STATUS_CHAOS);
    if (forceStatus !== undefined && forceStatus.trim() !== '') {
      const matched = findRuleByHeader(faultRules, POTEMKIN_FORCE_STATUS_CHAOS, forceStatus);
      if (matched) {
        response = matched.response;
        matchedRuleName = matched.name;
      } else {
        const status = Number(forceStatus);
        if (Number.isInteger(status) && status >= 100 && status <= 599) {
          response = {
            status,
            body: {
              error: 'FORCED_STATUS',
              message: `Status ${status} forced via ${POTEMKIN_FORCE_STATUS_CHAOS} header`,
              status,
            },
          };
        }
      }
    }
  }

  // 3. X-Potemkin-Error-Class — YAML matcher first; otherwise canonical mapping.
  if (response === undefined) {
    const errorClass = readHeader(headers, POTEMKIN_ERROR_CLASS);
    if (errorClass !== undefined && errorClass.trim() !== '') {
      const matched = findRuleByHeader(faultRules, POTEMKIN_ERROR_CLASS, errorClass);
      if (matched) {
        response = matched.response;
        matchedRuleName = matched.name;
      } else {
        const defaults = ERROR_CLASS_DEFAULTS[errorClass.toLowerCase()];
        if (defaults) {
          response = {
            status: defaults.status,
            body: {
              error: defaults.error,
              message: defaults.message,
              errorClass: errorClass.toLowerCase(),
            },
          };
        }
      }
    }
  }

  // 4. X-Potemkin-Drop-Connection — close the socket after the requested delay.
  if (response === undefined) {
    const dropRaw = readHeader(headers, POTEMKIN_DROP_CONNECTION);
    if (dropRaw !== undefined && dropRaw.trim() !== '') {
      const ms = Number(dropRaw);
      if (Number.isFinite(ms) && ms >= 0) {
        dropConnection = true;
        extraLatencyMs += Math.min(ms, 30_000);
      }
    }
  }

  // 5. X-Potemkin-Success-Rate — probabilistic gate, no YAML matcher.
  if (response === undefined && !dropConnection) {
    const rateRaw = readHeader(headers, POTEMKIN_SUCCESS_RATE);
    if (rateRaw !== undefined && rateRaw.trim() !== '') {
      const rate = parseSuccessRate(rateRaw);
      if (rate !== null && Math.random() >= rate) {
        const matched = findRuleByHeader(faultRules, POTEMKIN_SUCCESS_RATE, rateRaw);
        if (matched) {
          response = matched.response;
          matchedRuleName = matched.name;
        } else {
          response = {
            status: 503,
            body: {
              error: 'SUCCESS_RATE_GATE',
              message: `Probabilistic chaos gate failed (configured success-rate ${rate})`,
            },
          };
        }
      }
    }
  }

  // 6. Latency primitives — Force-Latency + Slow-Response + Jitter all stack.
  //    Each independently consults YAML for response-shape overrides.
  for (const headerName of [POTEMKIN_FORCE_LATENCY, POTEMKIN_SLOW_RESPONSE] as const) {
    const raw = readHeader(headers, headerName);
    if (raw !== undefined && raw.trim() !== '') {
      const ms = Number(raw);
      if (Number.isFinite(ms) && ms >= 0) {
        extraLatencyMs += Math.min(ms, 30_000);
      }
      if (response === undefined) {
        const matched = findRuleByHeader(faultRules, headerName, raw);
        if (matched) {
          response = matched.response;
          matchedRuleName = matched.name;
        }
      }
    }
  }
  const jitterRaw = readHeader(headers, POTEMKIN_JITTER);
  if (jitterRaw !== undefined && jitterRaw.trim() !== '') {
    const range = parseJitter(jitterRaw);
    if (range) {
      const [lo, hi] = range;
      extraLatencyMs += Math.min(lo + Math.random() * (hi - lo), 30_000);
    }
    if (response === undefined) {
      const matched = findRuleByHeader(faultRules, POTEMKIN_JITTER, jitterRaw);
      if (matched) {
        response = matched.response;
        matchedRuleName = matched.name;
      }
    }
  }

  // 7. X-Potemkin-Body-Truncate — applied after the response is chosen.
  const truncRaw = readHeader(headers, POTEMKIN_BODY_TRUNCATE);
  if (truncRaw !== undefined && truncRaw.trim() !== '') {
    const n = Number(truncRaw);
    if (Number.isInteger(n) && n >= 0) bodyTruncateBytes = n;
  }

  // 8. Retry-After merging — apply to any chaos response.
  if (response !== undefined) {
    response = attachRetryAfter(response, retryAfter);
  }

  if (response !== undefined && matchedRuleName !== undefined) {
    return {
      response,
      extraLatencyMs,
      matchedRuleName,
      ...(dropConnection ? { dropConnection } : {}),
      ...(bodyTruncateBytes !== undefined ? { bodyTruncateBytes } : {}),
    };
  }
  if (response !== undefined) {
    return {
      response,
      extraLatencyMs,
      ...(dropConnection ? { dropConnection } : {}),
      ...(bodyTruncateBytes !== undefined ? { bodyTruncateBytes } : {}),
    };
  }
  return {
    extraLatencyMs,
    ...(dropConnection ? { dropConnection } : {}),
    ...(bodyTruncateBytes !== undefined ? { bodyTruncateBytes } : {}),
  };
}

/** Truncate a JSON-serialised body to at most `maxBytes`. */
export function truncateBody(body: JsonValue, maxBytes: number): JsonValue {
  if (maxBytes <= 0) return '';
  const serialised = JSON.stringify(body);
  if (serialised.length <= maxBytes) return body;
  return serialised.slice(0, maxBytes);
}
