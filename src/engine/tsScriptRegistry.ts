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
  /**
   * Atomically replace the scanned-script snapshot.  The inline registry (from
   * YAML scripts[].code, kept for legacy unit tests) is fixed at construction
   * time and is never replaced.
   */
  swap(scripts: readonly RegisteredScript[]): void;
}

/**
 * Create a TsScriptRegistry backed by an initial composite registry.
 *
 * `inlineRegistry`   — the pre-boot inline ScriptRegistry (may be undefined
 *                       when no YAML scripts[].code entries exist, which is the
 *                       post-B3 production case).
 * `initialScripts`   — the @Script entries discovered by the initial scan.
 */
export function createTsScriptRegistry(
  inlineRegistry: ScriptRegistry | undefined,
  initialScripts: readonly RegisteredScript[],
): TsScriptRegistry {
  let current: ScriptRegistry = buildCompositeScriptRegistry(inlineRegistry, initialScripts);

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
      // either the old or the new composite registry, never a partial state.
      current = buildCompositeScriptRegistry(inlineRegistry, scripts);
    },
  };
}
