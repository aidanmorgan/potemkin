/**
 * Patch vocabulary and atomic patch applier.
 *
 * Implements REQ-PATCH-001 (single patch vocabulary across reducers, response
 * mutations, seeds, and overlays) and REQ-PATCH-002 (build-new-state-then-swap
 * atomicity). RFC 6902 (add/remove/replace/move/copy) plus Potemkin extensions
 * (append/prepend/increment/merge/upsert).
 *
 * Path syntax follows RFC 6901 JSON Pointer:
 *   - `/`             → root
 *   - `/foo/bar`      → object property nesting
 *   - `/items/0`      → indexed array access
 *   - `/items/-`      → "end of array" (only for add/append/append-like)
 *   - `/a~1b/c~0d`    → escape `/` as `~1`, `~0` as `~0`
 */

import type { JsonValue } from '../types.js';

/** Source tag for journal entries — REQ-PATCH-004. */
export type PatchSource =
  | 'reducer'
  | 'seed'
  | 'hateoas'
  | 'mask'
  | 'deprecation'
  | 'overlay';

export type Patch =
  // RFC 6902
  | { op: 'add'; path: string; value: JsonValue }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: JsonValue }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string }
  // Potemkin extensions
  | { op: 'append'; path: string; value: JsonValue }
  | { op: 'prepend'; path: string; value: JsonValue }
  | { op: 'increment'; path: string; by: number }
  | { op: 'merge'; path: string; value: Record<string, JsonValue>; deep?: boolean }
  | { op: 'upsert'; path: string; key: string; value: Record<string, JsonValue> };

export interface JournalEntry {
  readonly source: PatchSource;
  readonly op: Patch['op'];
  readonly path: string;
  /** Echo of `value`/`from`/`by` for the op. Optional for `remove`. */
  readonly value?: JsonValue;
  readonly from?: string;
  readonly by?: number;
}

export interface ApplyResult {
  readonly newState: JsonValue;
  readonly journal: readonly JournalEntry[];
  /** Set of JSON-Pointer paths touched by any patch (for computed-field recompute). */
  readonly touchedPaths: ReadonlySet<string>;
}

export class PatchApplyError extends Error {
  constructor(
    message: string,
    public readonly patchIndex: number,
    public readonly path: string,
    public readonly op: Patch['op'],
  ) {
    super(message);
    this.name = 'PatchApplyError';
  }
}

/**
 * Parse RFC 6901 JSON Pointer into segments. Empty string is root → `[]`.
 * Throws on malformed pointers (must be empty or start with `/`).
 */
export function parsePointer(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return pointer === '' ? [] : [''];
  if (!pointer.startsWith('/')) {
    throw new Error(`Invalid JSON Pointer (must start with '/'): ${pointer}`);
  }
  return pointer
    .slice(1)
    .split('/')
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Convert segments back to RFC 6901 (mostly for error messages / journal). */
export function joinPointer(segments: readonly string[]): string {
  if (segments.length === 0) return '';
  return (
    '/' +
    segments
      .map((s) => s.replace(/~/g, '~0').replace(/\//g, '~1'))
      .join('/')
  );
}

/**
 * Deep-clone a JSON-compatible value. We assume valid JSON (no cycles, no
 * Dates, no functions) since state and patches come exclusively from
 * JSON-shaped sources (YAML literals, CEL evaluation results, HTTP bodies).
 */
function cloneJson<T extends JsonValue>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(cloneJson) as T;
  const out: Record<string, JsonValue> = {};
  for (const [k, val] of Object.entries(v as Record<string, JsonValue>)) {
    out[k] = cloneJson(val);
  }
  return out as T;
}

interface NavResult {
  readonly parent: Record<string, JsonValue> | JsonValue[];
  readonly key: string | number;
  /** True iff `key` already exists on `parent`. */
  readonly exists: boolean;
}

/**
 * Walk `state` to the parent of the leaf identified by `segments`. Returns
 * the parent container and the final key. Intermediate missing objects are
 * NOT auto-created — that is op-specific (handled by callers).
 */
function navigate(
  state: JsonValue,
  segments: readonly string[],
  op: Patch['op'],
  patchIndex: number,
): NavResult {
  if (segments.length === 0) {
    throw new PatchApplyError(
      `Operation '${op}' cannot target the root '/'`,
      patchIndex,
      '/',
      op,
    );
  }
  let cur: JsonValue = state;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (cur === null || typeof cur !== 'object') {
      throw new PatchApplyError(
        `Path traverses non-object/array at segment '${seg}' (depth ${i})`,
        patchIndex,
        joinPointer(segments),
        op,
      );
    }
    if (Array.isArray(cur)) {
      const idx = Number.parseInt(seg, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) {
        throw new PatchApplyError(
          `Array index out of range at segment '${seg}'`,
          patchIndex,
          joinPointer(segments),
          op,
        );
      }
      cur = cur[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
        throw new PatchApplyError(
          `Path traverses missing object key '${seg}'`,
          patchIndex,
          joinPointer(segments),
          op,
        );
      }
      cur = (cur as Record<string, JsonValue>)[seg];
    }
  }

  const leaf = segments[segments.length - 1];
  if (cur === null || typeof cur !== 'object') {
    throw new PatchApplyError(
      `Path traverses non-object/array at leaf '${leaf}'`,
      patchIndex,
      joinPointer(segments),
      op,
    );
  }
  if (Array.isArray(cur)) {
    if (leaf === '-') {
      return { parent: cur, key: cur.length, exists: false };
    }
    const idx = Number.parseInt(leaf, 10);
    if (!Number.isInteger(idx) || idx < 0) {
      throw new PatchApplyError(
        `Invalid array index '${leaf}'`,
        patchIndex,
        joinPointer(segments),
        op,
      );
    }
    return { parent: cur, key: idx, exists: idx < cur.length };
  }
  const exists = Object.prototype.hasOwnProperty.call(cur, leaf);
  return { parent: cur as Record<string, JsonValue>, key: leaf, exists };
}

function applyOne(
  state: JsonValue,
  patch: Patch,
  patchIndex: number,
): void {
  switch (patch.op) {
    case 'add':
    case 'replace': {
      const segments = parsePointer(patch.path);
      if (segments.length === 0) {
        // Replacing the root is a structural op — callers should handle by
        // assigning the new value. We can't replace `state` in-place; signal
        // via a thrown sentinel that callers cannot use root-replace. The
        // patch applier docs say root '/' is forbidden for these ops.
        throw new PatchApplyError(
          `'${patch.op}' on root '/' is not supported`,
          patchIndex,
          '/',
          patch.op,
        );
      }
      const { parent, key, exists } = navigate(state, segments, patch.op, patchIndex);
      if (patch.op === 'replace' && !exists) {
        throw new PatchApplyError(
          `'replace' target does not exist: ${patch.path}`,
          patchIndex,
          patch.path,
          patch.op,
        );
      }
      if (Array.isArray(parent)) {
        if (patch.op === 'add') {
          (parent as JsonValue[]).splice(key as number, 0, cloneJson(patch.value));
        } else {
          (parent as JsonValue[])[key as number] = cloneJson(patch.value);
        }
      } else {
        (parent as Record<string, JsonValue>)[key as string] = cloneJson(patch.value);
      }
      return;
    }
    case 'remove': {
      const segments = parsePointer(patch.path);
      const { parent, key, exists } = navigate(state, segments, patch.op, patchIndex);
      if (!exists) {
        throw new PatchApplyError(
          `'remove' target does not exist: ${patch.path}`,
          patchIndex,
          patch.path,
          patch.op,
        );
      }
      if (Array.isArray(parent)) {
        (parent as JsonValue[]).splice(key as number, 1);
      } else {
        delete (parent as Record<string, JsonValue>)[key as string];
      }
      return;
    }
    case 'move':
    case 'copy': {
      const fromSegs = parsePointer(patch.from);
      const toSegs = parsePointer(patch.path);
      const fromNav = navigate(state, fromSegs, patch.op, patchIndex);
      if (!fromNav.exists) {
        throw new PatchApplyError(
          `'${patch.op}' source does not exist: ${patch.from}`,
          patchIndex,
          patch.from,
          patch.op,
        );
      }
      const value = Array.isArray(fromNav.parent)
        ? (fromNav.parent as JsonValue[])[fromNav.key as number]
        : (fromNav.parent as Record<string, JsonValue>)[fromNav.key as string];
      const clonedValue = cloneJson(value);
      if (patch.op === 'move') {
        if (Array.isArray(fromNav.parent)) {
          (fromNav.parent as JsonValue[]).splice(fromNav.key as number, 1);
        } else {
          delete (fromNav.parent as Record<string, JsonValue>)[fromNav.key as string];
        }
      }
      const toNav = navigate(state, toSegs, patch.op, patchIndex);
      if (Array.isArray(toNav.parent)) {
        (toNav.parent as JsonValue[]).splice(toNav.key as number, 0, clonedValue);
      } else {
        (toNav.parent as Record<string, JsonValue>)[toNav.key as string] = clonedValue;
      }
      return;
    }
    case 'append':
    case 'prepend': {
      const segments = parsePointer(patch.path);
      const { parent, key, exists } = navigate(state, segments, patch.op, patchIndex);
      if (!exists) {
        throw new PatchApplyError(
          `'${patch.op}' target does not exist: ${patch.path}`,
          patchIndex,
          patch.path,
          patch.op,
        );
      }
      const target = Array.isArray(parent)
        ? (parent as JsonValue[])[key as number]
        : (parent as Record<string, JsonValue>)[key as string];
      if (!Array.isArray(target)) {
        throw new PatchApplyError(
          `'${patch.op}' target is not an array: ${patch.path}`,
          patchIndex,
          patch.path,
          patch.op,
        );
      }
      const cloned = cloneJson(patch.value);
      if (patch.op === 'append') target.push(cloned);
      else target.unshift(cloned);
      return;
    }
    case 'increment': {
      const segments = parsePointer(patch.path);
      const { parent, key, exists } = navigate(state, segments, patch.op, patchIndex);
      if (!exists) {
        throw new PatchApplyError(
          `'increment' target does not exist: ${patch.path}`,
          patchIndex,
          patch.path,
          patch.op,
        );
      }
      const current = Array.isArray(parent)
        ? (parent as JsonValue[])[key as number]
        : (parent as Record<string, JsonValue>)[key as string];
      if (typeof current !== 'number') {
        throw new PatchApplyError(
          `'increment' target is not numeric: ${patch.path}`,
          patchIndex,
          patch.path,
          patch.op,
        );
      }
      const updated = current + patch.by;
      if (Array.isArray(parent)) {
        (parent as JsonValue[])[key as number] = updated;
      } else {
        (parent as Record<string, JsonValue>)[key as string] = updated;
      }
      return;
    }
    case 'merge': {
      const segments = parsePointer(patch.path);
      const { parent, key, exists } = navigate(state, segments, patch.op, patchIndex);
      if (!exists) {
        throw new PatchApplyError(
          `'merge' target does not exist: ${patch.path}`,
          patchIndex,
          patch.path,
          patch.op,
        );
      }
      const target = Array.isArray(parent)
        ? (parent as JsonValue[])[key as number]
        : (parent as Record<string, JsonValue>)[key as string];
      if (target === null || typeof target !== 'object' || Array.isArray(target)) {
        throw new PatchApplyError(
          `'merge' target is not an object: ${patch.path}`,
          patchIndex,
          patch.path,
          patch.op,
        );
      }
      const obj = target as Record<string, JsonValue>;
      const update = cloneJson(patch.value);
      if (patch.deep) {
        deepMergeInPlace(obj, update);
      } else {
        for (const [k, v] of Object.entries(update)) obj[k] = v;
      }
      return;
    }
    case 'upsert': {
      const segments = parsePointer(patch.path);
      const { parent, key, exists } = navigate(state, segments, patch.op, patchIndex);
      if (!exists) {
        throw new PatchApplyError(
          `'upsert' target does not exist: ${patch.path}`,
          patchIndex,
          patch.path,
          patch.op,
        );
      }
      const target = Array.isArray(parent)
        ? (parent as JsonValue[])[key as number]
        : (parent as Record<string, JsonValue>)[key as string];
      if (!Array.isArray(target)) {
        throw new PatchApplyError(
          `'upsert' target is not an array: ${patch.path}`,
          patchIndex,
          patch.path,
          patch.op,
        );
      }
      const arr = target as JsonValue[];
      const keyField = patch.key;
      const incoming = cloneJson(patch.value);
      const matchValue = incoming[keyField];
      let idx = -1;
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        if (
          item !== null &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          (item as Record<string, JsonValue>)[keyField] === matchValue
        ) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        arr[idx] = incoming;
      } else {
        arr.push(incoming);
      }
      return;
    }
  }
}

function deepMergeInPlace(
  target: Record<string, JsonValue>,
  update: Record<string, JsonValue>,
): void {
  for (const [k, v] of Object.entries(update)) {
    const existing = target[k];
    if (
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      deepMergeInPlace(existing as Record<string, JsonValue>, v as Record<string, JsonValue>);
    } else {
      target[k] = v;
    }
  }
}

/**
 * Build-new-state-then-swap apply. Returns a fresh state object derived from
 * `state + patches`. The input `state` is NEVER mutated. On any patch failure,
 * throws `PatchApplyError` and the candidate state is discarded.
 *
 * REQ-PATCH-002: callers reassign the live StateGraph pointer ONLY on success.
 */
export function applyPatches(
  state: JsonValue,
  patches: readonly Patch[],
  source: PatchSource = 'reducer',
): ApplyResult {
  const candidate = cloneJson(state);
  const journal: JournalEntry[] = [];
  const touched = new Set<string>();
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    applyOne(candidate, p, i);
    journal.push(buildJournalEntry(p, source));
    touched.add(p.path);
    if (p.op === 'move' || p.op === 'copy') {
      touched.add(p.from);
    }
  }
  return { newState: candidate, journal, touchedPaths: touched };
}

function buildJournalEntry(p: Patch, source: PatchSource): JournalEntry {
  switch (p.op) {
    case 'remove':
      return { source, op: 'remove', path: p.path };
    case 'move':
    case 'copy':
      return { source, op: p.op, path: p.path, from: p.from };
    case 'increment':
      return { source, op: 'increment', path: p.path, by: p.by };
    default:
      return { source, op: p.op, path: p.path, value: p.value as JsonValue };
  }
}
