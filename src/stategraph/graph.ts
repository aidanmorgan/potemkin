import type { JsonObject, JsonValue } from '../types.js';

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

export function createStateGraph(): StateGraph {
  throw new Error('NotImplemented: stategraph/graph.createStateGraph');
}

/** Produce a deep clone of any JsonValue without shared references. */
export function deepClone<T extends JsonValue>(v: T): T {
  throw new Error('NotImplemented: stategraph/graph.deepClone');
}

/**
 * Recursively merge `source` into a copy of `target`.
 * Arrays in `source` replace corresponding arrays in `target` (no concat).
 */
export function deepMerge(target: JsonObject, source: JsonObject): JsonObject {
  throw new Error('NotImplemented: stategraph/graph.deepMerge');
}
