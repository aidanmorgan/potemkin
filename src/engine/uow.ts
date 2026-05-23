import type { ExecutionResult } from '../types.js';
import type { CompiledDsl } from '../dsl/types.js';
import type { StateGraph } from '../stategraph/graph.js';
import type { EventStore } from '../eventstore/store.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { ContractValidator } from '../contract/validator.js';
import type { Command } from '../types.js';

export interface UowInput {
  readonly command: Command;
  readonly dsl: CompiledDsl;
  readonly graph: StateGraph;
  readonly events: EventStore;
  readonly cel: CelEvaluator;
  readonly validator: ContractValidator;
  /** Maximum secondary-command cascade depth before InfiniteLoopError. Default: 5. */
  readonly maxDepth?: number;
}

/**
 * Execute a full Unit of Work for the given command.
 *
 * Protocol (2PC):
 *  1. Create a ShadowGraph scoped to this UoW.
 *  2. Run the PatternMatcher for the primary command; recursively cascade secondary commands.
 *  3. Check cascade depth; abort with InfiniteLoopError (508) if exceeded.
 *  4. Acquire concurrency lock; verify sequenceVersion; abort with ConcurrencyConflictError
 *     (412) or MissingPreconditionError (428) as appropriate.
 *  5. Block-append all staged events to the EventStore.
 *  6. Project each event onto the global StateGraph.
 *  7. Return ExecutionResult with status, body, headers, and committed events.
 *
 * Any unhandled exception aborts the UoW and discards staged events.
 *
 * @throws {InfiniteLoopError}          (508) depth exceeded.
 * @throws {ConcurrencyConflictError}   (412) sequenceVersion mismatch.
 * @throws {MissingPreconditionError}   (428) concurrency required but absent.
 * @throws {InternalExecutionError}     (500) unexpected execution failure.
 */
export function executeUnitOfWork(input: UowInput): ExecutionResult {
  throw new Error('NotImplemented: engine/uow.executeUnitOfWork');
}
