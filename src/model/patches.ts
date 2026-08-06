// RFC 6902 patch operations plus Potemkin extensions (append/prepend/increment/merge/upsert).
// Paths are RFC 6901 JSON Pointers; `/items/-` is the array-end sentinel for add/append.

import { isJsonObject, PatchOperation, PatchSource } from '../contracts/value.js';
import type {
  JsonObject,
  JsonScalar,
  JsonValue,
  Patch,
  PatchSource as PatchSourceValue,
} from '../contracts/value.js';
import { jsonPath } from '../domain/references.js';

type MutableJsonObject = { [key: string]: MutableJsonValue };
type MutableJsonArray = MutableJsonValue[];
type MutableJsonValue = JsonScalar | MutableJsonArray | MutableJsonObject;

export interface JournalEntry {
  readonly source: PatchSourceValue;
  readonly op: Patch['op'];
  readonly path: string;
  /** Echo of `value`/`from`/`by` for the op. Optional for `remove`. */
  readonly value?: JsonValue;
  readonly from?: string;
  readonly by?: number;
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => {
      const rightValue = right.at(index);
      return rightValue !== undefined && sameJson(value, rightValue);
    });
  }
  if (!isJsonObject(left) || !isJsonObject(right)) return false;
  const leftObject = left;
  const rightObject = right;
  const leftKeys = Object.keys(leftObject);
  const rightKeys = Object.keys(rightObject);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightObject, key) &&
        sameJson(leftObject[key], rightObject[key]),
    )
  );
}

function sameContainerKind(left: JsonValue, right: JsonValue): boolean {
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right);
  if (left !== null && typeof left === 'object')
    return right !== null && typeof right === 'object' && !Array.isArray(right);
  return right === null || typeof right !== 'object';
}

function diffJsonValues(
  before: JsonValue,
  after: JsonValue,
  path: string,
  source: PatchSourceValue,
  journal: JournalEntry[],
): void {
  if (sameJson(before, after)) return;
  if (!sameContainerKind(before, after)) {
    if (path !== '') journal.push({ source, op: PatchOperation.Replace, path, value: after });
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const commonLength = Math.min(before.length, after.length);
    for (let index = 0; index < commonLength; index += 1) {
      const beforeValue = before.at(index);
      const afterValue = after.at(index);
      if (beforeValue === undefined || afterValue === undefined) continue;
      diffJsonValues(beforeValue, afterValue, `${path}/${index}`, source, journal);
    }
    for (let index = before.length - 1; index >= after.length; index -= 1)
      journal.push({ source, op: PatchOperation.Remove, path: `${path}/${index}` });
    for (let index = commonLength; index < after.length; index += 1) {
      const value = after.at(index);
      if (value !== undefined)
        journal.push({ source, op: PatchOperation.Add, path: `${path}/${index}`, value });
    }
    return;
  }
  if (isJsonObject(before) && isJsonObject(after)) {
    const beforeObject = before;
    const afterObject = after;
    for (const key of Object.keys(beforeObject)) {
      if (!Object.prototype.hasOwnProperty.call(afterObject, key))
        journal.push({
          source,
          op: PatchOperation.Remove,
          path: `${path}/${escapePointerSegment(key)}`,
        });
    }
    for (const key of Object.keys(afterObject)) {
      const childPath = `${path}/${escapePointerSegment(key)}`;
      if (!Object.prototype.hasOwnProperty.call(beforeObject, key))
        journal.push({ source, op: PatchOperation.Add, path: childPath, value: afterObject[key] });
      else diffJsonValues(beforeObject[key], afterObject[key], childPath, source, journal);
    }
    return;
  }
  if (path !== '') journal.push({ source, op: PatchOperation.Replace, path, value: after });
}

/**
 * Create a strict RFC-6902-compatible journal for two equivalent-root JSON
 * documents. A root type change cannot be represented by the Specmatic
 * forwarding patch contract, so it returns undefined and callers must carry
 * the already-shaped document instead.
 */
export function diffJsonJournal(
  before: JsonValue,
  after: JsonValue,
  source: PatchSourceValue = PatchSource.Overlay,
): readonly JournalEntry[] | undefined {
  if (!sameContainerKind(before, after)) return undefined;
  const journal: JournalEntry[] = [];
  diffJsonValues(before, after, '', source, journal);
  return journal;
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
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

export class JsonPointerError extends Error {
  readonly code = 'MODEL_INVALID_JSON_POINTER' as const;

  constructor(public readonly pointer: string) {
    super(`Invalid JSON Pointer (must start with '/'): ${pointer}`);
    this.name = 'JsonPointerError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Parse RFC 6901 JSON Pointer into segments. Empty string is root → `[]`.
 * Throws on malformed pointers (must be empty or start with `/`).
 */
export function parsePointer(pointer: string): string[] {
  if (pointer !== '' && !pointer.trim().startsWith('/')) {
    throw new JsonPointerError(pointer);
  }
  const validated = jsonPath(pointer);
  if (validated === '' || validated === '/') return validated === '' ? [] : [''];
  if (!validated.startsWith('/')) {
    throw new JsonPointerError(validated);
  }
  return validated
    .slice(1)
    .split('/')
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Convert segments back to RFC 6901 (mostly for error messages / journal). */
export function joinPointer(segments: readonly string[]): string {
  if (segments.length === 0) return '';
  return '/' + segments.map((s) => s.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

/**
 * Clone a JSON value into a mutable tree. The public JSON contract exposes
 * arrays as readonly, while patch application necessarily mutates its private
 * candidate tree. Keeping that distinction local avoids assertions around
 * every array write and guarantees that the caller's input remains untouched.
 */
function cloneJson(value: JsonValue): MutableJsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => cloneJson(entry));

  const clone: MutableJsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: cloneJson(entry),
      writable: true,
    });
  }
  return clone;
}

interface ArrayNavigation {
  readonly kind: 'array';
  readonly parent: MutableJsonArray;
  readonly key: number;
  readonly exists: boolean;
}

interface ObjectNavigation {
  readonly kind: 'object';
  readonly parent: MutableJsonObject;
  readonly key: string;
  readonly exists: boolean;
}

type NavResult = ArrayNavigation | ObjectNavigation;

interface NavigationOptions {
  readonly op: Patch['op'];
  readonly patchIndex: number;
  readonly autoVivify: boolean;
}

/** True for the mutable object branch of a cloned JSON value. */
function isMutableJsonObject(value: unknown): value is MutableJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read the value currently stored at a navigation result. */
function readAt(navigation: NavResult): MutableJsonValue | undefined {
  return navigation.kind === 'array'
    ? navigation.parent[navigation.key]
    : navigation.parent[navigation.key];
}

/** Replace or create a value at a navigation result. */
function writeAt(navigation: NavResult, value: MutableJsonValue): void {
  if (navigation.kind === 'array') navigation.parent[navigation.key] = value;
  else navigation.parent[navigation.key] = value;
}

/** Insert an array value, or assign an object property. */
function insertAt(navigation: NavResult, value: MutableJsonValue): void {
  if (navigation.kind === 'array') navigation.parent.splice(navigation.key, 0, value);
  else navigation.parent[navigation.key] = value;
}

/** Remove a value from an array or object. */
function removeAt(navigation: NavResult): void {
  if (navigation.kind === 'array') navigation.parent.splice(navigation.key, 1);
  else delete navigation.parent[navigation.key];
}

/** True when a path segment names an array index or the `-` end sentinel. */
function segmentIsArrayIndex(segment: string | undefined): boolean {
  if (segment === undefined || segment === '-') return segment === '-';
  const index = Number.parseInt(segment, 10);
  return Number.isInteger(index) && String(index) === segment && index >= 0;
}

/**
 * Walk `state` to the parent of the leaf identified by `segments`.
 * In strict mode intermediate missing keys are not created (ops handle that).
 * When `autoVivify` is set, missing intermediate containers are created:
 * a numeric next-segment yields an array, anything else an object.
 */
function navigate(
  state: MutableJsonValue,
  segments: readonly string[],
  { op, patchIndex, autoVivify }: NavigationOptions,
): NavResult {
  if (segments.length === 0) {
    throw new PatchApplyError(`Operation '${op}' cannot target the root '/'`, patchIndex, '/', op);
  }
  let current: MutableJsonValue = state;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (current === null || typeof current !== 'object') {
      throw new PatchApplyError(
        `Path traverses non-object/array at segment '${segment}' (depth ${i})`,
        patchIndex,
        joinPointer(segments),
        op,
      );
    }
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        if (autoVivify && Number.isInteger(index) && index >= 0) {
          current[index] = segmentIsArrayIndex(segments[i + 1]) ? [] : {};
        } else {
          throw new PatchApplyError(
            `Array index out of range at segment '${segment}'`,
            patchIndex,
            joinPointer(segments),
            op,
          );
        }
      }
      current = current[index];
      continue;
    }

    if (!isMutableJsonObject(current)) {
      throw new PatchApplyError(
        `Path traverses non-object/array at segment '${segment}' (depth ${i})`,
        patchIndex,
        joinPointer(segments),
        op,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      if (autoVivify) {
        current[segment] = segmentIsArrayIndex(segments[i + 1]) ? [] : {};
      } else {
        throw new PatchApplyError(
          `Path traverses missing object key '${segment}'`,
          patchIndex,
          joinPointer(segments),
          op,
        );
      }
    }
    current = current[segment];
  }

  const leaf = segments[segments.length - 1];
  if (current === null || typeof current !== 'object') {
    throw new PatchApplyError(
      `Path traverses non-object/array at leaf '${leaf}'`,
      patchIndex,
      joinPointer(segments),
      op,
    );
  }
  if (Array.isArray(current)) {
    if (leaf === '-') return { kind: 'array', parent: current, key: current.length, exists: false };
    const index = Number.parseInt(leaf, 10);
    if (!Number.isInteger(index) || index < 0) {
      throw new PatchApplyError(
        `Invalid array index '${leaf}'`,
        patchIndex,
        joinPointer(segments),
        op,
      );
    }
    return { kind: 'array', parent: current, key: index, exists: index < current.length };
  }
  if (!isMutableJsonObject(current)) {
    throw new PatchApplyError(
      `Path traverses non-object/array at leaf '${leaf}'`,
      patchIndex,
      joinPointer(segments),
      op,
    );
  }
  return {
    kind: 'object',
    parent: current,
    key: leaf,
    exists: Object.prototype.hasOwnProperty.call(current, leaf),
  };
}

/*
 * The navigation result is deliberately discriminated instead of exposing a
 * `string | number` key. This keeps array mutation APIs and object property
 * APIs type-safe without assertions at every patch operation.
 */
function applyOne(
  state: MutableJsonValue,
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
      const navigation = navigate(state, segments, {
        op: patch.op,
        patchIndex,
        autoVivify,
      });
      // In autoVivify mode, `replace` upserts — a missing target is created.
      if (patch.op === 'replace' && !navigation.exists && !autoVivify) {
        throw new PatchApplyError(
          `'replace' target does not exist: ${patch.path}`,
          patchIndex,
          patch.path,
          patch.op,
        );
      }
      if (patch.op === 'add' && navigation.kind === 'array' && navigation.exists) {
        navigation.parent.splice(navigation.key, 0, cloneJson(patch.value));
      } else {
        writeAt(navigation, cloneJson(patch.value));
      }
      return;
    }
    case 'remove': {
      const segments = parsePointer(patch.path);
      const navigation = navigate(state, segments, {
        op: patch.op,
        patchIndex,
        autoVivify,
      });
      if (!navigation.exists) {
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
      removeAt(navigation);
      return;
    }
    case 'move':
    case 'copy': {
      const fromSegs = parsePointer(patch.from);
      const toSegs = parsePointer(patch.path);
      const fromNavigation = navigate(state, fromSegs, {
        op: patch.op,
        patchIndex,
        autoVivify,
      });
      if (!fromNavigation.exists) {
        throw new PatchApplyError(
          `'${patch.op}' source does not exist: ${patch.from}`,
          patchIndex,
          patch.from,
          patch.op,
        );
      }
      const value = readAt(fromNavigation);
      if (value === undefined) {
        throw new PatchApplyError(
          `'${patch.op}' source does not contain a JSON value: ${patch.from}`,
          patchIndex,
          patch.from,
          patch.op,
        );
      }
      const clonedValue = cloneJson(value);
      if (patch.op === 'move') {
        removeAt(fromNavigation);
      }
      const toNavigation = navigate(state, toSegs, {
        op: patch.op,
        patchIndex,
        autoVivify,
      });
      insertAt(toNavigation, clonedValue);
      return;
    }
    case 'append':
    case 'prepend': {
      const segments = parsePointer(patch.path);
      const navigation = navigate(state, segments, {
        op: patch.op,
        patchIndex,
        autoVivify,
      });
      let target = navigation.exists ? readAt(navigation) : undefined;
      if (!Array.isArray(target)) {
        if (!autoVivify) {
          throw new PatchApplyError(
            navigation.exists
              ? `'${patch.op}' target is not an array: ${patch.path}`
              : `'${patch.op}' target does not exist: ${patch.path}`,
            patchIndex,
            patch.path,
            patch.op,
          );
        }
        target = []; // autoVivify: missing/non-array becomes a fresh array
        writeAt(navigation, target);
      }
      const cloned = cloneJson(patch.value);
      if (patch.op === 'append') target.push(cloned);
      else target.unshift(cloned);
      return;
    }
    case 'increment': {
      const segments = parsePointer(patch.path);
      const navigation = navigate(state, segments, {
        op: patch.op,
        patchIndex,
        autoVivify,
      });
      const current = navigation.exists ? readAt(navigation) : undefined;
      if (typeof current !== 'number') {
        if (!autoVivify) {
          throw new PatchApplyError(
            navigation.exists
              ? `'increment' target is not numeric: ${patch.path}`
              : `'increment' target does not exist: ${patch.path}`,
            patchIndex,
            patch.path,
            patch.op,
          );
        }
        writeAt(navigation, patch.by); // autoVivify: missing/non-numeric target starts at 0
        return;
      }
      writeAt(navigation, current + patch.by);
      return;
    }
    case 'merge': {
      const segments = parsePointer(patch.path);
      const navigation = navigate(state, segments, {
        op: patch.op,
        patchIndex,
        autoVivify,
      });
      let target = navigation.exists ? readAt(navigation) : undefined;
      if (!isMutableJsonObject(target)) {
        if (!autoVivify) {
          throw new PatchApplyError(
            navigation.exists
              ? `'merge' target is not an object: ${patch.path}`
              : `'merge' target does not exist: ${patch.path}`,
            patchIndex,
            patch.path,
            patch.op,
          );
        }
        target = {}; // autoVivify: missing/non-object target becomes a fresh object
        writeAt(navigation, target);
      }
      if (!isMutableJsonObject(target)) throw new TypeError('Expected a mutable JSON object');
      const update = cloneJsonObject(patch.value);
      if (patch.deep) {
        deepMergeInPlace(target, update);
      } else {
        for (const [key, value] of Object.entries(update)) target[key] = value;
      }
      return;
    }
    case 'upsert': {
      const segments = parsePointer(patch.path);
      const navigation = navigate(state, segments, {
        op: patch.op,
        patchIndex,
        autoVivify,
      });
      let target = navigation.exists ? readAt(navigation) : undefined;
      if (!Array.isArray(target)) {
        if (!autoVivify) {
          throw new PatchApplyError(
            navigation.exists
              ? `'upsert' target is not an array: ${patch.path}`
              : `'upsert' target does not exist: ${patch.path}`,
            patchIndex,
            patch.path,
            patch.op,
          );
        }
        target = []; // autoVivify: missing/non-array target becomes a fresh array
        writeAt(navigation, target);
      }
      const keyField = patch.key;
      const incoming = cloneJsonObject(patch.value);
      const matchValue = incoming[keyField];
      const existingIndex = target.findIndex(
        (item) => isMutableJsonObject(item) && item[keyField] === matchValue,
      );
      if (existingIndex >= 0) target[existingIndex] = incoming;
      else target.push(incoming);
      return;
    }
  }
}

function cloneJsonObject(value: JsonObject): MutableJsonObject {
  const clone = cloneJson(value);
  if (!isMutableJsonObject(clone)) {
    throw new TypeError('Expected a JSON object');
  }
  return clone;
}

function deepMergeInPlace(target: MutableJsonObject, update: MutableJsonObject): void {
  for (const [key, value] of Object.entries(update)) {
    const existing = target[key];
    if (isMutableJsonObject(existing) && isMutableJsonObject(value)) {
      deepMergeInPlace(existing, value);
    } else {
      target[key] = value;
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
  source: PatchSourceValue = PatchSource.Reducer,
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
    if (p.op === PatchOperation.Move || p.op === PatchOperation.Copy) {
      touched.add(p.from);
    }
  }
  return { newState: candidate, journal, touchedPaths: touched };
}

function buildJournalEntry(p: Patch, source: PatchSourceValue): JournalEntry {
  switch (p.op) {
    case PatchOperation.Remove:
      return { source, op: PatchOperation.Remove, path: p.path };
    case PatchOperation.Move:
    case PatchOperation.Copy:
      return { source, op: p.op, path: p.path, from: p.from };
    case PatchOperation.Increment:
      return { source, op: PatchOperation.Increment, path: p.path, by: p.by };
    default:
      return { source, op: p.op, path: p.path, value: p.value };
  }
}
