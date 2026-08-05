import type { JsonObject, JsonValue } from '../contracts/value.js';
import { aggregateId } from './references.js';

export type IdentitySource = 'path' | 'query' | 'header' | 'payload';

export interface IdentityKey {
  readonly from: IdentitySource;
  readonly name?: string;
  readonly pointer?: string;
}

export interface IdentityResolutionInput {
  readonly targetId: string | null;
  readonly key?: IdentityKey;
  readonly generated?: () => string;
  readonly path: string;
  readonly contractPath: string;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: JsonObject;
  readonly fallback: () => string;
}

function readPointer(
  value: JsonValue | undefined,
  pointer: string | undefined,
): JsonValue | undefined {
  if (pointer === undefined || pointer === '') return value;
  const segments = pointer.startsWith('/')
    ? pointer
        .slice(1)
        .split('/')
        .map((item) => item.replace(/~1/g, '/').replace(/~0/g, '~'))
    : pointer.split('.');
  let current = value;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = Array.isArray(current) ? current[Number(segment)] : (current as JsonObject)[segment];
  }
  return current;
}

function pathValue(path: string, template: string, name: string | undefined): string | undefined {
  const actual = path.split('/').filter(Boolean);
  if (name === undefined) return actual.at(-1);
  const expected = template.split('/').filter(Boolean);
  const index = expected.findIndex((segment) => segment === `{${name}}` || segment === `:${name}`);
  return index >= 0 ? actual[index] : undefined;
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

function candidateValue(input: IdentityResolutionInput): JsonValue | undefined {
  const key = input.key;
  if (key === undefined) return undefined;
  if (key.from === 'path') return pathValue(input.path, input.contractPath, key.name);
  if (key.from === 'header') return headerValue(input.headers, key.name ?? key.pointer ?? '');
  const source = key.from === 'payload' ? input.payload : input.query;
  return readPointer(source as JsonValue, key.pointer ?? key.name);
}

/** Resolve an aggregate identity from a compiled, transport-neutral policy. */
export function resolveAggregateId(input: IdentityResolutionInput) {
  if (input.targetId !== null) return aggregateId(input.targetId);
  if (input.generated !== undefined) return aggregateId(input.generated());
  const value = candidateValue(input);
  if (typeof value === 'string' && value.length > 0) return aggregateId(value);
  if (typeof value === 'number') return aggregateId(String(value));
  return aggregateId(input.fallback());
}
