/**
 * Shared header-AND-match helper used by both the behavior pattern matcher
 * and the fault rule evaluator.
 *
 * Semantics:
 *  - Header name lookup is case-insensitive: the declared name is lowercased
 *    before lookup because the actual headers map uses lowercased keys.
 *  - Both '*' and 'present' are treated as any-value sentinels (presence-only check).
 *  - AND semantics: ALL declared headers must match; a missing header or value
 *    mismatch returns false immediately.
 */
export function matchHeadersAnd(
  declared: Record<string, string>,
  actual: Record<string, string>,
): boolean {
  for (const [name, expected] of Object.entries(declared)) {
    const actualValue = actual[name.toLowerCase()];
    if (actualValue === undefined) return false;
    if (expected !== 'present' && expected !== '*' && actualValue !== expected) return false;
  }
  return true;
}
