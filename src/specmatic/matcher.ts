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
 *                     absent matcher.body matches any request body
 */

import type { JsonValue } from '../types.js';

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
 * Match headers — subset match.
 * Every header declared in the matcher must be present in the request with the same value.
 * Header name comparison is case-insensitive (HTTP spec §3.2); value comparison is exact.
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

  for (const [key, expectedValue] of Object.entries(matcherHeaders)) {
    const actual = lcRequest[key.toLowerCase()];
    if (actual === undefined) return false;
    if (actual !== expectedValue) return false;
  }
  return true;
}

/**
 * Match query parameters — per-key exact equality.
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

    if (expected.length !== actual.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== actual[i]) return false;
    }
  }
  return true;
}

/**
 * Match request body — deep structural equality.
 * If matcher.body is undefined/null the check is skipped (any body matches).
 */
export function matchBody(matcherBody: JsonValue | undefined, requestBody: JsonValue): boolean {
  if (matcherBody === undefined || matcherBody === null) return true;
  return deepEqual(matcherBody, requestBody);
}
