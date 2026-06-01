import type { JsonObject } from '../types.js';
import type { StateGraph } from './graph.js';
import { deepClone } from './graph.js';
import { createLogger } from '../observability/index.js';

export interface ShadowGraph {
  /**
   * Return the staged value for `targetId` if one exists, otherwise fall through
   * to the backing global StateGraph.
   */
  get(targetId: string): JsonObject | null;

  /** Stage a write for `targetId`. Does not touch the global graph until committed. */
  stage(targetId: string, value: JsonObject): void;

  /** Return true if `targetId` has a staged value in this shadow or the global graph. */
  has(targetId: string): boolean;

  /** Return all staged entries as a read-only map. */
  shadowed(): ReadonlyMap<string, JsonObject>;

  /** Apply all staged writes into `graph` atomically. */
  commitInto(graph: StateGraph): void;
}

const logger = createLogger({ name: 'stategraph.shadow' });

/**
 * Create a shadow graph that layers transactional writes over the provided global graph.
 */
export function createShadowGraph(global: StateGraph): ShadowGraph {
  // staged holds mutable working copies — callers are free to read but not mutate
  const staged = new Map<string, JsonObject>();

  return {
    get(targetId: string): JsonObject | null {
      if (staged.has(targetId)) {
        // Return the staged value directly — it is a mutable clone for caller use
        return staged.get(targetId) as JsonObject;
      }
      // Fall through to global; clone so caller can mutate without affecting the real graph
      const globalVal = global.get(targetId);
      if (globalVal === null) return null;
      const cloned = deepClone(globalVal);
      // Cache the clone so subsequent reads within the same shadow are stable
      staged.set(targetId, cloned);
      return cloned;
    },

    stage(targetId: string, value: JsonObject): void {
      const cloned = deepClone(value);
      staged.set(targetId, cloned);
      logger.trace({ targetId }, 'Staged value in shadow graph');
    },

    has(targetId: string): boolean {
      // S-3: Read the global graph directly without triggering the cache-populating
      // side-effect of this.get(). global.get() is a pure read; staged.has() checks
      // local state only. No clone is created here.
      return staged.has(targetId) || global.get(targetId) !== null;
    },

    shadowed(): ReadonlyMap<string, JsonObject> {
      return staged as ReadonlyMap<string, JsonObject>;
    },

    commitInto(graph: StateGraph): void {
      for (const [id, value] of staged) {
        graph.set(id, value);
        logger.trace({ targetId: id }, 'Committed shadow entry into state graph');
      }
      const committed = staged.size;
      staged.clear();
      logger.trace({ count: committed }, 'Shadow graph committed and cleared');
    },
  };
}
