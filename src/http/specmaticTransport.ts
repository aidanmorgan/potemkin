import type { JsonValue } from '../contracts/value.js';
import type { JournalEntry } from '../model/patches.js';
import { BootError } from '../errors.js';
import type { ForwardedRequest } from '../contracts/transport.js';

/** The response envelope returned to the Specmatic transport boundary. */
export interface ForwardedResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: JsonValue;
  readonly _patches?: readonly JournalEntry[];
}

/** A deterministic GET example derived from a runtime baseline entity. */
export interface FixtureStub {
  readonly httpRequest: {
    readonly method: 'GET';
    readonly path: string;
    readonly headers?: Record<string, string>;
    readonly queryParameters?: Record<string, string | string[]>;
  };
  readonly httpResponse: {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: JsonValue;
  };
  readonly source: {
    readonly boundary: string;
    readonly aggregateId: string;
    readonly contractPath: string;
  };
}

export interface FixturesResponse {
  readonly engine: string;
  readonly version: string;
  readonly generatedAt: string;
  readonly checksum: string;
  readonly fixtures: readonly FixtureStub[];
}

export interface RoutesDiscoveryResponse {
  readonly paths: readonly string[];
  readonly engine: string;
  readonly version: string;
  readonly ttlSeconds: number;
  readonly generatedAt: string;
  readonly checksum: string;
}

export function validateForwardedRequest(raw: unknown): ForwardedRequest {
  if (!isObject(raw)) throw malformed('payload must be a ForwardedRequest object');
  if (typeof raw['method'] !== 'string' || raw['method'].trim() === '') {
    throw malformed('method must be a non-empty string');
  }
  if (typeof raw['path'] !== 'string' || !raw['path'].startsWith('/')) {
    throw malformed('path must be an absolute path beginning with "/"');
  }
  const headers = validateStringMap(raw['headers'], 'headers');
  const query = validateQueryMap(raw['query']);
  if (!('body' in raw) || !isJsonValue(raw['body']))
    throw malformed('body must be JSON, including null');
  return {
    method: raw['method'].toUpperCase(),
    path: raw['path'],
    headers: lowerCaseHeaders(headers),
    query,
    body: raw['body'],
  };
}

export function validateForwardedResponse(raw: unknown): ForwardedResponse {
  if (!isObject(raw)) throw malformed('payload must be a ForwardedResponse object');
  if (
    typeof raw['status'] !== 'number' ||
    !Number.isInteger(raw['status']) ||
    raw['status'] < 100 ||
    raw['status'] > 599
  ) {
    throw malformed('status must be an integer between 100 and 599');
  }
  const headers = validateStringMap(raw['headers'], 'headers');
  if (!('body' in raw) || !isJsonValue(raw['body']))
    throw malformed('body must be JSON, including null');
  if (raw['_patches'] !== undefined && !Array.isArray(raw['_patches']))
    throw malformed('_patches must be an array when present');
  return {
    status: raw['status'],
    headers: lowerCaseHeaders(headers),
    body: raw['body'],
    ...(raw['_patches'] === undefined
      ? {}
      : { _patches: raw['_patches'] as readonly JournalEntry[] }),
  };
}

function validateStringMap(raw: unknown, field: string): Record<string, string> {
  if (!isObject(raw)) throw malformed(`${field} must be an object`);
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') throw malformed(`${field}.${key} must be a string`);
    output[key] = value;
  }
  return output;
}

function validateQueryMap(raw: unknown): Record<string, string | string[]> {
  if (!isObject(raw)) throw malformed('query must be an object');
  const output: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') output[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
      output[key] = [...value] as string[];
    else throw malformed(`query.${key} must be a string or string array`);
  }
  return output;
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === 'object' && value !== null && Object.values(value).every(isJsonValue);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function malformed(message: string): BootError {
  return new BootError('BOOT_ERR_MALFORMED_FORWARDED_REQUEST', message, { message });
}
