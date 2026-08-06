import type { FaultRule, RequiresGuard } from '../dsl/types.js';
import { RuntimeExecutionError } from '../core/errors.js';
import type { RuntimeFault } from '../model/runtime.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { Intent } from '../contracts/domain.js';
import { isJsonValue, isRecord } from '../contracts/value.js';
import { compileYamlFaultRule } from './yamlCompiler.js';

export interface RuntimeFaultRegistrationInput {
  readonly rule: RuntimeFault;
  readonly ttlMs?: number;
}

export interface RuntimeFaultRegistrationOptions {
  readonly nowMs: number;
  readonly cel: CelEvaluator;
}

function invalidFault(message: string): never {
  throw new RuntimeExecutionError(400, 'Invalid fault rule', {
    code: 'INVALID_FAULT_RULE',
    message,
  });
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalidFault(`${field} must be a string`);
  return value;
}

function optionalIntent(value: unknown): Intent | undefined {
  if (value === undefined) return undefined;
  if (value === 'creation' || value === 'mutation' || value === 'query') return value;
  invalidFault('match.intent must be creation, mutation, or query');
}

function optionalStringMap(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalidFault(`${field} must be an object of strings`);
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== 'string')) {
    invalidFault(`${field} must be an object of strings`);
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (typeof entry !== 'string') invalidFault(`${field} must be an object of strings`);
    result[key] = entry;
  }
  return result;
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) invalidFault(`${field} must be an array of strings`);
  return value.map((entry) => {
    if (typeof entry !== 'string') invalidFault(`${field} must be an array of strings`);
    return entry;
  });
}

function optionalRequires(value: unknown): readonly RequiresGuard<never, 'fault'>[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) invalidFault('match.requires must be an array');
  return value.map((entry, index) => {
    if (!isRecord(entry)) invalidFault(`match.requires[${index}] must be an object`);
    const name = optionalString(entry.name, `match.requires[${index}].name`);
    const condition = optionalString(entry.condition, `match.requires[${index}].condition`);
    const errorCode = optionalString(entry.errorCode, `match.requires[${index}].errorCode`);
    const errorMessage = optionalString(
      entry.errorMessage,
      `match.requires[${index}].errorMessage`,
    );
    if (
      name === undefined ||
      condition === undefined ||
      errorCode === undefined ||
      errorMessage === undefined
    ) {
      invalidFault(
        `match.requires[${index}] requires name, condition, errorCode, and errorMessage`,
      );
    }
    const errorStatus = entry.errorStatus;
    if (errorStatus !== undefined && typeof errorStatus !== 'number') {
      invalidFault(`match.requires[${index}].errorStatus must be a number`);
    }
    return {
      name,
      condition,
      errorCode,
      errorMessage,
      ...(errorStatus === undefined ? {} : { errorStatus }),
    };
  });
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

/**
 * Parse the JSON admin wire form at the parser boundary. The engine receives
 * only a typed RuntimeFault; it never sees YAML field names or CEL source.
 */
export function parseRuntimeFaultRegistration(
  value: unknown,
  options: RuntimeFaultRegistrationOptions,
): RuntimeFaultRegistrationInput {
  if (!isRecord(value) || !isRecord(value.match) || !isRecord(value.response)) {
    throw new RuntimeExecutionError(400, 'Invalid fault rule', {
      code: 'INVALID_FAULT_RULE',
      message: 'A fault rule requires `match` and `response` objects',
    });
  }

  const response = value.response;
  const status = response.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new RuntimeExecutionError(400, 'Invalid fault response status', {
      code: 'INVALID_FAULT_RULE',
      message: 'Fault response status must be an integer between 100 and 599',
    });
  }

  const condition = typeof value.match.condition === 'string' ? value.match.condition : 'true';
  const name =
    typeof value.name === 'string' && value.name.trim() !== '' ? value.name : 'dynamic-fault';
  const responseDelay = response.delay_ms;
  const delayMs =
    typeof value.delay_ms === 'number' && Number.isFinite(value.delay_ms) && value.delay_ms >= 0
      ? value.delay_ms
      : typeof responseDelay === 'number' && Number.isFinite(responseDelay) && responseDelay >= 0
        ? responseDelay
        : undefined;
  const body = response.body;
  if (body !== undefined && !isJsonValue(body)) {
    invalidFault('response.body must be valid JSON');
  }
  const responseHeaders = optionalStringMap(response.headers, 'response.headers');
  const boundary = optionalString(value.match.boundary, 'match.boundary');
  const intent = optionalIntent(value.match.intent);
  const operationId = optionalString(value.match.operationId, 'match.operationId');
  const method = optionalString(value.match.method, 'match.method');
  const headers = optionalStringMap(value.match.headers, 'match.headers');
  const requires = optionalRequires(value.match.requires);
  const requiredScopes = optionalStringArray(value.match.requiredScopes, 'match.requiredScopes');
  const potemkin = optionalStringMap(value.match.potemkin, 'match.potemkin');
  const match: FaultRule['match'] = {
    condition,
    ...(boundary === undefined ? {} : { boundary }),
    ...(intent === undefined ? {} : { intent }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(method === undefined ? {} : { method }),
    ...(headers === undefined ? {} : { headers }),
    ...(requires === undefined ? {} : { requires }),
    ...(requiredScopes === undefined ? {} : { requiredScopes }),
    ...(value.match.probability === undefined
      ? {}
      : typeof value.match.probability === 'number' && Number.isFinite(value.match.probability)
        ? { probability: value.match.probability }
        : invalidFault('match.probability must be a finite number')),
    ...(potemkin === undefined ? {} : { potemkin }),
  };
  const rule: FaultRule = {
    name,
    match,
    response: {
      status,
      ...(body === undefined ? {} : { body }),
      ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
    },
    ...(delayMs === undefined ? {} : { delay_ms: delayMs }),
  };

  const ttlMs = ttlMilliseconds(value, options.nowMs);
  const compiled = compileYamlFaultRule(rule, { cel: options.cel });
  return ttlMs === undefined ? { rule: compiled } : { rule: compiled, ttlMs };
}
