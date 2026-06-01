import type { JsonValue } from '../types.js';
import { ContractViolationError } from '../errors.js';

export interface FaultSignal {
  readonly status: number;
  readonly body: JsonValue;
  readonly headers?: Record<string, string>;
}

/**
 * Inspect request headers for a fault-simulation directive.
 *
 * Convention: the header `x-specmatic-fault` (case-insensitive) carries a JSON-encoded
 * object with shape `{ status: number, body: JsonValue, headers?: Record<string,string> }`.
 *
 * Returns null if the header is absent.
 *
 * @throws {ContractViolationError} (400) if the header is present but not valid JSON
 *   or does not match the expected shape.
 */
export function extractFaultSignal(
  headers: Record<string, string | string[] | undefined>,
): FaultSignal | null {
  // Locate the header value with a case-insensitive key search.
  let raw: string | undefined;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'x-specmatic-fault') {
      const val = headers[key];
      if (Array.isArray(val)) {
        raw = val[0];
      } else {
        raw = val;
      }
      break;
    }
  }

  if (raw === undefined || raw === '') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ContractViolationError('Malformed x-specmatic-fault header', { raw });
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new ContractViolationError('Malformed x-specmatic-fault header', { raw });
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['status'] !== 'number') {
    throw new ContractViolationError('Malformed x-specmatic-fault header', { raw });
  }

  // Valid HTTP status codes are in the range 100–599.
  const statusVal = obj['status'] as number;
  if (statusVal < 100 || statusVal > 599) {
    throw new ContractViolationError('Malformed x-specmatic-fault header', {
      reason: 'status out of range',
      status: statusVal,
    });
  }

  // `body` is required; any non-undefined JSON value qualifies at parse time.
  if (!('body' in obj)) {
    throw new ContractViolationError('Malformed x-specmatic-fault header', { raw });
  }

  const signal: FaultSignal = {
    status: obj['status'] as number,
    body: obj['body'] as JsonValue,
    // typeof null === 'object', so null must be rejected explicitly.
    headers:
      obj['headers'] !== null &&
      obj['headers'] !== undefined &&
      typeof obj['headers'] === 'object' &&
      !Array.isArray(obj['headers'])
        ? (obj['headers'] as Record<string, string>)
        : undefined,
  };

  return signal;
}
