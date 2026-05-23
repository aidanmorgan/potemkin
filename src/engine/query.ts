import type { JsonValue } from '../types.js';
import type { BoundaryConfig } from '../dsl/types.js';
import type { StateGraph } from '../stategraph/graph.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { OpenApiDoc } from '../contract/loader.js';

export interface QueryRequest {
  readonly boundary: BoundaryConfig;
  /** Specific targetId, or null for a collection query. */
  readonly targetId: string | null;
  readonly queryParams: Record<string, string | string[]>;
  readonly graph: StateGraph;
  readonly cel: CelEvaluator;
  readonly openapi: OpenApiDoc;
}

/**
 * Execute a read query against the StateGraph.
 *
 * - If `targetId` is non-null: return the single entity (applying CEL derived-property
 *   expressions defined in `queryMapping`).
 * - If `targetId` is null: return a filtered/sliced array of all entities in the boundary,
 *   applying `queryMapping` filter expressions against `queryParams`.
 *
 * @throws {EntityAbsenceError} (404) if a single-entity lookup finds no match.
 */
export function runQuery(req: QueryRequest): JsonValue {
  throw new Error('NotImplemented: engine/query.runQuery');
}
