import { isRecord } from './value.js';

const LATENCY_FIELDS = ['fixedMs', 'minMs', 'maxMs'] as const;
const LATENCY_FIELD_SET: ReadonlySet<string> = new Set(LATENCY_FIELDS);

export type LatencyField = (typeof LATENCY_FIELDS)[number];

export function latencyProblem(
  value: unknown,
): { readonly field?: LatencyField; readonly message: string } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return { message: 'latency must be an object' };

  const unknownField = Object.keys(value).find((field) => !LATENCY_FIELD_SET.has(field));
  if (unknownField !== undefined) {
    return { message: `latency contains unknown field "${unknownField}"` };
  }

  for (const field of LATENCY_FIELDS) {
    const fieldValue = value[field];
    if (
      fieldValue !== undefined &&
      (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue) || fieldValue < 0)
    ) {
      return {
        field,
        message: `latency.${field} must be a finite non-negative number`,
      };
    }
  }

  const min = typeof value.minMs === 'number' ? value.minMs : undefined;
  const max = typeof value.maxMs === 'number' ? value.maxMs : undefined;
  return min !== undefined && max !== undefined && max < min
    ? { message: 'latency.maxMs must be greater than or equal to latency.minMs' }
    : undefined;
}
