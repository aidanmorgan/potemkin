import type { Logger } from '../observability/logger.js';
import type { CompiledDsl } from '../dsl/types.js';
import type { ScriptHandle, ScriptRegistry } from './types.js';
import type { RegisteredScript } from '../sdk/index.js';
import { transpileScript } from './transpile.js';
import { instantiateScript } from './sandbox.js';

export function buildScriptRegistry(dsl: CompiledDsl, logger: Logger): ScriptRegistry {
  const handles = new Map<string, ScriptHandle>();

  for (const boundary of dsl.boundaries) {
    if (!boundary.scripts || boundary.scripts.length === 0) {
      continue;
    }

    for (const decl of boundary.scripts) {
      const key = `${boundary.boundary}::${decl.name}`;

      const transpiledCode = transpileScript(decl.name, boundary.boundary, decl.code);
      const handle = instantiateScript(decl.name, boundary.boundary, transpiledCode, logger);

      handles.set(key, handle);
    }
  }

  return {
    get(boundary: string, name: string): ScriptHandle | undefined {
      return handles.get(`${boundary}::${name}`);
    },
    has(boundary: string, name: string): boolean {
      return handles.has(`${boundary}::${name}`);
    },
    size(): number {
      return handles.size;
    },
  };
}

/**
 * Build a composite ScriptRegistry that resolves ts:<id> references against
 * both inline scripts (keyed by boundary+name) and scanned @Script functions
 * (keyed by global id).
 *
 * Resolution order:
 *   1. Inline registry — get(boundary, name) for the existing scripts[].code path.
 *   2. Scanned registry — find a RegisteredScript whose id === name, then wrap it
 *      as a ScriptHandle for direct host execution (no vm sandbox).
 *
 * Scanned @Script functions are already-compiled, trusted, operator-authored host
 * code. They execute directly as host calls (mirroring how TS reducers are invoked)
 * rather than being pushed through the node:vm inline-source sandbox.
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
