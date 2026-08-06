import type { RuntimeLatency } from './runtime.js';
import { latencyProblem, type LatencyField } from '../contracts/latency.js';

export type RuntimeLatencyField = LatencyField;

export function runtimeLatencyProblem(
  value: unknown,
): { readonly field?: RuntimeLatencyField; readonly message: string } | undefined {
  return latencyProblem(value);
}

export function isValidRuntimeLatency(value: unknown): value is RuntimeLatency {
  return runtimeLatencyProblem(value) === undefined;
}
