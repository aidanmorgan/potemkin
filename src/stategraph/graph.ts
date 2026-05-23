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
}

/** Produce a deep clone of any JsonValue without shared references. */
export function deepClone<T extends JsonValue>(v: T): T {
  if (v === null) return null as T;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    return (v as JsonValue[]).map((item) => deepClone(item)) as T;
  }
  const result: JsonObject = {};
  for (const key of Object.keys(v as JsonObject)) {
    result[key] = deepClone((v as JsonObject)[key]);
  }
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
  };
}
