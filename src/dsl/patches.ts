// RFC 6902 patch operations plus Potemkin extensions (append/prepend/increment/merge/upsert).
// Paths are RFC 6901 JSON Pointers; `/items/-` is the array-end sentinel for add/append.

import type { JsonValue } from '../types.js';

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

/** True when a path segment is an array index or the `-` end sentinel. */
function segmentIsArrayIndex(seg: string | undefined): boolean {
  if (seg === undefined) return false;
  if (seg === '-') return true;
  const idx = Number.parseInt(seg, 10);
  return Number.isInteger(idx) && String(idx) === seg && idx >= 0;
}

/**
 * Walk `state` to the parent of the leaf identified by `segments`.
 * In strict mode intermediate missing keys are not created (ops handle that).
 * When `autoVivify` is set, missing intermediate containers are created:
 * a numeric next-segment yields an array, anything else an object.
 */
function navigate(
  state: JsonValue,
  segments: readonly string[],
  op: Patch['op'],
  patchIndex: number,
  autoVivify: boolean,
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
        if (autoVivify && Number.isInteger(idx) && idx >= 0) {
          cur[idx] = segmentIsArrayIndex(segments[i + 1]) ? [] : {};
        } else {
          throw new PatchApplyError(
            `Array index out of range at segment '${seg}'`,
            patchIndex,
            joinPointer(segments),
            op,
          );
        }
      }
      cur = cur[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
        if (autoVivify) {
          (cur as Record<string, JsonValue>)[seg] = segmentIsArrayIndex(segments[i + 1]) ? [] : {};
        } else {
          throw new PatchApplyError(
            `Path traverses missing object key '${seg}'`,
            patchIndex,
            joinPointer(segments),
            op,
          );
        }
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

/** Read the value currently stored at `parent[key]`. */
function readAt(parent: Record<string, JsonValue> | JsonValue[], key: string | number): JsonValue | undefined {
  return Array.isArray(parent)
    ? (parent as JsonValue[])[key as number]
    : (parent as Record<string, JsonValue>)[key as string];
}

/** Write `value` at `parent[key]`. For arrays, index === length appends. */
function writeAt(parent: Record<string, JsonValue> | JsonValue[], key: string | number, value: JsonValue): void {
  if (Array.isArray(parent)) {
    (parent as JsonValue[])[key as number] = value;
  } else {
    (parent as Record<string, JsonValue>)[key as string] = value;
  }
}

function applyOne(
  state: JsonValue,
  patch: Patch,
  patchIndex: number,
  autoVivify: boolean,
): void {
  switch (patch.op) {
    case 'add':
    case 'replace': {
      const segments = parsePointer(patch.path);
      if (segments.length === 0) {
          throw new PatchApplyError(
          `'${patch.op}' on root '/' is not supported`,
          patchIndex,
          '/',
          patch.op,
        );
      }
      const { parent, key, exists } = navigate(state, segments, patch.op, patchIndex, autoVivify);
      // In autoVivify mode, `replace` upserts — a missing target is created.
      if (patch.op === 'replace' && !exists && !autoVivify) {
        throw new PatchApplyError(
          `'replace' target does not exist: ${patch.path}`,
          patchIndex,
          patch.path,
          patch.op,
        );
      }
      if (Array.isArray(parent)) {
        if (patch.op === 'add' && exists) {
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
      const { parent, key, exists } = navigate(state, segments, patch.op, patchIndex, autoVivify);
      if (!exists) {
        // Under autoVivify (reducer) removing a non-existent path is a no-op;
        // under strict RFC 6902 it is an error.
        if (autoVivify) return;
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
      const fromNav = navigate(state, fromSegs, patch.op, patchIndex, autoVivify);
      if (!fromNav.exists) {
        throw new PatchApplyError(
          `'${patch.op}' source does not exist: ${patch.from}`,
          patchIndex,
          patch.from,
          patch.op,
        );
      }
      const value = readAt(fromNav.parent, fromNav.key);
      const clonedValue = cloneJson(value as JsonValue);
      if (patch.op === 'move') {
        if (Array.isArray(fromNav.parent)) {
          (fromNav.parent as JsonValue[]).splice(fromNav.key as number, 1);
        } else {
          delete (fromNav.parent as Record<string, JsonValue>)[fromNav.key as string];
        }
      }
      const toNav = navigate(state, toSegs, patch.op, patchIndex, autoVivify);
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
      const { parent, key, exists } = navigate(state, segments, patch.op, patchIndex, autoVivify);
      let target = exists ? readAt(parent, key) : undefined;
      if (!Array.isArray(target)) {
        if (!autoVivify) {
          throw new PatchApplyError(
            exists
              ? `'${patch.op}' target is not an array: ${patch.path}`
              : `'${patch.op}' target does not exist: ${patch.path}`,
            patchIndex,
            patch.path,
            patch.op,
          );
        }
        target = []; // autoVivify: missing/non-array becomes a fresh array
        writeAt(parent, key, target);
      }
      const cloned = cloneJson(patch.value);
      if (patch.op === 'append') (target as JsonValue[]).push(cloned);
      else (target as JsonValue[]).unshift(cloned);
      return;
    }
    case 'increment': {
      const segments = parsePointer(patch.path);
      const { parent, key, exists } = navigate(state, segments, patch.op, patchIndex, autoVivify);
      const current = exists ? readAt(parent, key) : undefined;
      if (typeof current !== 'number') {
        if (!autoVivify) {
          throw new PatchApplyError(
            exists
              ? `'increment' target is not numeric: ${patch.path}`
              : `'increment' target does not exist: ${patch.path}`,
            patchIndex,
            patch.path,
            patch.op,
          );
        }
        writeAt(parent, key, patch.by); // autoVivify: missing/non-numeric target starts at 0
        return;
      }
      writeAt(parent, key, current + patch.by);
      return;
    }
    case 'merge': {
      const segments = parsePointer(patch.path);
      const { parent, key, exists } = navigate(state, segments, patch.op, patchIndex, autoVivify);
      let target = exists ? readAt(parent, key) : undefined;
      if (target === null || typeof target !== 'object' || Array.isArray(target)) {
        if (!autoVivify) {
          throw new PatchApplyError(
            exists
              ? `'merge' target is not an object: ${patch.path}`
              : `'merge' target does not exist: ${patch.path}`,
            patchIndex,
            patch.path,
            patch.op,
          );
        }
        target = {}; // autoVivify: missing/non-object target becomes a fresh object
        writeAt(parent, key, target);
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
      const { parent, key, exists } = navigate(state, segments, patch.op, patchIndex, autoVivify);
      let target = exists ? readAt(parent, key) : undefined;
      if (!Array.isArray(target)) {
        if (!autoVivify) {
          throw new PatchApplyError(
            exists
              ? `'upsert' target is not an array: ${patch.path}`
              : `'upsert' target does not exist: ${patch.path}`,
            patchIndex,
            patch.path,
            patch.op,
          );
        }
        target = []; // autoVivify: missing/non-array target becomes a fresh array
        writeAt(parent, key, target);
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

export interface ApplyPatchesOptions {
  /**
   * Auto-vivify missing containers and coerce wrong-typed targets instead of
   * throwing. Used by the reducer source, whose patches build entity state
   * from an empty buffer: `replace` upserts, `append`/`prepend` create a fresh
   * array, `increment` starts at 0, `merge` creates a fresh object, `upsert`
   * creates a fresh array, `remove` on a missing target is a no-op. Strict RFC
   * 6902 semantics (the default) reject all of these.
   */
  readonly autoVivify?: boolean;
}

// Returns a fresh state with patches applied; never mutates the input.
// Throws PatchApplyError on the first failed op so callers retain the original.
export function applyPatches(
  state: JsonValue,
  patches: readonly Patch[],
  source: PatchSource = 'reducer',
  opts: ApplyPatchesOptions = {},
): ApplyResult {
  const autoVivify = opts.autoVivify ?? false;
  const candidate = cloneJson(state);
  const journal: JournalEntry[] = [];
  const touched = new Set<string>();
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    applyOne(candidate, p, i, autoVivify);
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
