import type { JsonObject } from '../types.js';
import type { StateGraph } from './graph.js';

export interface ShadowGraph {
  /**
   * Return the staged value for `targetId` if one exists, otherwise fall through
   * to the backing global StateGraph.
   */
  get(targetId: string): JsonObject | null;

  /** Stage a write for `targetId`. Does not touch the global graph until committed. */
  stage(targetId: string, value: JsonObject): void;

  /** Return true if `targetId` has a staged value in this shadow. */
  has(targetId: string): boolean;

  /** Return all staged entries as a read-only map. */
  shadowed(): ReadonlyMap<string, JsonObject>;

  /** Apply all staged writes into `graph` atomically. */
  commitInto(graph: StateGraph): void;
}

/**
 * Create a shadow graph that layers transactional writes over the provided global graph.
 */
export function createShadowGraph(global: StateGraph): ShadowGraph {
  throw new Error('NotImplemented: stategraph/shadow.createShadowGraph');
}
