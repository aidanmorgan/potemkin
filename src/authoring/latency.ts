const LATENCY_FIELDS = ['fixedMs', 'minMs', 'maxMs'] as const;

export type AuthoringLatencyField = (typeof LATENCY_FIELDS)[number];

export function authoringLatencyProblem(
  value: unknown,
): { readonly field?: AuthoringLatencyField; readonly message: string } | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { message: 'latency must be an object' };
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
      (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue) || fieldValue < 0)
    ) {
      return { field, message: `latency.${field} must be a finite non-negative number` };
    }
  }
  const min = object.minMs as number | undefined;
  const max = object.maxMs as number | undefined;
  return min !== undefined && max !== undefined && max < min
    ? { message: 'latency.maxMs must be greater than or equal to latency.minMs' }
    : undefined;
}
