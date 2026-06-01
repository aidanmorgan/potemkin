// Per-BootedSystem holder for TypeScript-registered reducers. The projection
// path (projection.ts) consults this FIRST for a (boundary, event) before
// falling back to YAML patches. The watcher atomic-swaps the backing map
// via `swap()` so a hot reload never tears a read.

import type { RegisteredReducer } from '../sdk/index.js';

export interface TsReducerRegistry {
  /** Look up a reducer by (boundary, event). Returns undefined on miss. */
  get(boundary: string, event: string): RegisteredReducer | undefined;
  /** True when any reducer is registered. */
  hasAny(): boolean;
  /** Snapshot of all registered reducers. */
  snapshot(): readonly RegisteredReducer[];
  /** Atomically replace the backing map (watch-mode hot reload). */
  swap(reducers: readonly RegisteredReducer[]): void;
}

function keyOf(boundary: string, event: string): string {
  return `${boundary}:${event}`;
}

export function createTsReducerRegistry(
  initial: readonly RegisteredReducer[] = [],
): TsReducerRegistry {
  let entries = indexBy(initial);

  return {
    get(boundary, event) {
      return entries.get(keyOf(boundary, event));
    },
    hasAny() {
      return entries.size > 0;
    },
    snapshot() {
      return [...entries.values()];
    },
    swap(reducers) {
      // Build the replacement map fully before swapping the reference so
      // concurrent reads see either the old or the new map, never a partial.
      entries = indexBy(reducers);
    },
  };
}

function indexBy(reducers: readonly RegisteredReducer[]): Map<string, RegisteredReducer> {
  const m = new Map<string, RegisteredReducer>();
  for (const r of reducers) m.set(keyOf(r.boundary, r.event), r);
  return m;
}
