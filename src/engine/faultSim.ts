import type { JsonValue } from '../types.js';

export interface FaultSignal {
  readonly status: number;
  readonly body: JsonValue;
  readonly headers?: Record<string, string>;
}

/**
 * Inspect request headers for a fault-simulation directive.
 *
 * Convention: the header `x-specmatic-fault` carries a JSON-encoded object
 * with shape `{ status: number, body: JsonValue, headers?: Record<string,string> }`.
 *
 * Returns null if the header is absent or malformed (no fault should be injected).
 */
export function extractFaultSignal(
  headers: Record<string, string | string[] | undefined>,
): FaultSignal | null {
  throw new Error('NotImplemented: engine/faultSim.extractFaultSignal');
}
