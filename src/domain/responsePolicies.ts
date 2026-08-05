import type { Patch, JsonValue } from '../contracts/value.js';
import type { ResponseDeprecation, HateoasEntry } from '../contracts/response.js';

export interface ResponseDslInput {
  readonly hateoas?: readonly HateoasEntry[];
  readonly deprecation?: ResponseDeprecation;
  readonly mask?: readonly string[];
}

export function compileResponseHateoas(entries: readonly HateoasEntry[]): Patch[] {
  if (entries.length === 0) return [];
  const links: Record<string, JsonValue> = {};
  for (const entry of entries) links[entry.rel] = { href: entry.href };
  return [
    {
      op: 'merge',
      path: '/_links',
      value: links,
    },
  ];
}

const EPOCH_SENTINEL = new Date(0).toISOString();

function deprecationHeaderValue(date: string | undefined): string {
  if (!date || date === EPOCH_SENTINEL) return 'true';
  const parsed = new Date(date);
  return Number.isFinite(parsed.getTime()) ? parsed.toUTCString() : date;
}

export function compileResponseDeprecation(config: ResponseDeprecation | undefined): Patch[] {
  if (!config) return [];
  const patches: Patch[] = [
    { op: 'add', path: '/headers/Deprecation', value: deprecationHeaderValue(config.date) },
  ];
  if (config.sunset) {
    const parsed = new Date(config.sunset);
    patches.push({
      op: 'add',
      path: '/headers/Sunset',
      value: Number.isFinite(parsed.getTime()) ? parsed.toUTCString() : config.sunset,
    });
  }
  if (config.replacement) {
    patches.push({
      op: 'add',
      path: '/headers/Link',
      value: `<${config.replacement}>; rel="successor-version"`,
    });
  }
  return patches;
}

export function compileResponseMask(fields: readonly string[]): Patch[] {
  return fields.map(
    (field): Patch => ({
      op: 'remove',
      path: field.startsWith('/') ? field : `/${field}`,
    }),
  );
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
