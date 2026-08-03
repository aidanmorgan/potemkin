import type { RuntimeLatency } from "./runtime.js";

const LATENCY_FIELDS = ["fixedMs", "minMs", "maxMs"] as const;

export type RuntimeLatencyField = (typeof LATENCY_FIELDS)[number];

/** Return a stable diagnostic for malformed source-neutral latency input. */
export function runtimeLatencyProblem(
  value: unknown,
): { readonly field?: RuntimeLatencyField; readonly message: string } | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { message: "latency must be an object" };
  }

  const object = value as Record<string, unknown>;
  const unknownField = Object.keys(object).find(
    (field) => !(LATENCY_FIELDS as readonly string[]).includes(field),
  );
  if (unknownField !== undefined) {
    return { message: `latency contains unknown field "${unknownField}"` };
  }

  for (const field of LATENCY_FIELDS) {
    const fieldValue = object[field];
    if (
      fieldValue !== undefined &&
      (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0)
    ) {
      return {
        field,
        message: `latency.${field} must be a finite non-negative number`,
      };
    }
  }

  const min = object.minMs as number | undefined;
  const max = object.maxMs as number | undefined;
  if (min !== undefined && max !== undefined && max < min) {
    return { message: "latency.maxMs must be greater than or equal to latency.minMs" };
  }
  return undefined;
}

export function isValidRuntimeLatency(value: unknown): value is RuntimeLatency {
  return runtimeLatencyProblem(value) === undefined;
}
