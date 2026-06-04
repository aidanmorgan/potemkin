/**
 * Identity-key extraction.
 *
 * Implements the YAML `identity.key:` policy that lets boundaries declare
 * where to read the entity key from on the request (URL path params, query
 * string, headers, or body). The boot validator guarantees a usable `from` and
 * locator, so each source either resolves a key or the request is treated as
 * having no `{id}` (the caller decides: 404 on mutation, generate on creation).
 *
 * When no `key:` policy is set, the extractor reads the `{id}` OpenAPI path
 * parameter — the conventional default for the REST `/resource/{id}` shape, so
 * the common case needs no `identity.key` boilerplate. Declare `identity.key`
 * only when the key lives somewhere other than a path param named `id`.
 */

import type { IdentityKeyConfig, BoundaryConfig } from '../dsl/types.js';

export interface ExtractKeyInput {
  readonly boundary: BoundaryConfig;
  readonly pathParams: Record<string, string>;
  readonly queryParams: Record<string, string | string[]>;
  readonly headers: Record<string, string>;
  readonly body: unknown;
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
    // Conventional default: read the {id} path param (REST /resource/{id}).
    const id = input.pathParams['id'];
    return id !== undefined ? id : null;
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
