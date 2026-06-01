import type { Logger } from '../observability/logger.js';
import type { CompiledDsl } from '../dsl/types.js';
import type { ScriptHandle, ScriptRegistry } from './types.js';
import { transpileScript } from './transpile.js';
import { instantiateScript } from './sandbox.js';

/**
 * Build the script registry from all compiled DSL boundaries.
 * Transpiles and instantiates every declared script at boot time.
 */
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
