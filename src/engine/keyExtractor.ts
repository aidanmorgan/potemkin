/**
 * Identity-key extraction.
 *
 * Implements the YAML `identity.key:` policy that lets boundaries declare
 * where to read the entity key from on the request (URL path params, query
 * string, headers, body, or arbitrary CEL).
 *
 * When no `key:` policy is set, callers fall back to the `{id}` OpenAPI path
 * parameter (backwards-compatible behaviour).
 */

import type { IdentityKeyConfig, BoundaryConfig } from '../dsl/types.js';
import type { Command } from '../types.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import { CelPhase } from '../cel/phases.js';

export interface ExtractKeyInput {
  readonly boundary: BoundaryConfig;
  readonly pathParams: Record<string, string>;
  readonly queryParams: Record<string, string | string[]>;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  /** When supplied, used for the CEL escape hatch (`identity.key.cel`). */
  readonly cel?: CelEvaluator;
  readonly command?: Command;
}

function pickQuery(q: Record<string, string | string[]>, name: string): string | undefined {
  const v = q[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function readDotPath(obj: unknown, path: string): unknown {
  if (path === '' || obj === null || obj === undefined) return undefined;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Resolve an entity key from a request, honouring the boundary's `identity.key`
 * config when set. Returns null when no key can be derived (caller decides
 * whether to fall back to `{id}` path param or auto-generate).
 */
export function extractEntityKey(input: ExtractKeyInput): string | null {
  const cfg: IdentityKeyConfig | undefined = input.boundary.identity?.key;

  if (cfg === undefined) {
    // Default behaviour: read the {id} path param.
    const id = input.pathParams['id'];
    return id !== undefined ? id : null;
  }

  // CEL escape hatch wins when set.
  if (cfg.cel && input.cel && input.command) {
    try {
      const result = input.cel.evaluateDslValue(
        cfg.cel,
        { command: input.command as unknown as Record<string, unknown> },
        CelPhase.Behavior,
      );
      if (typeof result === 'string' && result.length > 0) return result;
    } catch {
      // fall through to declarative sources
    }
  }

  switch (cfg.from) {
    case 'path': {
      if (!cfg.name) return null;
      const v = input.pathParams[cfg.name];
      return typeof v === 'string' && v.length > 0 ? v : null;
    }
    case 'query': {
      if (!cfg.name) return null;
      const v = pickQuery(input.queryParams, cfg.name);
      return typeof v === 'string' && v.length > 0 ? v : null;
    }
    case 'header': {
      if (!cfg.name) return null;
      const v = input.headers[cfg.name.toLowerCase()];
      return typeof v === 'string' && v.length > 0 ? v : null;
    }
    case 'payload': {
      const pointer = cfg.pointer ?? cfg.name;
      if (!pointer) return null;
      const v = readDotPath(input.body, pointer);
      return typeof v === 'string' && v.length > 0 ? v : null;
    }
    default:
      // Unrecognised `from` — surface as null so the caller can decide.
      return null;
  }
}
