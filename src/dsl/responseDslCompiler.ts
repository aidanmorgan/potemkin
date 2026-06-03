// Compile response-mutation DSL (hateoas, deprecation, mask) into Patch[]
// batches so the response interceptor only knows how to apply patches.
// Three batches are returned so each can be applied with its own journal
// source tag.

import type { Patch } from './patches.js';
import type { JsonValue } from '../types.js';

export interface HateoasEntry {
  readonly rel: string;
  readonly href: string;
}

export interface DeprecationConfig {
  // ISO-8601 deprecation date. Epoch sentinel (new Date(0).toISOString()) means
  // no explicit date was configured; any other value becomes an HTTP-date in the
  // Deprecation header per RFC 8594.
  readonly date?: string;
  // When sunset is present a Sunset header is emitted alongside Deprecation.
  readonly sunset?: string;
  // Replacement path; emits Link: <replacement>; rel="successor-version".
  readonly replacement?: string;
}

export interface ResponseDslInput {
  readonly hateoas?: readonly HateoasEntry[];
  readonly deprecation?: DeprecationConfig;
  readonly mask?: readonly string[];
}

export function compileResponseHateoas(entries: readonly HateoasEntry[]): Patch[] {
  if (entries.length === 0) return [];
  // Merge into /_links preserves any existing rels on the body.
  const out: Patch[] = [];
  const links: Record<string, { href: string }> = {};
  for (const e of entries) links[e.rel] = { href: e.href };
  out.push({
    op: 'merge',
    path: '/_links',
    value: links as unknown as Record<string, JsonValue>,
  });
  return out;
}

const EPOCH_SENTINEL = new Date(0).toISOString();

function deprecationHeaderValue(date: string | undefined): string {
  if (!date || date === EPOCH_SENTINEL) return 'true';
  const d = new Date(date);
  return Number.isFinite(d.getTime()) ? d.toUTCString() : date;
}

export function compileResponseDeprecation(config: DeprecationConfig | undefined): Patch[] {
  if (!config) return [];
  const out: Patch[] = [
    { op: 'add', path: '/headers/Deprecation', value: deprecationHeaderValue(config.date) },
  ];
  if (config.sunset) {
    const sunsetDate = new Date(config.sunset);
    const sunsetValue = Number.isFinite(sunsetDate.getTime())
      ? sunsetDate.toUTCString()
      : config.sunset;
    out.push({ op: 'add', path: '/headers/Sunset', value: sunsetValue });
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
