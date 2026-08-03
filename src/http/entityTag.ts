/**
 * Normalize an HTTP entity tag to the numeric version used by the runtime
 * concurrency model. HTTP clients and Specmatic may preserve one or more
 * layers of quoting around the wire value; the runtime accepts the standard
 * quoted form and weak prefix while keeping malformed values invalid.
 */
export function normalizeEntityTag(value: string): string {
  let normalized = value.trim();
  if (normalized.startsWith("W/")) normalized = normalized.slice(2).trim();
  while (normalized.length >= 2 && normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

export function parseEntityTagVersion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeEntityTag(value);
  if (!/^[0-9]+$/.test(normalized)) return Number.NaN;
  const version = Number(normalized);
  return Number.isSafeInteger(version) ? version : Number.NaN;
}
