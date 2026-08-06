import {
  isJsonObject,
  isJsonValue,
  PatchOperation,
  PatchSource,
  type JsonValue,
  type PatchOperation as PatchOperationValue,
  type PatchSource as PatchSourceValue,
} from '../contracts/value.js';
import { jsonPath } from '../domain/references.js';
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
  const patches =
    raw['_patches'] === undefined ? undefined : validateJournalEntries(raw['_patches']);
  return {
    status: raw['status'],
    headers: lowerCaseHeaders(headers),
    body: raw['body'],
    ...(patches === undefined ? {} : { _patches: patches }),
  };
}

type TransportJournalOperation = Exclude<PatchOperationValue, typeof PatchOperation.Upsert>;

function validateJournalEntries(raw: unknown): readonly JournalEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isJournalEntry);
}

function isJournalEntry(raw: unknown): raw is JournalEntry {
  if (!isJsonObject(raw)) return false;

  const source = raw['source'];
  const operation = raw['op'];
  const path = raw['path'];
  if (!isPatchSource(source) || !isTransportJournalOperation(operation)) return false;
  if (!isJsonPointer(path)) return false;

  if (hasField(raw, 'value') && !isJsonValue(raw['value'])) return false;
  if (hasField(raw, 'from') && !isJsonPointer(raw['from'])) return false;
  if (hasField(raw, 'by') && (typeof raw['by'] !== 'number' || !Number.isFinite(raw['by']))) {
    return false;
  }

  switch (operation) {
    case PatchOperation.Add:
    case PatchOperation.Replace:
    case PatchOperation.Append:
    case PatchOperation.Prepend:
      return hasField(raw, 'value');
    case PatchOperation.Move:
    case PatchOperation.Copy:
      return hasField(raw, 'from');
    case PatchOperation.Increment:
      return hasField(raw, 'by');
    case PatchOperation.Merge:
      return hasField(raw, 'value') && isJsonObject(raw['value']);
    case PatchOperation.Remove:
      return true;
  }
}

function isTransportJournalOperation(value: unknown): value is TransportJournalOperation {
  switch (value) {
    case PatchOperation.Add:
    case PatchOperation.Remove:
    case PatchOperation.Replace:
    case PatchOperation.Move:
    case PatchOperation.Copy:
    case PatchOperation.Append:
    case PatchOperation.Prepend:
    case PatchOperation.Increment:
    case PatchOperation.Merge:
      return true;
    default:
      return false;
  }
}

function isPatchSource(value: unknown): value is PatchSourceValue {
  switch (value) {
    case PatchSource.Reducer:
    case PatchSource.Projection:
    case PatchSource.Seed:
    case PatchSource.Hateoas:
    case PatchSource.Mask:
    case PatchSource.Deprecation:
    case PatchSource.Overlay:
      return true;
    default:
      return false;
  }
}

function isJsonPointer(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    jsonPath(value);
    return true;
  } catch {
    return false;
  }
}

function hasField(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
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
      output[key] = value.filter((item): item is string => typeof item === 'string');
    else throw malformed(`query.${key} must be a string or string array`);
  }
  return output;
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function malformed(message: string): BootError {
  return new BootError('BOOT_ERR_MALFORMED_FORWARDED_REQUEST', message, { message });
}
