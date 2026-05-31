import type { JsonObject, JsonValue } from '../types.js';
import { createLogger } from '../observability/index.js';

export interface StateGraph {
  /** Return the state object for the given targetId, or null if absent. */
  get(targetId: string): JsonObject | null;

  /** Atomically replace the stored state for the given targetId. */
  set(targetId: string, value: JsonObject): void;

  /** Remove the entry for the given targetId (no-op if absent). */
  delete(targetId: string): void;

  /** Return all stored targetIds. */
  keys(): readonly string[];

  /** Return all stored state objects. */
  values(): readonly JsonObject[];

  /** Return all [targetId, state] pairs. */
  entries(): readonly (readonly [string, JsonObject])[];

  /** Discard all entries (used during reset). */
  purge(): void;

  /** Return the total number of entries. */
  size(): number;

  /**
   * Capture an opaque snapshot of the current projection so a caller can later
   * roll back to exactly this state. Used together with EventStore.snapshot to
   * give multi-item transactional batches all-or-nothing semantics.
   */
  snapshot(): StateGraphSnapshot;

  /** Restore the projection to a previously-captured snapshot. */
  restore(snapshot: StateGraphSnapshot): void;
}

/** Opaque, immutable capture of StateGraph contents for transactional rollback. */
export interface StateGraphSnapshot {
  /** Frozen [targetId, frozen-state] pairs as of capture. */
  readonly entries: readonly (readonly [string, JsonObject])[];
}

/**
 * Produce a deep clone of any JsonValue without shared references.
 *
 * JsonValue is acyclic by type definition, but a defensive cycle-detection guard is
 * included to produce a clear error if the type boundary is breached at runtime
 * (e.g., via `as unknown as JsonValue` coercion). Without this, circular refs cause
 * a RangeError (maximum call stack exceeded) with no useful context.
 */
export function deepClone<T extends JsonValue>(v: T, _seen?: WeakMap<object, true>): T {
  if (v === null) return null as T;
  if (typeof v !== 'object') return v;

  // Initialise cycle-detection map on the first recursive call.
  const seen = _seen ?? new WeakMap<object, true>();
  if (seen.has(v as object)) {
    throw new Error('deepClone: circular reference detected');
  }
  seen.set(v as object, true);

  if (Array.isArray(v)) {
    const result = (v as JsonValue[]).map((item) => deepClone(item, seen)) as T;
    seen.delete(v as object);
    return result;
  }
  const result: JsonObject = {};
  for (const key of Object.keys(v as JsonObject)) {
    result[key] = deepClone((v as JsonObject)[key], seen);
  }
  seen.delete(v as object);
  return result as T;
}

/**
 * Recursively merge `source` into a copy of `target`.
 * Arrays in `source` replace corresponding arrays in `target` (no concat).
 */
export function deepMerge(target: JsonObject, source: JsonObject): JsonObject {
  const result: JsonObject = deepClone(target);
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];

    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      tgtVal !== undefined &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      // Both are plain objects — recurse
      result[key] = deepMerge(tgtVal as JsonObject, srcVal as JsonObject);
    } else {
      // Scalars, arrays, or type mismatch — source wins (arrays replace)
      result[key] = deepClone(srcVal);
    }
  }
  return result;
}

/** Recursively freeze a JsonValue in-place and return it. */
export function deepFreeze<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  Object.freeze(v);
  if (Array.isArray(v)) {
    for (const item of v as unknown[]) deepFreeze(item);
  } else {
    for (const key of Object.keys(v as object)) {
      deepFreeze((v as Record<string, unknown>)[key]);
    }
  }
  return v;
}

const logger = createLogger({ name: 'stategraph' });

export function createStateGraph(): StateGraph {
  const store = new Map<string, JsonObject>();

  return {
    get(targetId: string): JsonObject | null {
      return store.get(targetId) ?? null;
    },

    set(targetId: string, value: JsonObject): void {
      // Deep-clone then deep-freeze: atomic pointer swap per §6.2
      const frozen = deepFreeze(deepClone(value));
      store.set(targetId, frozen);
    },

    delete(targetId: string): void {
      store.delete(targetId);
    },

    keys(): readonly string[] {
      return Object.freeze([...store.keys()]);
    },

    values(): readonly JsonObject[] {
      return Object.freeze([...store.values()]);
    },

    entries(): readonly (readonly [string, JsonObject])[] {
      return Object.freeze([...store.entries()].map((e) => Object.freeze(e) as readonly [string, JsonObject]));
    },

    purge(): void {
      store.clear();
      logger.info('State graph purged');
    },

    size(): number {
      return store.size;
    },

    snapshot(): StateGraphSnapshot {
      // Stored values are already deep-frozen on set(); capturing the pairs is a
      // faithful, side-effect-free snapshot.
      return Object.freeze({ entries: Object.freeze([...store.entries()]) });
    },

    restore(snap: StateGraphSnapshot): void {
      store.clear();
      for (const [id, value] of snap.entries) {
        store.set(id, value);
      }
      logger.info({ count: snap.entries.length }, 'State graph restored to snapshot');
    },
  };
}
