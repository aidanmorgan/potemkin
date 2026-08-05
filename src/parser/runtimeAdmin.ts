import type { FaultRule } from '../dsl/types.js';
import { RuntimeExecutionError } from '../core/errors.js';
import type { RuntimeFault } from '../model/runtime.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import { compileYamlFaultRule } from './yamlCompiler.js';

export interface RuntimeFaultRegistrationInput {
  readonly rule: RuntimeFault;
  readonly ttlMs?: number;
}

export interface RuntimeFaultRegistrationOptions {
  readonly nowMs: number;
  readonly cel: CelEvaluator;
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
  if (!recordValue(value) || !recordValue(value.match) || !recordValue(value.response)) {
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
  const rule = {
    name,
    match: { ...value.match, condition },
    response: { ...response },
    ...(delayMs === undefined ? {} : { delay_ms: delayMs }),
  } as unknown as FaultRule;

  const ttlMs = ttlMilliseconds(value, options.nowMs);
  const compiled = compileYamlFaultRule(rule, { cel: options.cel });
  return ttlMs === undefined ? { rule: compiled } : { rule: compiled, ttlMs };
}
