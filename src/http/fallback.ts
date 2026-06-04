/**
 * Fallback policy for requests that match no boundary.
 *
 * A single top-level `fallback:` concept (global config) decides what an unmatched
 * request gets — an ordered list of rules (match on path glob / method /
 * in_contract) producing a static status+body, plus a default. With zero config
 * the default is 501 NOT_IMPLEMENTED when the path is a declared OpenAPI path
 * (declared but not simulated) and 404 NO_ROUTE otherwise.
 *
 * The engine evaluates this for its direct gateway, and publishes the compiled
 * rules + contract path set at GET /_engine/fallback so the plugin can apply the
 * SAME policy through the Specmatic stub (rather than letting Specmatic generate
 * examples for unmatched paths).
 */
import type { Request, Response } from 'express';
import type { BootedSystem } from '../engine/boot.js';
import type { OpenApiDoc } from '../contract/loader.js';
import type { FallbackConfig, FallbackResponse } from '../dsl/types.js';
import type { JsonValue } from '../types.js';

export interface FallbackOutcome {
  readonly status: number;
  readonly body: JsonValue;
}

/** Convert an OpenAPI path template or glob to a matching RegExp. */
function patternToRegex(pattern: string): RegExp {
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '{') {
      const close = pattern.indexOf('}', i);
      if (close > i) { out += '[^/]+'; i = close + 1; continue; }
    }
    if (c === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i += 2; continue; } // ** = any
      out += '[^/]*'; i += 1; continue;                              // *  = within segment
    }
    out += c.replace(/[.\\+?[^\]$(){}=!<>|:#-]/g, (m) => `\\${m}`);
    i += 1;
  }
  return new RegExp(out + '$');
}

/** Build the set of OpenAPI contract path matchers (used for the in_contract check). */
export function buildContractMatchers(openapi: OpenApiDoc): RegExp[] {
  return Object.keys(openapi.paths).map(patternToRegex);
}

export function isInContract(path: string, matchers: readonly RegExp[]): boolean {
  return matchers.some((re) => re.test(path));
}

function bodyForStatus(status: number, path: string): JsonValue {
  if (status === 501) return { error: 'NOT_IMPLEMENTED', path };
  if (status === 404) return { error: 'NO_ROUTE', path };
  return { error: 'UNHANDLED', path };
}

function applyResponse(respond: FallbackResponse, path: string): FallbackOutcome {
  return { status: respond.status, body: respond.body ?? bodyForStatus(respond.status, path) };
}

/**
 * Evaluate the fallback policy for an unmatched request. First matching rule
 * wins; otherwise the configured default; otherwise the zero-config default
 * (501 in-contract / 404 otherwise).
 */
export function evaluateFallback(
  cfg: FallbackConfig | undefined,
  ctx: { path: string; method: string; inContract: boolean },
): FallbackOutcome {
  for (const rule of cfg?.rules ?? []) {
    const m = rule.match;
    if (m.method !== undefined && m.method.toUpperCase() !== ctx.method.toUpperCase()) continue;
    if (m.inContract !== undefined && m.inContract !== ctx.inContract) continue;
    if (m.path !== undefined && !patternToRegex(m.path).test(ctx.path)) continue;
    return applyResponse(rule.respond, ctx.path);
  }
  if (cfg?.default !== undefined) return applyResponse(cfg.default, ctx.path);
  return ctx.inContract
    ? { status: 501, body: { error: 'NOT_IMPLEMENTED', path: ctx.path } }
    : { status: 404, body: { error: 'NO_ROUTE', path: ctx.path } };
}

/** Terminal Express middleware: apply the fallback policy to any unmatched request. */
export function createFallbackHandler(sys: BootedSystem) {
  const matchers = buildContractMatchers(sys.openapi);
  return function fallbackHandler(req: Request, res: Response): void {
    const inContract = isInContract(req.path, matchers);
    const outcome = evaluateFallback(sys.dsl.fallback, { path: req.path, method: req.method, inContract });
    res.status(outcome.status).json(outcome.body);
  };
}

/** GET /_engine/fallback — publish the compiled rules + contract paths for the plugin. */
export function createFallbackMetadataHandler(sys: BootedSystem) {
  const body = {
    rules: sys.dsl.fallback?.rules ?? [],
    default: sys.dsl.fallback?.default ?? null,
    contractPaths: Object.keys(sys.openapi.paths),
    engine: 'potemkin-stateful',
  };
  return function fallbackMetadataHandler(_req: Request, res: Response): void {
    res.status(200).json(body);
  };
}
