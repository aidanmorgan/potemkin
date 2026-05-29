/**
 * Compile user-facing response-mutation DSL into the canonical Patch[]
 * vocabulary, so the response interceptor doesn't carry parallel mutation
 * logic (REQ-RESP-004).
 *
 * Three families of mutation are handled:
 *   - HATEOAS (REQ-RESP-001): per-boundary `hateoas:` list → `_links` patches
 *     against the response body. Per-boundary override replaces the OpenAPI
 *     `links:` default (caller-supplied or omitted).
 *   - Deprecation/Sunset (REQ-RESP-002): boundary `deprecation:` block →
 *     header patches against `/headers/Deprecation` and `/headers/Sunset`.
 *   - Masking (REQ-RESP-003): `mask: [field, ...]` → `{op: remove, path}`
 *     patches against the body.
 *
 * Every emitted patch is tagged with a `source:` field via patches.ts so the
 * journal carries the same uniform shape across reducers / seeds / response
 * mutations.
 */

import type { Patch } from './patches.js';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface HateoasEntry {
  readonly rel: string;
  readonly href: string;
}

export interface DeprecationConfig {
  /** Optional — when present the Sunset header is emitted in addition. */
  readonly sunset?: string;
  /** Optional Link replacement; emits Link: <replacement>; rel="successor-version". */
  readonly replacement?: string;
}

export interface ResponseDslInput {
  readonly hateoas?: readonly HateoasEntry[];
  readonly deprecation?: DeprecationConfig;
  readonly mask?: readonly string[];
}

// ---------------------------------------------------------------------------
// Compile-then-apply (REQ-RESP-004)
// ---------------------------------------------------------------------------

/**
 * Compile every declared response mutation in `input` into a single ordered
 * Patch[]. Order: HATEOAS → deprecation headers → masking. Caller passes the
 * result to applyPatches() with the appropriate source tag.
 *
 * To preserve the per-source journal grouping that REQ-PATCH-004 mandates,
 * the engine wires three calls (one per source) rather than a single
 * bulk apply.
 */
export function compileResponseHateoas(entries: readonly HateoasEntry[]): Patch[] {
  if (entries.length === 0) return [];
  const out: Patch[] = [];
  // Build `_links` as a single merge so the response body's existing
  // _links (if any) survive. Strategy:
  //   - First patch: add {} at /_links if missing (best-effort by replacing
  //     with merge into a literal {})
  //   - Then one add per rel
  const links: Record<string, { href: string }> = {};
  for (const e of entries) links[e.rel] = { href: e.href };
  out.push({
    op: 'merge',
    path: '/_links',
    value: links as unknown as Record<string, import('../types.js').JsonValue>,
  });
  return out;
}

export function compileResponseDeprecation(config: DeprecationConfig | undefined): Patch[] {
  if (!config) return [];
  const out: Patch[] = [
    { op: 'add', path: '/headers/Deprecation', value: 'true' },
  ];
  if (config.sunset) {
    out.push({ op: 'add', path: '/headers/Sunset', value: config.sunset });
  }
  if (config.replacement) {
    out.push({
      op: 'add',
      path: '/headers/Link',
      value: `<${config.replacement}>; rel="successor-version"`,
    });
  }
  return out;
}

export function compileResponseMask(fields: readonly string[]): Patch[] {
  if (fields.length === 0) return [];
  // Apply removes against the response body; field names map to root-level
  // pointers. Nested paths can be authored as RFC 6901 strings already.
  return fields.map((f): Patch => ({ op: 'remove', path: f.startsWith('/') ? f : `/${f}` }));
}

/**
 * Compile every category present in `input` into a single { hateoas, deprecation,
 * mask } bundle so the caller can apply each batch with its own `source:` tag
 * (REQ-PATCH-004) without re-implementing the mutation logic.
 */
export interface CompiledResponseDsl {
  readonly hateoas: readonly Patch[];
  readonly deprecation: readonly Patch[];
  readonly mask: readonly Patch[];
}

export function compileResponseDsl(input: ResponseDslInput): CompiledResponseDsl {
  return {
    hateoas: input.hateoas ? compileResponseHateoas(input.hateoas) : [],
    deprecation: input.deprecation ? compileResponseDeprecation(input.deprecation) : [],
    mask: input.mask ? compileResponseMask(input.mask) : [],
  };
}
