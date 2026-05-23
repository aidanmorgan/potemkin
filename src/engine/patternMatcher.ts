import type { Command, DomainEvent } from '../types.js';
import type { BoundaryConfig } from '../dsl/types.js';
import type { ShadowGraph } from '../stategraph/shadow.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { Logger } from '../observability/logger.js';

export interface PatternMatchInput {
  readonly command: Command;
  readonly boundary: BoundaryConfig;
  readonly shadow: ShadowGraph;
  readonly cel: CelEvaluator;
  readonly nextEventId: () => string;
  readonly now: () => string;
  /** Optional logger for pattern evaluation traces. */
  readonly logger?: Logger;
}

export interface PatternMatchOutcome {
  /** Events staged during this match (primary and any fallback generic event). */
  readonly events: readonly DomainEvent[];
  /** Secondary commands queued for cascading execution inside the UoW. */
  readonly secondaryCommands: readonly Command[];
  /** Post-match shadow state for the target aggregate, or null if deleted/absent. */
  readonly state: import('../types.js').JsonObject | null;
}

/**
 * Evaluate a command against the boundary's behavior rules and return the outcome.
 *
 * Performs:
 *  1. Context assembly (checks creation/mutation preconditions against shadow).
 *  2. First-match evaluation of `behaviors` in order.
 *  3. Fallback to `System.GenericUpdateEvent` if `fallbackOverride` is true.
 *  4. Immediate projection of staged events into the shadow graph.
 *
 * @throws {EntityAbsenceError}   (404) mutation against absent target.
 * @throws {EntityConflictError}  (409) creation against already-present target.
 * @throws {UnhandledOperationError} (422) no match and no fallback.
 */
export function runPatternMatch(input: PatternMatchInput): PatternMatchOutcome {
  throw new Error('NotImplemented: engine/patternMatcher.runPatternMatch');
}
