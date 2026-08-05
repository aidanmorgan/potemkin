import { RuntimeExecutionError } from '../core/errors.js';
import type { RuntimeFault } from '../model/runtime.js';
import type { JsonValue } from '../contracts/value.js';

export interface RuntimeFaultWireRegistration {
  readonly rule: RuntimeFault;
  readonly ttlMs?: number;
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return true;
  if (Array.isArray(value)) return value.every(jsonValue);
  return recordValue(value) && Object.values(value).every(jsonValue);
}

function stringMap(value: unknown, field: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!recordValue(value) || Object.entries(value).some(([, entry]) => typeof entry !== 'string')) {
    throw new RuntimeExecutionError(400, `Invalid ${field}`, {
      code: 'INVALID_FAULT_RULE',
      message: `${field} must be an object of strings`,
    });
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, entry as string]));
}

function optionalNonNegativeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RuntimeExecutionError(400, `Invalid ${field}`, {
      code: 'INVALID_FAULT_RULE',
      message: `${field} must be a non-negative finite number`,
    });
  }
  return value;
}

function ttlMilliseconds(value: Record<string, unknown>, nowMs: number): number | undefined {
  if (value.ttlMs !== undefined) {
    if (typeof value.ttlMs !== 'number' || !Number.isFinite(value.ttlMs) || value.ttlMs <= 0) {
      throw new RuntimeExecutionError(400, 'Invalid fault TTL', {
        code: 'INVALID_FAULT_RULE',
        message: 'ttlMs must be a positive finite number',
      });
    }
    return value.ttlMs;
  }
  if (value.expiresAt !== undefined) {
    if (
      typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= nowMs
    ) {
      throw new RuntimeExecutionError(400, 'Invalid fault expiry', {
        code: 'INVALID_FAULT_RULE',
        message: 'expiresAt must be a finite timestamp in the future',
      });
    }
    return value.expiresAt - nowMs;
  }
  return undefined;
}

/** Parse the source-neutral JSON fault form accepted by the generic gateway. */
export function parseRuntimeFaultWire(value: unknown, nowMs: number): RuntimeFaultWireRegistration {
  if (!recordValue(value)) {
    throw new RuntimeExecutionError(400, 'Invalid fault rule', {
      code: 'INVALID_FAULT_RULE',
      message: 'A fault rule must be an object',
    });
  }
  const match = value.match === undefined ? {} : value.match;
  const response = value.response;
  if (!recordValue(match) || !recordValue(response)) {
    throw new RuntimeExecutionError(400, 'Invalid fault rule', {
      code: 'INVALID_FAULT_RULE',
      message: 'A fault rule requires `match` and `response` objects',
    });
  }
  const status = response.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new RuntimeExecutionError(400, 'Invalid fault response status', {
      code: 'INVALID_FAULT_RULE',
      message: 'Fault response status must be an integer between 100 and 599',
    });
  }
  const body = response.body;
  if (body !== undefined && !jsonValue(body)) {
    throw new RuntimeExecutionError(400, 'Invalid fault response body', {
      code: 'INVALID_FAULT_RULE',
      message: 'Fault response body must be JSON',
    });
  }
  const responseHeaders = stringMap(response.headers, 'response.headers');
  const headers = stringMap(match.headers ?? value.headers, 'match.headers');
  const name =
    typeof value.name === 'string' && value.name.trim() !== '' ? value.name : 'dynamic-fault';
  const condition = match.condition;
  if (condition !== undefined && condition !== true && condition !== 'true') {
    throw new RuntimeExecutionError(400, 'Unsupported direct fault condition', {
      code: 'INVALID_FAULT_RULE',
      message:
        'The generic TypeScript runtime accepts typed predicates; CEL conditions are compiled by the YAML parser',
    });
  }
  const expectedBoundary = typeof match.boundary === 'string' ? match.boundary : undefined;
  const expectedIntent =
    match.intent === 'creation' || match.intent === 'mutation' || match.intent === 'query'
      ? match.intent
      : undefined;
  if (match.intent !== undefined && expectedIntent === undefined) {
    throw new RuntimeExecutionError(400, 'Invalid fault intent', {
      code: 'INVALID_FAULT_RULE',
      message: 'match.intent must be creation, mutation, or query',
    });
  }
  const expectedOperation =
    typeof match.operationId === 'string'
      ? match.operationId
      : typeof match.operation_id === 'string'
        ? match.operation_id
        : undefined;
  const expectedMethod = typeof match.method === 'string' ? match.method.toUpperCase() : undefined;
  const selectors = {
    ...(typeof match.signal === 'string' ? { signal: match.signal } : {}),
    ...(typeof match.force_response === 'string'
      ? { forceResponse: match.force_response }
      : typeof match.forceResponse === 'string'
        ? { forceResponse: match.forceResponse }
        : {}),
    ...(typeof match.scenario === 'string' ? { scenario: match.scenario } : {}),
    ...(typeof match.feature_flag === 'string'
      ? { featureFlag: match.feature_flag }
      : typeof match.featureFlag === 'string'
        ? { featureFlag: match.featureFlag }
        : {}),
    ...(typeof match.error_class === 'string'
      ? { errorClass: match.error_class as NonNullable<RuntimeFault['selectors']>['errorClass'] }
      : typeof match.errorClass === 'string'
        ? { errorClass: match.errorClass as NonNullable<RuntimeFault['selectors']>['errorClass'] }
        : {}),
  };
  const requiredScopesValue = match.required_scopes ?? value.requiredScopes;
  const requiredScopes =
    requiredScopesValue === undefined
      ? undefined
      : Array.isArray(requiredScopesValue) &&
          requiredScopesValue.every((entry) => typeof entry === 'string')
        ? (requiredScopesValue as string[])
        : (() => {
            throw new RuntimeExecutionError(400, 'Invalid fault scopes', {
              code: 'INVALID_FAULT_RULE',
              message: 'required_scopes must be an array of strings',
            });
          })();
  const probability = value.probability;
  if (
    probability !== undefined &&
    (typeof probability !== 'number' ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1)
  ) {
    throw new RuntimeExecutionError(400, 'Invalid fault probability', {
      code: 'INVALID_FAULT_RULE',
      message: 'probability must be a number between 0 and 1',
    });
  }
  const delayMs = optionalNonNegativeNumber(value.delay_ms ?? response.delay_ms, 'delay_ms');
  const ttlMs = ttlMilliseconds(value, nowMs);
  const rule: RuntimeFault = {
    name,
    ...(headers === undefined ? {} : { headers }),
    ...(Object.keys(selectors).length === 0 ? {} : { selectors }),
    ...(requiredScopes === undefined ? {} : { requiredScopes }),
    ...(probability === undefined ? {} : { probability }),
    response: {
      status,
      ...(body === undefined ? {} : { body }),
      ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
    },
    ...(delayMs === undefined ? {} : { delayMs }),
    matches: ({ command }) =>
      (expectedBoundary === undefined || command.boundary === expectedBoundary) &&
      (expectedIntent === undefined || command.intent === expectedIntent) &&
      (expectedOperation === undefined || command.operationId === expectedOperation) &&
      (expectedMethod === undefined || command.httpMethod.toUpperCase() === expectedMethod),
  };
  return ttlMs === undefined ? { rule } : { rule, ttlMs };
}
