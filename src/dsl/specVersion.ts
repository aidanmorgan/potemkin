/**
 * Deterministic canonicalization of a DSL bundle into a single SHA-256
 * `specVersion` string.
 *
 * REQ-WIRE-002: For each module in `modules[]` sorted by `path` ascending,
 * compute `SHA-256(yaml raw bytes)`; concatenate the per-file hashes in sorted
 * order; the bundle's `specVersion` is `SHA-256(concatenated hashes)`.
 *
 * Byte-identical inputs in any order collide; whitespace/comment edits
 * produce different hashes (no YAML parsing or normalization).
 */

import { createHash } from 'node:crypto';

export interface DslModuleBytes {
  readonly path: string;
  readonly yaml: string;
}

/**
 * Compute the canonical `specVersion` hash for a DSL bundle.
 *
 * - Modules are sorted by `path` ascending.
 * - The per-file hash is `SHA-256(utf-8 raw bytes of yaml)`.
 * - The final hash is `SHA-256(concatenation of per-file hashes in order)`.
 *
 * The return is a lowercase hex string without prefix.
 */
export function computeSpecVersion(modules: readonly DslModuleBytes[]): string {
  const sorted = [...modules].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const outer = createHash('sha256');
  for (const m of sorted) {
    const inner = createHash('sha256');
    inner.update(m.yaml, 'utf8');
    outer.update(inner.digest());
  }
  return outer.digest('hex');
}
