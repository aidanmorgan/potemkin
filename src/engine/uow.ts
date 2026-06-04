/**
 * Unit of Work (UoW) Coordinator — design §6.1 Two-Phase Commit Protocol
 *
 * Protocol summary:
 *  1. Fault-sim short-circuit: if command.faultSignal is set, return the simulated
 *     response immediately, bypassing all execution logic.
 *  2. Open an OTEL span wrapping the entire execution.
 *  3. Acquire a per-aggregateId serialization mutex so concurrent requests targeting
 *     the same aggregate are queued rather than interleaved.
 *  4. Check optimistic-concurrency preconditions.
 *  5. Initialize a ShadowGraph to stage all writes transiently.
 *  6. Run the PatternMatcher for the primary command; cascade any secondary commands
 *     up to maxDepth levels deep; abort with InfiniteLoopError on overflow.
 *  7. Commit phase: block-append all staged events to EventStore, then
 *     flush the ShadowGraph into the global StateGraph.
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

import type { ExecutionResult, JsonObject, JsonValue } from '../types.js';
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
import type { DerivedProjectionRegistry } from '../projections/types.js';

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
import { fireReactions } from './reactions.js';
import { applyEventToDerivedProjections } from '../projections/engine.js';
import { findTriggeredSagas, runSaga } from '../sagas/orchestrator.js';
import { prepareWebhookDelivery, deliverWebhook, type FetchLike } from '../webhooks/dispatcher.js';
import type { SideEffectQueue, SideEffectThunk, ResetEpoch } from './sideEffects.js';
import { withEpochGuard } from './sideEffects.js';
import type { WebhookConfig } from '../dsl/types.js';
import type { ControlHeaders } from '../http/controlHeaders.js';
import type { TsReducerRegistry } from './tsReducerRegistry.js';
import type { BoundaryInferenceResult } from '../dsl/schemaInference.js';

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
  /**
   * Per-BootedSystem aggregate lock map used to serialize concurrent UoW
   * executions that target the same aggregate. Supplied by the gateway /
   * forwarding handler (sys.aggregateLocks). When omitted (sequential direct
   * callers), a fresh map is used so the lock is a no-op.
   */
  readonly aggregateLocks?: Map<string, Promise<void>>;
  /** Maximum secondary-command cascade depth before InfiniteLoopError. Default: MAX_UOW_DEPTH (5). */
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
   * When absent the engine skips the "required but missing" check; it still
   * validates a supplied sequenceVersion against the current store value.
   */
  readonly requiresPrecondition?: (boundary: string, method: string) => boolean;
  /**
   * Optional OpenAPI document forwarded to runQuery for collection/single-entity
   * read operations. Must be supplied when intent === 'query'.
   */
  readonly openapi?: OpenApiDoc;
  /**
   * Optional derived projection registry. When supplied, committed events are
   * also routed to subscribed derived projections.
   */
  readonly derivedProjections?: DerivedProjectionRegistry;
  /** Parsed X-Potemkin-* control headers (dry-run, skip-sagas, etc.). */
  readonly controls?: ControlHeaders;
  /**
   * TypeScript-reducer registry. When supplied, projection consults it
   * FIRST for each (boundary, event) and runs the TS reducer in place of the
   * YAML reducer on a hit. Threaded from sys.tsReducerRegistry by the gateway,
   * forwarding handler, and saga orchestrator.
   */
  readonly tsReducerRegistry?: TsReducerRegistry;
  /**
   * Per-boundary inferred schemas (keyed by boundary). When supplied, the
   * computed fields + topological order for the projecting boundary are passed
   * to projectEvent so computed fields recompute after reducer patches apply.
   */
  readonly inferredSchemas?: Readonly<Record<string, BoundaryInferenceResult>>;
  /**
   * Injectable webhook transport. When supplied alongside `dsl.webhooks`, each
   * committed event is matched against the webhook subscriptions and a signed
   * delivery is dispatched fire-and-forget via this transport (honouring
   * `controls.sideEffects.skipWebhooks`). Tests inject a fake to assert delivery
   * without real HTTP. When absent, webhook dispatch is skipped entirely.
   */
  readonly webhookTransport?: FetchLike;
  /**
   * Deferred-side-effect queue for bulk-transactional batches. When supplied,
   * the UoW ENQUEUES its post-commit sagas and webhooks here instead of firing
   * them inline; the gateway flushes the queue once the whole batch commits, or
   * discards it on abort, so no side-effect runs against state that is later
   * rolled back. When absent, side-effects fire immediately (the normal path).
   */
  readonly deferSideEffects?: SideEffectQueue;
  /**
   * Monotonic reset-epoch holder from the running system (sys.resetEpoch). When
   * supplied, each post-commit side-effect (saga/webhook) captures the epoch in
   * force at scheduling time and no-ops if it has advanced (i.e. a reset landed)
   * by the time it runs — so a side-effect scheduled before a reset cannot
   * append orphan events into the freshly-reset store. When absent, side-effects
   * run unconditionally (direct callers that never reset).
   */
  readonly resetEpoch?: ResetEpoch;
  /**
   * Per-UoW event budget for reaction-emitted events.
   * Defaults to MAX_UOW_REACTION_EVENTS (1000) in reactions.ts when not supplied.
   * The fired-set dedup handles cycles; this is a backstop for genuinely unbounded
   * distinct-aggregate fan-outs. Exceeding it throws ReactionBudgetExceededError (508).
   */
  readonly maxUowEvents?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum cascade depth for secondary commands. */
const MAX_UOW_DEPTH = 5;

/** Header name used for optimistic-concurrency precondition checks. */
const IF_MATCH_HEADER = 'If-Match';

// ---------------------------------------------------------------------------
// Per-aggregate concurrency locks
// ---------------------------------------------------------------------------

/** Sentinel key used for commands whose targetId is null. */
const GLOBAL_LOCK_KEY = '__global__';

/**
 * Sentinel key serializing every write-UoW in a system whose DSL can cascade
 * writes into aggregates OTHER than the command's primary target (reactions and
 * dispatch_commands). The per-target lock only guards the primary aggregate, so
 * two UoWs on DIFFERENT primaries that both cascade into the SAME third
 * aggregate would otherwise run concurrently, each reading the same base
 * sequenceVersion for that shared aggregate and assigning duplicates — the
 * second commit then throws "Non-monotonic sequence version" (a lost update).
 *
 * When a system can cascade, every write-UoW additionally holds this shared lock
 * so cascading and direct writes against any shared aggregate are serialized.
 * Acquired together with the primary lock in deterministic (sorted) order, which
 * makes multi-lock acquisition provably deadlock-free.
 */
const CASCADE_LOCK_KEY = '__cascade__';

/**
 * Per-aggregateId mutex chain. Each entry is the tail of a promise chain; new
 * UoWs targeting the same key append themselves via .then() so they run serially.
 *
 * The `locks` map is per-BootedSystem (UowInput.aggregateLocks), NOT a module
 * global — a shared global would serialize concurrent DIFFERENT systems against
 * each other on a shared aggregateId (or the GLOBAL_LOCK_KEY for null-target
 * commands), causing cross-system contention under Specmatic's parallel dispatch.
 *
 * Acquire a serialized execution slot for `key`. The returned release function
 * MUST be called in a finally block.
 */
function acquireLock(
  locks: Map<string, Promise<void>>,
  key: string,
): { release: () => void; acquired: Promise<void> } {
  let releaseSlot!: () => void;
  const slot = new Promise<void>((resolve) => {
    releaseSlot = resolve;
  });

  const previous = locks.get(key) ?? Promise.resolve();
  const acquired = previous.then(() => undefined);
  const chained = previous.then(() => slot);
  locks.set(key, chained);

  // Self-clean so the per-system map stays bounded by in-flight concurrency
  // rather than growing one entry per distinct aggregate id forever: once our
  // slot is released, drop the key IF no later acquirer has chained off us
  // (i.e. the tail is still our promise). Single-threaded, so this get+delete
  // cannot interleave with another acquire.
  const release = (): void => {
    releaseSlot();
    if (locks.get(key) === chained) {
      locks.delete(key);
    }
  };

  return { release, acquired };
}

/**
 * Acquire several serialization slots at once and return a single release that
 * frees them all.
 *
 * Deadlock-freedom: keys are de-duplicated and acquired in a fixed lexicographic
 * order. Because every caller acquires its lock set in the SAME global order,
 * no two UoWs can hold one lock while waiting on another in a cycle (the classic
 * resource-ordering argument), so multi-lock acquisition cannot deadlock.
 *
 * Slots are released in reverse acquisition order (does not affect correctness;
 * matches conventional nested-lock release).
 */
function acquireLocks(
  locks: Map<string, Promise<void>>,
  keys: readonly string[],
): { release: () => void; acquired: Promise<void> } {
  const ordered = [...new Set(keys)].sort();
  const releases: Array<() => void> = [];

  const acquired = (async (): Promise<void> => {
    for (const key of ordered) {
      const slot = acquireLock(locks, key);
      releases.push(slot.release);
      await slot.acquired;
    }
  })();

  const release = (): void => {
    for (let i = releases.length - 1; i >= 0; i--) {
      releases[i]!();
    }
  };

  return { release, acquired };
}

/**
 * True when this DSL can produce writes to aggregates OTHER than a command's
 * primary target within a single UoW — i.e. it declares any reaction or any
 * behaviour that dispatches secondary commands. Such systems must serialize
 * write-UoWs on CASCADE_LOCK_KEY so concurrent cascades into a shared aggregate
 * cannot interleave their sequence-version assignment.
 */
function dslCanCascade(dsl: CompiledDsl): boolean {
  if (dsl.reactionsByTrigger && dsl.reactionsByTrigger.size > 0) return true;
  for (const boundary of dsl.boundaries) {
    for (const behavior of boundary.behaviors) {
      if (behavior.dispatchCommands && behavior.dispatchCommands.length > 0) {
        return true;
      }
    }
  }
  return false;
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
      return allKeys.map((k): readonly [string, JsonObject] => [
        k,
        (shadow.get(k) ?? global.get(k))!,
      ]);
    },
    purge: () => { /* no-op */ },
    size: () => shadowAsStateGraph(shadow, global).keys().length,
    // The shadow adapter is a per-UoW read view; transactional snapshot/restore
    // operate on the real (committed) global graph, never this ephemeral wrapper.
    snapshot: () => global.snapshot(),
    restore: (snap) => global.restore(snap),
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
    maxDepth = MAX_UOW_DEPTH,
    metrics,
    schemaRegistry,
  } = input;

  // Tier 6: observability — an explicit X-Potemkin-Log-Level overrides the level
  // of this request's UoW child logger (and its descendants), so callers can dial
  // verbosity up/down per request without touching the global logger.
  const requestLogLevel = input.controls?.observability.logLevel;
  const logger = (input.logger ?? createLogger()).child(
    {
      name: 'uow',
      commandId: command.commandId,
      boundary: command.boundary,
      intent: command.intent,
    },
    requestLogLevel ? { level: requestLogLevel } : {},
  );

  const tracer = input.tracer ?? getTracer('engine');
  const startMs = Date.now();

  // Tier 6: observability — a request-scoped metric tag (key=value) is attached
  // to every metric attribute set this UoW records, so callers can slice engine
  // metrics by their own dimension. Empty when the control header is absent.
  const metricTag = input.controls?.observability.metricTag;
  const tagAttrs: Record<string, string> = metricTag ? { [metricTag.key]: metricTag.value } : {};

  // Increment commandsTotal for EVERY command entering executeUnitOfWork,
  // including the fault-sim short-circuit path that bypasses the outer span.
  metrics?.commandsTotal.add(1, {
    boundary: command.boundary,
    intent: command.intent,
    ...tagAttrs,
  });

  // -------------------------------------------------------------------------
  // Step 1 — Fault-sim short-circuit
  // -------------------------------------------------------------------------
  if (command.faultSignal !== undefined && command.faultSignal !== '') {
    let signal: { status: number; body: JsonValue; headers?: Record<string, string> };
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
      ...tagAttrs,
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
  // Pre-flight: openapi required for all non-fault-sim executions.
  // Checked here, BEFORE lock acquisition, so a misconfigured caller fails
  // fast with a clear message rather than surfacing a 500 mid-cascade while
  // holding the aggregate lock.
  // -------------------------------------------------------------------------
  if (input.openapi === undefined) {
    throw new InternalExecutionError(
      'UowInput.openapi is required — supply the OpenAPI document from BootedSystem.openapi',
      { commandId: command.commandId, boundary: command.boundary },
    );
  }
  // Extract to a local const so TypeScript carries the narrowed (non-undefined)
  // type into the async closures below without re-checking.
  const openapi: OpenApiDoc = input.openapi;

  // -------------------------------------------------------------------------
  // Step 2 — Outer tracing span
  // -------------------------------------------------------------------------
  return withSpan(
    tracer,
    'engine.uow',
    async (_outerSpan) => {

      // -----------------------------------------------------------------------
      // Step 3 — Concurrency lock
      // -----------------------------------------------------------------------
      const lockKey = command.targetId ?? GLOBAL_LOCK_KEY;
      // Direct (sequential) callers may omit aggregateLocks; the gateway and
      // forwarding handler pass the per-system map so concurrent same-aggregate
      // requests serialize within that one system only.
      const locks = input.aggregateLocks ?? new Map<string, Promise<void>>();
      // A write-UoW in a system whose DSL can cascade (reactions / dispatch)
      // ALSO holds the shared cascade lock, so two UoWs on different primaries
      // that both cascade into the same third aggregate cannot interleave their
      // sequence-version assignment (xgyh lost-update). Queries never write, so
      // they take only the primary lock. acquireLocks sorts the keys, making the
      // two-lock acquisition deadlock-free.
      const lockKeys =
        command.intent !== 'query' && dslCanCascade(dsl)
          ? [lockKey, CASCADE_LOCK_KEY]
          : [lockKey];
      const { release, acquired } = acquireLocks(locks, lockKeys);
      await acquired;

      let outcome: 'success' | 'abort' | 'error' = 'error';

      try {
        // -----------------------------------------------------------------------
        // Step 4 — Precondition / optimistic-concurrency checks
        // -----------------------------------------------------------------------
        if (command.intent !== 'query' && command.targetId !== null) {
          const preconditionRequired =
            input.requiresPrecondition?.(command.boundary, command.httpMethod) ?? false;

          if (preconditionRequired) {
            logger.debug(
              { boundary: command.boundary, method: command.httpMethod },
              'UoW precondition enforcement: If-Match required for this operation',
            );
            _outerSpan.setAttribute('uow.preconditionRequired', true);
          }

          if (preconditionRequired && command.sequenceVersion === undefined) {
            throw new MissingPreconditionError(
              `${IF_MATCH_HEADER} required for ${command.httpMethod} ${command.boundary} but not supplied`,
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
        // Step 6 — Primary execution + cascading
        // -----------------------------------------------------------------------
        const stagedEvents: DomainEvent[] = [];
        /** Count of events staged per aggregateId within this UoW, used for monotonic sequence-version assignment. */
        const stagedSeqDeltas = new Map<string, number>();

        // Reaction termination state — scoped to the WHOLE UoW (not per cascade
        // command) so a (reaction, aggregate) pair fires at most once across the
        // entire unit of work, including cycles that span secondary-command
        // boundaries, and the event budget bounds total reaction fan-out.
        const firedReactions = new Set<string>();
        let reactionEventCount = 0;

        const pendingCommands: Command[] = [command];

        while (pendingCommands.length > 0) {
          const cmd = pendingCommands.shift()!;

          // Use > so that depth === maxDepth is the last allowed level.
          // With MAX_UOW_DEPTH=5, depths 0–5 execute (5 secondary levels); depth 6 throws.
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

              let matchOutcome: PatternMatchResult;
              try {
                matchOutcome = runPatternMatch({
                  command: cmd,
                  boundary,
                  shadow,
                  cel,
                  nextEventId: () => nextUuidv7(),
                  now: () => new Date(Date.now() + cel.getClockOffset()).toISOString(),
                  logger,
                  schemaRegistry,
                  tracer,
                  scriptRegistry: input.dsl.scriptRegistry,
                  openapi,
                  nextSequenceVersion: (aggregateId) => {
                    const delta = stagedSeqDeltas.get(aggregateId) ?? 0;
                    const next = eventStore.currentSequenceVersion(aggregateId) + delta + 1;
                    // Eagerly advance the delta so that multiple events emitted within a single
                    // runPatternMatch call (e.g. emit_when multi-match) each get a unique,
                    // monotonically-increasing sequence version.
                    stagedSeqDeltas.set(aggregateId, delta + 1);
                    return next;
                  },
                  projectToShadow: (event) =>
                    projectEvent({
                      event,
                      boundary,
                      graph: shadowAsGraphAdapter,
                      cel,
                      logger,
                      schemaRegistry,
                      tracer,
                      openapi,
                      ...(input.tsReducerRegistry ? { tsReducerRegistry: input.tsReducerRegistry } : {}),
                      ...(() => {
                        const inf = input.inferredSchemas?.[boundary.boundary];
                        return inf && inf.computedOrder.length > 0
                          ? { computed: input.dsl.byBoundaryName[boundary.boundary]?.state?.computed ?? [], computedOrder: inf.computedOrder }
                          : {};
                      })(),
                    }),
                });
              } catch (err) {
                const code =
                  err instanceof Error ? (err as { code?: string }).code ?? err.message : String(err);
                logger.warn({ err, code, commandId: cmd.commandId }, 'UoW aborted');
                // Note: uowAbortsTotal is incremented by the outer catch block, which covers
                // all error types including ConcurrencyConflictError and MissingPreconditionError.
                throw err;
              }

              // Accumulate staged events, then fire reactions for each.
              // Note: stagedSeqDeltas is already updated eagerly by nextSequenceVersion
              // (called inside runPatternMatch), so we do NOT update it again here.
              //
              // Reaction fan-out: after each event is staged (and already projected
              // to shadow by runPatternMatch), consult the reaction registry.
              // Reaction-emitted events are themselves eligible to trigger further
              // reactions — we process them via a local work queue so the same
              // per-event reaction check handles recursive fan-out.
              //
              // Termination (R4):
              //  - firedReactions (declared per-UoW above): Set of
              //    "<reactionId>@<aggregateId>" keys. A given (reaction, aggregate)
              //    pair fires at most once per UoW; duplicates (including cycles, and
              //    cycles spanning secondary-command boundaries) are silently
              //    suppressed by fireReactions because the Set is shared across every
              //    cascade command in this UoW.
              //  - reactionEventCount (per-UoW above) bounds total reaction fan-out
              //    against the event budget.
              //  - Reactions do NOT increment cmd.depth and are not bounded by maxDepth;
              //    they run entirely within their own reactionWorkQueue.
              const shadowAsGraphAdapterForReactions = shadowAsStateGraph(shadow, graph);

              // Seed the queue with the events produced by runPatternMatch.
              const reactionWorkQueue: DomainEvent[] = [...matchOutcome.events];

              while (reactionWorkQueue.length > 0) {
                const evt = reactionWorkQueue.shift()!;

                // Stage this event (if it wasn't already from a prior iteration —
                // primary events are staged here; reaction events are also staged here).
                stagedEvents.push(evt);
                const evtLog = logger.child({ eventId: evt.eventId, aggregateId: evt.aggregateId });
                evtLog.debug({ eventType: evt.type }, 'UoW staged event');

                // Fire reactions for this event (if the DSL declares any and
                // reactions haven't been suppressed).
                if (dsl.reactionsByTrigger && input.controls?.sideEffects.skipDispatch !== true) {
                  const reactionEvents = fireReactions({
                    triggerEvent: evt,
                    dsl,
                    shadowGraph: shadowAsGraphAdapterForReactions,
                    cel,
                    nextEventId: () => nextUuidv7(),
                    now: () => new Date(Date.now() + cel.getClockOffset()).toISOString(),
                    nextSequenceVersion: (aggregateId) => {
                      const delta = stagedSeqDeltas.get(aggregateId) ?? 0;
                      const next = eventStore.currentSequenceVersion(aggregateId) + delta + 1;
                      stagedSeqDeltas.set(aggregateId, delta + 1);
                      return next;
                    },
                    firedReactions,
                    maxUowEvents: input.maxUowEvents,
                    currentReactionEventCount: reactionEventCount,
                    logger,
                    schemaRegistry,
                    tracer,
                    openapi,
                    tsReducerRegistry: input.tsReducerRegistry,
                    inferredSchemas: input.inferredSchemas,
                    scriptRegistry: input.dsl.scriptRegistry,
                  });

                  // Reaction-emitted events are already projected into shadow by fireReactions.
                  // Enqueue them so their own reactions can fire (recursive fan-out).
                  for (const rEvt of reactionEvents) {
                    reactionWorkQueue.push(rEvt);
                    reactionEventCount++;
                  }
                }
              }

              // Enqueue secondary commands for next iterations
              // Tier 2: skip-dispatch suppresses secondary commands entirely.
              if (input.controls?.sideEffects.skipDispatch !== true) {
                for (const sec of matchOutcome.secondaryCommands) {
                  pendingCommands.push(sec);
                }
              }
            },
            { 'uow.depth': cmd.depth, 'uow.boundary': cmd.boundary },
          );
        }

        // -----------------------------------------------------------------------
        // Step 7 — Commit phase
        // -----------------------------------------------------------------------
        const dryRun = input.controls?.transparency.dryRun === true;
        const skipProjections = input.controls?.sideEffects.skipProjections === true;
        const skipSagas = input.controls?.sideEffects.skipSagas === true;
        const skipWebhooks = input.controls?.sideEffects.skipWebhooks === true;

        // Tier 3: caused-by override — rewrite the (frozen) DomainEvents to carry the
        // overridden causedBy. Mutates the array in place before append.
        const causedByOverride = input.controls?.identity.causedBy;
        if (causedByOverride) {
          for (let i = 0; i < stagedEvents.length; i++) {
            const e = stagedEvents[i]!;
            stagedEvents[i] = Object.freeze({ ...e, causedBy: causedByOverride }) as DomainEvent;
          }
        }

        if (!dryRun) {
          eventStore.append(stagedEvents);
          metrics?.eventsAppendedTotal.add(stagedEvents.length, {
            boundary: command.boundary,
            ...tagAttrs,
          });
          shadow.commitInto(graph);
        }

        if (!dryRun && !skipProjections && input.derivedProjections && dsl.derivedProjections && dsl.derivedProjections.length > 0) {
          for (const evt of stagedEvents) {
            applyEventToDerivedProjections(
              evt,
              dsl.derivedProjections,
              input.derivedProjections,
              cel,
              logger,
            );
          }
        }

        // Post-commit side-effects (sagas + webhooks). These run AFTER commit and
        // are fire-and-forget so a failure is logged but never aborts the primary
        // response. Each is built as a thunk; under a bulk-transactional batch the
        // gateway supplies `deferSideEffects`, in which case we ENQUEUE the thunks
        // for the batch to flush on success (or discard on abort) rather than
        // firing them inline against state that may still be rolled back.
        if (!dryRun && stagedEvents.length > 0) {
          const sideEffects: SideEffectThunk[] = [];

          // Sagas run after commit so compensation events are truly
          // compensating, not pre-staged alongside the primary event.
          // Every committed event is offered — including reaction/dispatch events
          // on OTHER boundaries — and findTriggeredSagas matches on the event's
          // own boundary, so a saga keyed to a reaction's boundary fires too.
          if (!skipSagas && dsl.sagas && dsl.sagas.length > 0) {
            for (const evt of stagedEvents) {
              const triggeredSagas = findTriggeredSagas(dsl.sagas, command, evt, cel, logger);
              for (const saga of triggeredSagas) {
                sideEffects.push(() =>
                  runSaga({
                    saga,
                    triggerCommand: command,
                    triggerEvent: evt,
                    dsl,
                    graph,
                    events: eventStore,
                    cel,
                    validator,
                    logger,
                    schemaRegistry,
                    openapi,
                    // Thread the system's shared lock map so saga-step UoWs
                    // serialize against concurrent inbound requests on the same
                    // aggregate (defense-in-depth: the event store also rejects
                    // non-monotonic sequences, but the lock prevents the race
                    // that causes spurious saga-step failures).
                    ...(input.aggregateLocks ? { aggregateLocks: input.aggregateLocks } : {}),
                    ...(input.tsReducerRegistry ? { tsReducerRegistry: input.tsReducerRegistry } : {}),
                    ...(input.inferredSchemas ? { inferredSchemas: input.inferredSchemas } : {}),
                  }).catch((err: unknown) => {
                    logger.error({ err, sagaName: saga.name }, 'Saga execution failed unexpectedly');
                  }),
                );
              }
            }
          }

          // Outbound webhooks — match each committed event against the configured
          // subscriptions and dispatch a signed delivery via the injected transport.
          if (!skipWebhooks && input.webhookTransport && dsl.webhooks && dsl.webhooks.length > 0) {
            const transport = input.webhookTransport;
            for (const evt of stagedEvents) {
              for (const webhook of dsl.webhooks) {
                sideEffects.push(() =>
                  dispatchWebhook(webhook, evt, command, cel, transport, logger),
                );
              }
            }
          }

          for (const thunk of sideEffects) {
            // Bake the reset-epoch guard into every thunk at scheduling time so a
            // side-effect that straddles a reset (created pre-reset, run
            // post-reset) no-ops instead of appending orphan events. The guard is
            // captured here, so it protects BOTH the inline path and the deferred
            // queue path (the queue may flush long after this UoW returns).
            const guarded = withEpochGuard(thunk, input.resetEpoch, logger);
            if (input.deferSideEffects) {
              input.deferSideEffects.enqueue(guarded);
            } else {
              guarded().catch((err: unknown) => {
                logger.error({ err }, 'Post-commit side-effect failed unexpectedly');
              });
            }
          }
        }

        // -----------------------------------------------------------------------
        // Step 8 — Response construction
        // -----------------------------------------------------------------------
        let status: number;
        let body: JsonValue;

        if (command.intent === 'query') {
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
            openapi,
            logger,
            schemaRegistry,
            events: eventStore,
            tracer,
          });
          status = 200;
        } else if (command.intent === 'creation') {
          status = 201;
          // On dry-run, read from shadow (commit was skipped) so the response reflects
          // what would have been written.
          body = command.targetId !== null
            ? ((dryRun ? (shadow.get(command.targetId) ?? graph.get(command.targetId)) : graph.get(command.targetId)) ?? {})
            : {};
        } else {
          // mutation
          status = 200;
          body = command.targetId !== null
            ? ((dryRun ? (shadow.get(command.targetId) ?? graph.get(command.targetId)) : graph.get(command.targetId)) ?? {})
            : {};
        }

        // Validate the response body against the contract (throws InternalExecutionError on fail).
        // Tier 7 (admin-gated): X-Potemkin-Skip-Response-Validation bypasses the check
        // entirely; X-Potemkin-Allow-Additional-Properties relaxes the contract so a
        // response carrying undeclared properties still validates.
        //
        // A sparse-fieldset query (?fields=a,b) deliberately projects each entity down to a
        // subset of its properties, so the response intentionally omits schema-required fields
        // and cannot satisfy the strict entity schema. Skip response validation in that case;
        // projectFields already guarantees a well-formed object (id is always preserved).
        const isSparseFieldset =
          command.intent === 'query' && command.queryParams['fields'] !== undefined;
        if (
          input.controls?.validation.skipResponseValidation !== true &&
          !isSparseFieldset
        ) {
          validator.validateResponse(command.httpMethod, command.path, status, body, {
            allowAdditionalProperties: input.controls?.validation.allowAdditionalProperties === true,
          });
        }

        outcome = 'success';

        const elapsedMs = Date.now() - startMs;
        metrics?.commandDurationMs.record(elapsedMs, {
          boundary: command.boundary,
          intent: command.intent,
          outcome,
          ...tagAttrs,
        });

        return {
          status,
          body,
          headers: undefined,
          events: stagedEvents,
        } satisfies ExecutionResult;
      } catch (err) {
        // Increment uowAbortsTotal for ANY exception that aborts the UoW,
        // not just PatternMatch failures (covers ConcurrencyConflictError,
        // MissingPreconditionError, etc.). The inner catch inside the cascade span
        // handles pattern-match-specific logging; this outer catch ensures
        // the metric is always incremented on abort.
        metrics?.uowAbortsTotal.add(1, { boundary: command.boundary, ...tagAttrs });
        if (outcome === 'error') {
          const elapsedMs = Date.now() - startMs;
          metrics?.commandDurationMs.record(elapsedMs, {
            boundary: command.boundary,
            intent: command.intent,
            outcome: 'abort',
            ...tagAttrs,
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

// ---------------------------------------------------------------------------
// Webhook dispatch
// ---------------------------------------------------------------------------

/**
 * Match a single committed event against one webhook subscription and, on a
 * match, deliver a signed POST via the injected transport. The event boundary +
 * the triggering command's intent are used for trigger matching. Never throws —
 * delivery outcome is logged; fire-and-forget callers ignore the result.
 */
async function dispatchWebhook(
  webhook: WebhookConfig,
  event: DomainEvent,
  command: Command,
  cel: CelEvaluator,
  transport: FetchLike,
  logger: Logger,
): Promise<void> {
  const delivery = prepareWebhookDelivery(webhook, event, event.boundary, command.intent, cel);
  if (delivery === null) return;

  const result = await deliverWebhook(delivery, transport, webhook.retry);
  if (result.delivered) {
    logger.debug(
      { webhook: webhook.name, eventId: event.eventId, attempts: result.attempts },
      'Webhook delivered',
    );
  } else {
    logger.warn(
      { webhook: webhook.name, eventId: event.eventId, attempts: result.attempts, lastStatus: result.lastStatus },
      'Webhook delivery failed',
    );
  }
}
