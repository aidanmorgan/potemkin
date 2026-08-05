import type { JsonObject, JsonValue } from '../contracts/value.js';

/** Query policy operations over JSON-shaped aggregate projections. */
export type QueryOperatorStrategy = (value: JsonValue, expected: string) => boolean;

export function queryValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'object' && value !== null ? value[0] : value;
}

export function readPath(value: JsonValue | undefined, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = Array.isArray(current) ? current[Number(segment)] : (current as JsonObject)[segment];
  }
  return current;
}

export function compareQueryValues(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

const queryOperatorStrategies: Readonly<Record<string, QueryOperatorStrategy>> = {
  arrayContains: (value, expected) =>
    Array.isArray(value) && value.some((item) => String(item) === expected),
  contains: (value, expected) =>
    Array.isArray(value)
      ? value.some((item) => String(item) === expected)
      : typeof value === 'string' && value.toLowerCase().includes(expected.toLowerCase()),
  startsWith: (value, expected) =>
    typeof value === 'string' && value.toLowerCase().startsWith(expected.toLowerCase()),
  endsWith: (value, expected) =>
    typeof value === 'string' && value.toLowerCase().endsWith(expected.toLowerCase()),
  in: (value, expected) =>
    expected
      .split(',')
      .map((item) => item.trim())
      .includes(String(value)),
};

export function queryOperator(
  value: JsonValue | undefined,
  operator: string,
  expected: string,
): boolean {
  if (value === null || value === undefined) return operator === 'ne';
  const strategy = queryOperatorStrategies[operator];
  if (strategy !== undefined) return strategy(value, expected);

  const numericValue = Number(value);
  const numericExpected = Number(expected);
  const numeric =
    !Number.isNaN(numericValue) && !Number.isNaN(numericExpected) && expected.trim() !== '';
  const left = numeric ? numericValue : String(value);
  const right = numeric ? numericExpected : expected;
  switch (operator) {
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
    case 'ne':
      return String(value) !== expected && left !== right;
    default:
      return false;
  }
}

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += base64Alphabet[first >> 2];
    encoded += base64Alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    encoded +=
      second === undefined ? '=' : base64Alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    encoded += third === undefined ? '=' : base64Alphabet[third & 63];
  }
  return encoded.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const bytes: number[] = [];
  for (let index = 0; index < padded.length; index += 4) {
    const first = base64Alphabet.indexOf(padded[index]!);
    const second = base64Alphabet.indexOf(padded[index + 1]!);
    const third = padded[index + 2] === '=' ? 0 : base64Alphabet.indexOf(padded[index + 2]!);
    const fourth = padded[index + 3] === '=' ? 0 : base64Alphabet.indexOf(padded[index + 3]!);
    if ([first, second, third, fourth].some((item) => item < 0)) throw new Error('Invalid cursor');
    bytes.push((first << 2) | (second >> 4));
    if (padded[index + 2] !== '=') bytes.push(((second & 15) << 4) | (third >> 2));
    if (padded[index + 3] !== '=') bytes.push(((third & 3) << 6) | fourth);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function encodeCursor(id: string): string {
  return encodeBase64Url(JSON.stringify({ id }));
}

export function decodeCursor(value: string): string | undefined {
  try {
    const decoded = JSON.parse(decodeBase64Url(value)) as { id?: unknown };
    return typeof decoded.id === 'string' ? decoded.id : undefined;
  } catch {
    return undefined;
  }
}

export function selectFields(value: JsonObject, fields: readonly string[]): JsonObject {
  if (fields.length === 0) return value;
  const output: JsonObject = {};
  for (const field of new Set(['id', ...fields])) if (field in value) output[field] = value[field]!;
  return output;
}

export function expandFields(
  value: JsonObject,
  fields: readonly string[],
  state: ReadonlyMap<string, JsonObject>,
): JsonObject {
  if (fields.length === 0) return value;
  const output = { ...value };
  for (const field of fields) {
    const ids = value[field];
    if (!Array.isArray(ids)) continue;
    output[`_${field}`] = ids
      .filter((id): id is string => typeof id === 'string')
      .map((id) => state.get(id))
      .filter((item): item is JsonObject => item !== undefined);
  }
  return output;
}
