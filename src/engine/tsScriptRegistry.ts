// Mutable holder for the composite @Script registry.
//
// Mirrors the TsReducerRegistry pattern: a stable object reference whose
// internal registry is atomically replaced by `swap()` on each hot-reload.
// Because BootedSystem.dsl is built once at boot and its `scriptRegistry`
// field is read by every UoW/patternMatcher call, placing a TsScriptRegistry
// there (instead of a plain ScriptRegistry) means all in-flight and future
// reads automatically see the updated functions without any changes to the
// UoW call sites.

import type { ScriptRegistry } from '../scripts/types.js';
import type { RegisteredScript } from '../sdk/index.js';
import { buildCompositeScriptRegistry } from '../scripts/registry.js';

export interface TsScriptRegistry extends ScriptRegistry {
  /** Atomically replace the scanned-script snapshot on hot-reload. */
  swap(scripts: readonly RegisteredScript[]): void;
}

/**
 * Create a TsScriptRegistry backed by an initial scanned-script registry.
 *
 * `initialScripts`   — the @Script entries discovered by the initial scan.
 */
export function createTsScriptRegistry(
  initialScripts: readonly RegisteredScript[],
): TsScriptRegistry {
  let current: ScriptRegistry = buildCompositeScriptRegistry(initialScripts);

  return {
    get(boundary: string, name: string) {
      return current.get(boundary, name);
    },
    has(boundary: string, name: string) {
      return current.has(boundary, name);
    },
    size() {
      return current.size();
    },
    swap(scripts: readonly RegisteredScript[]) {
      // Build the replacement fully before swapping so concurrent reads see
      // either the old or the new registry, never a partial state.
      current = buildCompositeScriptRegistry(scripts);
    },
  };
}
