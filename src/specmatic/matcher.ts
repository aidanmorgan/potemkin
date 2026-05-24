/**
 * Specmatic request matcher — pure functions for matching incoming requests
 * against stored expectation criteria.
 *
 * Match semantics per Specmatic service virtualisation spec:
 *  - method:          exact, case-insensitive
 *  - path:            exact (literal string equality; no template expansion in T1)
 *  - headers:         subset — matcher's headers must all be present in the request
 *                     with equal values (case-insensitive header name lookup);
 *                     extra request headers are ignored
 *  - queryParameters: per-key exact equality; arrays must match element-by-element
 *                     in order; extra request query params are ignored IF the matcher
 *                     supplies only a subset. If matcher supplies a key, request MUST
 *                     match it exactly.
 *  - body:            deep structural equality when matcher.body is present;
 *                     absent matcher.body matches any request body.
 *                     Body leaves may use type-pattern strings like "(number)" to
 *                     match by type rather than exact value.
 */

import type { JsonValue } from '../types.js';

// ---------------------------------------------------------------------------
// Type-pattern matchers for body leaves
// ---------------------------------------------------------------------------

/**
 * UUID v4 regex — standard 8-4-4-4-12 hex format.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ISO-8601 datetime regex — covers "YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:MM]".
 */
const DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * ISO date regex — "YYYY-MM-DD".
 */
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Check whether a string token is a Specmatic type-pattern.
 * A type-pattern is either `*` or a parenthesised name: `(string)`, `(number)`, etc.
 */
export function isTypePattern(token: string): boolean {
  return token === '*' || /^\(.*\)$/.test(token);
}

/**
 * Match a request value against a Specmatic type-pattern string.
 * Returns true if the pattern is satisfied, false otherwise.
 *
 * Supported patterns:
 *  (string)              — any string value
 *  (number)              — any number (integer or floating-point)
 *  (integer)             — integer number (no fractional part)
 *  (boolean)             — boolean true or false
 *  (null)                — null
 *  (anyvalue) / (any) / * — any value of any type
 *  (uuid)                — string in UUID v4 format
 *  (datetime) / (date-time) — ISO-8601 datetime string
 *  (date)                — ISO date string (YYYY-MM-DD)
 */
export function matchTypePattern(pattern: string, value: unknown): boolean {
  const p = pattern.toLowerCase();
  switch (p) {
    case '(string)':
      return typeof value === 'string';
    case '(number)':
      return typeof value === 'number';
    case '(integer)':
      return typeof value === 'number' && Number.isInteger(value);
    case '(boolean)':
      return typeof value === 'boolean';
    case '(null)':
      return value === null;
    case '(anyvalue)':
    case '(any)':
    case '*':
      return true;
    case '(uuid)':
      return typeof value === 'string' && UUID_REGEX.test(value);
    case '(datetime)':
    case '(date-time)':
      return typeof value === 'string' && DATETIME_REGEX.test(value);
    case '(date)':
      return typeof value === 'string' && DATE_REGEX.test(value);
    default:
      // Unknown pattern — fall back to exact equality with the pattern string itself.
      return value === pattern;
  }
}

/**
 * Deep-equality check — hand-rolled since fast-deep-equal is not in deps.
 * Handles null, primitives, arrays and plain objects.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * Match HTTP method — case-insensitive exact match.
 */
export function matchMethod(matcherMethod: string, requestMethod: string): boolean {
  return matcherMethod.toUpperCase() === requestMethod.toUpperCase();
}

/**
 * Match request path — exact literal equality.
 * (T1: no path-template expansion; that is T2.)
 */
export function matchPath(matcherPath: string, requestPath: string): boolean {
  return matcherPath === requestPath;
}

/**
 * Wildcard patterns — a matcher value equal to any of these strings matches any request value.
 * Supported aliases: "(anyvalue)", "(any)", "(string)", "*"
 */
const WILDCARD_PATTERNS = new Set(['(anyvalue)', '(any)', '(string)', '*']);

function isWildcard(value: string): boolean {
  return WILDCARD_PATTERNS.has(value);
}

/**
 * Match headers — subset match with wildcard and optional-header support.
 *
 * Extended semantics (T2):
 *  - Matcher value of "(anyvalue)", "(any)", "(string)", or "*" matches any present value.
 *  - Matcher header name prefixed with "?" (e.g. "?X-Trace-Id") is OPTIONAL: if the header
 *    is absent from the request the matcher still passes; if present the value is checked
 *    (including wildcard support). This allows "match if present, ignore if absent" semantics.
 *
 * Every header declared in the matcher must be present in the request with the same value
 * (unless optional or wildcard). Header name comparison is case-insensitive (HTTP spec §3.2).
 * Extra headers in the request are ignored.
 */
export function matchHeaders(
  matcherHeaders: Readonly<Record<string, string>> | undefined,
  requestHeaders: Record<string, string>,
): boolean {
  if (!matcherHeaders) return true;

  // Build a lowercase-keyed map of request headers for case-insensitive lookup
  const lcRequest: Record<string, string> = {};
  for (const [k, v] of Object.entries(requestHeaders)) {
    lcRequest[k.toLowerCase()] = v;
  }

  for (const [rawKey, expectedValue] of Object.entries(matcherHeaders)) {
    // A leading '?' marks the header as optional (match if present, ignore if absent).
    const optional = rawKey.startsWith('?');
    const key = optional ? rawKey.slice(1) : rawKey;

    const actual = lcRequest[key.toLowerCase()];
    if (actual === undefined) {
      // Optional header may be absent
      if (optional) continue;
      return false;
    }
    // Wildcard: matches any present value
    if (isWildcard(expectedValue)) continue;
    if (actual !== expectedValue) return false;
  }
  return true;
}

/**
 * Match query parameters — per-key exact equality with ANY-value wildcard support.
 *
 * Extended semantics (T2):
 *  - A matcher value of "(anyvalue)", "(any)", "(string)", or "*" matches any present value
 *    for that key. The key must still be PRESENT in the request.
 *  - For array values, a single wildcard string in the matcher matches any single-element array.
 *
 * Every key present in the matcher must appear in the request with matching value(s).
 * String-vs-array comparison: a single matcher string matches a single-element array
 * and vice versa for convenience.
 * Extra request query params beyond those declared in the matcher are ignored.
 */
export function matchQueryParams(
  matcherQuery: Readonly<Record<string, string | string[]>> | undefined,
  requestQuery: Record<string, string | string[]>,
): boolean {
  if (!matcherQuery) return true;

  for (const [key, expectedValue] of Object.entries(matcherQuery)) {
    const actualValue = requestQuery[key];
    if (actualValue === undefined) return false;

    const expected = Array.isArray(expectedValue) ? expectedValue : [expectedValue];
    const actual = Array.isArray(actualValue) ? actualValue : [actualValue];

    // Single wildcard matcher value: key must be present (checked above) with any value.
    // For single-wildcard arrays, treat as "match any single value present".
    if (expected.length === 1 && isWildcard(expected[0]!)) continue;

    if (expected.length !== actual.length) return false;
    for (let i = 0; i < expected.length; i++) {
      const exp = expected[i]!;
      if (isWildcard(exp)) continue;
      if (exp !== actual[i]) return false;
    }
  }
  return true;
}

/**
 * Deep-match two JSON values where matcher leaves may be type-pattern strings.
 *
 * Walk the matcher tree alongside the request tree:
 *  - Matcher leaf is a type-pattern string (e.g. "(number)", "*") → test request
 *    value against the pattern; does NOT require string type on request side.
 *  - Matcher leaf is any other primitive → require strict equality.
 *  - Matcher is an object → request must also be a plain object with identical
 *    keys; each value is compared recursively (key order insensitive).
 *  - Matcher is an array → request must be an array of the same length; elements
 *    compared recursively in order.
 *  - Matcher is null → matches request null only.
 */
function deepMatchWithPatterns(matcher: unknown, request: unknown): boolean {
  // --- type-pattern leaf (checked before null so (null) and (any) work correctly) ---
  if (typeof matcher === 'string' && isTypePattern(matcher)) {
    return matchTypePattern(matcher, request);
  }

  // --- null ---
  if (matcher === null) return request === null;
  if (request === null) return false;

  // --- primitive leaf (non-pattern string, number, boolean) ---
  if (typeof matcher !== 'object') {
    return matcher === request;
  }

  // --- array ---
  if (Array.isArray(matcher)) {
    if (!Array.isArray(request)) return false;
    if (matcher.length !== request.length) return false;
    for (let i = 0; i < matcher.length; i++) {
      if (!deepMatchWithPatterns(matcher[i], request[i])) return false;
    }
    return true;
  }

  // --- plain object ---
  if (Array.isArray(request) || typeof request !== 'object') return false;
  const mObj = matcher as Record<string, unknown>;
  const rObj = request as Record<string, unknown>;
  const mKeys = Object.keys(mObj);
  const rKeys = Object.keys(rObj);
  if (mKeys.length !== rKeys.length) return false;
  for (const k of mKeys) {
    if (!Object.prototype.hasOwnProperty.call(rObj, k)) return false;
    if (!deepMatchWithPatterns(mObj[k], rObj[k])) return false;
  }
  return true;
}

/**
 * Match request body.
 *
 * When `matcher.body` is undefined or null the check is skipped (any body matches).
 *
 * Otherwise the matcher body is walked alongside the request body:
 *  - Scalar leaves that are type-pattern strings (`(number)`, `(string)`, `(boolean)`,
 *    `(integer)`, `(null)`, `(any)`, `(anyvalue)`, `*`, `(uuid)`, `(datetime)`,
 *    `(date-time)`, `(date)`) match by type/format rather than exact value.
 *  - All other leaves require strict equality.
 *  - Objects: key-order insensitive; all matcher keys must be present with matching values.
 *  - Arrays: order-sensitive; lengths must match.
 */
export function matchBody(matcherBody: JsonValue | undefined, requestBody: JsonValue): boolean {
  if (matcherBody === undefined || matcherBody === null) return true;
  return deepMatchWithPatterns(matcherBody, requestBody);
}
