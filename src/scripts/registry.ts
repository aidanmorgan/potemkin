import type { ScriptHandle, ScriptRegistry } from './types.js';
import type { RegisteredScript } from '../sdk/index.js';

/**
 * Build a composite ScriptRegistry that resolves ts:<id> references against
 * scanned @Script functions (keyed by global id).
 *
 * Scanned @Script functions are already-compiled, trusted, operator-authored host
 * code. They execute directly as host calls rather than being pushed through a vm
 * sandbox.
 */
export function buildCompositeScriptRegistry(
  inlineRegistry: ScriptRegistry | undefined,
  scannedScripts: readonly RegisteredScript[],
): ScriptRegistry {
  const scannedById = new Map<string, RegisteredScript>();
  for (const s of scannedScripts) {
    scannedById.set(s.id, s);
  }

  function get(boundary: string, name: string): ScriptHandle | undefined {
    if (inlineRegistry) {
      const inlineHandle = inlineRegistry.get(boundary, name);
      if (inlineHandle) return inlineHandle;
    }
    const scanned = scannedById.get(name);
    if (scanned) {
      return {
        name: scanned.id,
        boundary,
        source: scanned.source,
        fn: scanned.fn,
      };
    }
    return undefined;
  }

  function has(boundary: string, name: string): boolean {
    return get(boundary, name) !== undefined;
  }

  function size(): number {
    const inlineSize = inlineRegistry?.size() ?? 0;
    return inlineSize + scannedById.size;
  }

  return { get, has, size };
}
