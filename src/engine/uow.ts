/**
 * Unit of Work (UoW) Coordinator — design §6.1 Two-Phase Commit Protocol
 *
 * Protocol summary:
 *  1. Fault-sim short-circuit: if command.faultSignal is set, return the simulated
 *     response immediately, bypassing all execution logic.
 *  2. Open an OTEL span wrapping the entire execution.
 *  3. Acquire a per-aggregateId serialization mutex so concurrent requests targeting
 *     the same aggregate are queued rather than interleaved.
 *  4. Check optimistic-concurrency preconditions (req 28, 29).
 *  5. Initialize a ShadowGraph to stage all writes transiently.
 *  6. Run the PatternMatcher for the primary command; cascade any secondary commands
 *     up to maxDepth levels deep; abort with InfiniteLoopError on overflow (req 32).
 *  7. Commit phase: block-append all staged events to EventStore (req 20), then
 *     flush the ShadowGraph into the global StateGraph (req 22).
 *  8. Build and validate the HTTP response; return ExecutionResult.
 *
 * Mutex strategy: a module-level Map<string, Promise<void>> chains UoWs for the same
 * aggregateId so they execute serially. Creation commands and collection queries (where
 * targetId is null) share a single sentinel lock key `__global__` to avoid races on
 * the same boundary without a specific aggregate ID.
 *
 * Optional UowInput fields added by this module:
 *  - requiresPrecondition?: (boundary: string, method: string) => boolean
 *      Boot wires a callback here when an OpenAPI operation marks If-Match required.
 *      Default behaviour: if sequenceVersion is not supplied and none is required by
 *      the callback, the check is skipped; if supplied it is always validated.
 *  - openapi?: OpenApiDoc
 *      Required only for query intent (passed to runQuery). Optional to avoid breaking
 *      callers that don't run queries.
 */

import type { ExecutionResult } from '../types.js';
import type { CompiledDsl } from '../dsl/types.js';
import type { StateGraph } from '../stategraph/graph.js';
import type { EventStore } from '../eventstore/store.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { ContractValidator } from '../contract/validator.js';
import type { Command, DomainEvent } from '../types.js';
import type { Logger } from '../observability/logger.js';
import type { Tracer } from '../observability/tracing.js';
import type { EngineMetrics } from '../observability/metrics.js';
import type { ObjectGraphSchemaRegistry } from '../schema/types.js';
import type { OpenApiDoc } from '../contract/loader.js';
import type { ShadowGraph } from '../stategraph/shadow.js';

import { createShadowGraph } from '../stategraph/shadow.js';
import { runPatternMatch } from './patternMatcher.js';
import { projectEvent } from './projection.js';
import { runQuery } from './query.js';
import { nextUuidv7 } from '../ids/uuidv7.js';
import { createLogger } from '../observability/logger.js';
import { getTracer, withSpan } from '../observability/tracing.js';
import {
  InfiniteLoopError,
  ConcurrencyConflictError,
  MissingPreconditionError,
  InternalExecutionError,
} from '../errors.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface UowInput {
  readonly command: Command;
  readonly dsl: CompiledDsl;
  readonly graph: StateGraph;
  readonly events: EventStore;
  readonly cel: CelEvaluator;
  readonly validator: ContractValidator;
  /** Maximum secondary-command cascade depth before InfiniteLoopError. Default: 5. */
  readonly maxDepth?: number;
  /** Optional logger for structured UoW execution traces. */
  readonly logger?: Logger;
  /** Optional tracer for distributed tracing spans. */
  readonly tracer?: Tracer;
  /** Optional metrics for recording UoW outcomes. */
  readonly metrics?: EngineMetrics;
  /** Optional schema registry for runtime path/type guards during projection. */
  readonly schemaRegistry?: ObjectGraphSchemaRegistry;
  /**
   * Optional callback, wired by boot, that returns true when the OpenAPI operation for
   * (boundary, method) declares If-Match as a required header parameter.
   * When absent the engine skips the "required but missing" check (req 29); it still
   * validates a supplied sequenceVersion against the current store value (req 28).
   */
  readonly requiresPrecondition?: (boundary: string, method: string) => boolean;
  /**
   * Optional OpenAPI document forwarded to runQuery for collection/single-entity
   * read operations. Must be supplied when intent === 'query'.
   */
  readonly openapi?: OpenApiDoc;
}

// ---------------------------------------------------------------------------
// Module-level concurrency locks
// ---------------------------------------------------------------------------

/**
 * Per-aggregateId mutex chain. Each entry is the tail of a promise chain; new UoWs
 * targeting the same key append themselves to the chain via .then() so they run
 * serially.
 */
const _locks = new Map<string, Promise<void>>();

/** Sentinel key used for commands whose targetId is null. */
const GLOBAL_LOCK_KEY = '__global__';

/**
 * Acquire a serialized execution slot for `key`.
 * Returns a release function that MUST be called in a finally block.
 */
function acquireLock(key: string): { release: () => void; acquired: Promise<void> } {
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });

  const previous = _locks.get(key) ?? Promise.resolve();
  const acquired = previous.then(() => undefined);
  _locks.set(key, previous.then(() => slot));

  return { release, acquired };
}

// ---------------------------------------------------------------------------
// Shadow-graph → StateGraph adapter
// ---------------------------------------------------------------------------

/**
 * Wrap a ShadowGraph so it satisfies the StateGraph interface required by runQuery.
 * Only `get`, `keys`, `values`, `entries`, `size` are meaningful for reads; `set`
 * delegates to `shadow.stage`; `delete` and `purge` are no-ops (projection owns
 * deletes via the global graph after commit).
 */
function shadowAsStateGraph(shadow: ShadowGraph, global: StateGraph): StateGraph {
  return {
    get: (id) => shadow.get(id) ?? global.get(id),
    set: (id, value) => shadow.stage(id, value),
    delete: (_id) => { /* no-op: deletions are applied during commit */ },
    keys: () => {
      const shadowKeys = new Set(shadow.shadowed().keys());
      const globalKeys = global.keys();
      const merged = new Set([...globalKeys, ...shadowKeys]);
      return [...merged];
    },
    values: () => {
      const allKeys = shadowAsStateGraph(shadow, global).keys();
      return allKeys.map((k) => shadow.get(k) ?? global.get(k)!);
    },
    entries: () => {
      const allKeys = shadowAsStateGraph(shadow, global).keys();
      return allKeys.map((k): readonly [string, import('../types.js').JsonObject] => [
        k,
        (shadow.get(k) ?? global.get(k))!,
      ]);
    },
    purge: () => { /* no-op */ },
    size: () => shadowAsStateGraph(shadow, global).keys().length,
  };
}

// ---------------------------------------------------------------------------
// Core executor
// ---------------------------------------------------------------------------

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
export async function executeUnitOfWork(input: UowInput): Promise<ExecutionResult> {
  const {
    command,
    dsl,
    graph,
    events: eventStore,
    cel,
    validator,
    maxDepth = 5,
    metrics,
    schemaRegistry,
  } = input;

  const logger = (input.logger ?? createLogger()).child({
    name: 'uow',
    commandId: command.commandId,
    boundary: command.boundary,
    intent: command.intent,
  });

  const tracer = input.tracer ?? getTracer('engine');
  const startMs = Date.now();

  // -------------------------------------------------------------------------
  // Step 1 — Fault-sim short-circuit (req 31)
  // -------------------------------------------------------------------------
  if (command.faultSignal !== undefined && command.faultSignal !== '') {
    let signal: { status: number; body: import('../types.js').JsonValue; headers?: Record<string, string> };
    try {
      signal = JSON.parse(command.faultSignal) as typeof signal;
    } catch {
      throw new InternalExecutionError('Unparseable faultSignal on command', {
        raw: command.faultSignal,
      });
    }

    metrics?.faultsSimulatedTotal.add(1, {
      boundary: command.boundary,
      intent: command.intent,
    });

    logger.warn({ faultStatus: signal.status }, 'UoW fault-sim short-circuit');

    return {
      status: signal.status,
      body: signal.body,
      headers: signal.headers,
      events: [],
    };
  }

  // -------------------------------------------------------------------------
  // Step 2 — Outer tracing span
  // -------------------------------------------------------------------------
  return withSpan(
    tracer,
    'engine.uow',
    async (_outerSpan) => {
      metrics?.commandsTotal.add(1, {
        boundary: command.boundary,
        intent: command.intent,
      });

      // -----------------------------------------------------------------------
      // Step 3 — Concurrency lock
      // -----------------------------------------------------------------------
      const lockKey = command.targetId ?? GLOBAL_LOCK_KEY;
      const { release, acquired } = acquireLock(lockKey);
      await acquired;

      let outcome: 'success' | 'abort' | 'error' = 'error';

      try {
        // -----------------------------------------------------------------------
        // Step 4 — Precondition / optimistic-concurrency checks (req 28, 29)
        // -----------------------------------------------------------------------
        if (command.intent !== 'query' && command.targetId !== null) {
          const preconditionRequired =
            input.requiresPrecondition?.(command.boundary, command.httpMethod) ?? false;

          if (preconditionRequired && command.sequenceVersion === undefined) {
            throw new MissingPreconditionError(
              `If-Match required for ${command.httpMethod} ${command.boundary} but not supplied`,
            );
          }

          if (command.sequenceVersion !== undefined) {
            const current = eventStore.currentSequenceVersion(command.targetId);
            if (current !== command.sequenceVersion) {
              throw new ConcurrencyConflictError(
                `sequenceVersion mismatch for ${command.targetId}: ` +
                  `expected ${command.sequenceVersion}, current ${current}`,
                { expected: command.sequenceVersion, current },
              );
            }
          }
        }

        // -----------------------------------------------------------------------
        // Step 5 — Shadow graph init
        // -----------------------------------------------------------------------
        const shadow = createShadowGraph(graph);

        // -----------------------------------------------------------------------
        // Step 6 — Primary execution + cascading (req 19, 32)
        // -----------------------------------------------------------------------
        const stagedEvents: DomainEvent[] = [];
        /** Count of events staged per aggregateId within this UoW, used for monotonic sequence-version assignment. */
        const stagedSeqDeltas = new Map<string, number>();

        const pendingCommands: Command[] = [command];

        while (pendingCommands.length > 0) {
          const cmd = pendingCommands.shift()!;

          if (cmd.depth > maxDepth) {
            throw new InfiniteLoopError(
              `Cascade depth ${cmd.depth} exceeds maxDepth ${maxDepth} at boundary ${cmd.boundary}`,
              { depth: cmd.depth, maxDepth, boundary: cmd.boundary },
            );
          }

          const boundary = dsl.byBoundaryName[cmd.boundary];
          if (boundary === undefined) {
            throw new InternalExecutionError(
              `Unknown boundary "${cmd.boundary}" referenced in command`,
              { boundary: cmd.boundary, commandId: cmd.commandId },
            );
          }

          // Child span per cascade level
          await withSpan(
            tracer,
            `engine.uow.cascade.depth-${cmd.depth}`,
            async (_childSpan) => {
              const shadowAsGraphAdapter = shadowAsStateGraph(shadow, graph);

              let outcome: PatternMatchResult;
              try {
                outcome = runPatternMatch({
                  command: cmd,
                  boundary,
                  shadow,
                  cel,
                  nextEventId: () => nextUuidv7(),
                  now: () => new Date().toISOString(),
                  logger,
                  schemaRegistry,
                  nextSequenceVersion: (aggregateId) =>
                    eventStore.currentSequenceVersion(aggregateId) +
                    (stagedSeqDeltas.get(aggregateId) ?? 0) +
                    1,
                  projectToShadow: (event) =>
                    projectEvent({
                      event,
                      boundary,
                      graph: shadowAsGraphAdapter,
                      cel,
                      logger,
                      schemaRegistry,
                    }),
                });
              } catch (err) {
                const code =
                  err instanceof Error ? (err as { code?: string }).code ?? err.message : String(err);
                logger.warn({ err, code, commandId: cmd.commandId }, 'UoW aborted');
                metrics?.uowAbortsTotal.add(1, { boundary: cmd.boundary });
                throw err;
              }

              // Accumulate staged events
              for (const evt of outcome.events) {
                stagedEvents.push(evt);
                stagedSeqDeltas.set(
                  evt.aggregateId,
                  (stagedSeqDeltas.get(evt.aggregateId) ?? 0) + 1,
                );
              }

              // Enqueue secondary commands for next iterations
              for (const sec of outcome.secondaryCommands) {
                pendingCommands.push(sec);
              }
            },
            { 'uow.depth': cmd.depth, 'uow.boundary': cmd.boundary },
          );
        }

        // -----------------------------------------------------------------------
        // Step 7 — Commit phase (req 20, 22)
        // -----------------------------------------------------------------------
        eventStore.append(stagedEvents);
        metrics?.eventsAppendedTotal.add(stagedEvents.length, {
          boundary: command.boundary,
        });
        shadow.commitInto(graph);

        // -----------------------------------------------------------------------
        // Step 8 — Response construction
        // -----------------------------------------------------------------------
        let status: number;
        let body: import('../types.js').JsonValue;

        if (command.intent === 'query') {
          if (input.openapi === undefined) {
            throw new InternalExecutionError(
              'openapi document required in UowInput for query intent',
            );
          }
          const boundary = dsl.byBoundaryName[command.boundary];
          if (boundary === undefined) {
            throw new InternalExecutionError(`Unknown boundary "${command.boundary}"`);
          }
          body = runQuery({
            boundary,
            targetId: command.targetId,
            queryParams: command.queryParams,
            graph,
            cel,
            openapi: input.openapi,
            logger,
            schemaRegistry,
          });
          status = 200;
        } else if (command.intent === 'creation') {
          status = 201;
          body = command.targetId !== null ? (graph.get(command.targetId) ?? {}) : {};
        } else {
          // mutation
          status = 200;
          body = command.targetId !== null ? (graph.get(command.targetId) ?? {}) : {};
        }

        // Validate the response body against the contract (throws InternalExecutionError on fail)
        validator.validateResponse(command.httpMethod, command.path, status, body);

        outcome = 'success';

        const elapsedMs = Date.now() - startMs;
        metrics?.commandDurationMs.record(elapsedMs, {
          boundary: command.boundary,
          intent: command.intent,
          outcome,
        });

        return {
          status,
          body,
          headers: undefined,
          events: stagedEvents,
        } satisfies ExecutionResult;
      } catch (err) {
        if (outcome === 'error') {
          const elapsedMs = Date.now() - startMs;
          metrics?.commandDurationMs.record(elapsedMs, {
            boundary: command.boundary,
            intent: command.intent,
            outcome: 'abort',
          });
        }
        throw err;
      } finally {
        release();
      }
    },
    {
      'uow.commandId': command.commandId,
      'uow.boundary': command.boundary,
      'uow.intent': command.intent,
    },
  );
}

// ---------------------------------------------------------------------------
// Internal type alias (avoids re-importing the full PatternMatchOutcome type)
// ---------------------------------------------------------------------------
type PatternMatchResult = Awaited<ReturnType<typeof runPatternMatch>>;
