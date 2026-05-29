// Hash a DSL bundle into a deterministic specVersion: sort modules by path,
// SHA-256 each yaml as raw utf-8 bytes, concatenate the digests in order,
// SHA-256 the concatenation. No YAML parsing — byte-identical inputs in
// any order collide; whitespace/comment edits produce different hashes.

import { createHash } from 'node:crypto';

export interface DslModuleBytes {
  readonly path: string;
  readonly yaml: string;
}

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
