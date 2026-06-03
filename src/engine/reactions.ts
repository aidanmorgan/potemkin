/**
 * In-UoW reaction firing engine — R3.
 *
 * Consults the reaction registry for rules matching a just-staged event, evaluates
 * each rule's `when` gate, hydrates the emitted event from the reacting boundary's
 * event_catalog (same path as behaviour-emitted events), and returns the new events
 * so the UoW can stage + project them through the same queue.
 *
 * Deterministic ordering (R5 will finalise): reactions for a single trigger event
 * are sorted by reacting boundary name ascending, then by declaration index.
 * This is noted here for replay correctness; see TODO potemkin-atbe.
 *
 * Termination (R4): this increment imposes a per-UoW staged-event ceiling of
 * MAX_UOW_REACTIONS_BUDGET (1000). Exceeding it throws InternalExecutionError.
 * TODO(potemkin-gpdk): replace with fired-set dedup + configurable budget so
 *   reactions are exempt from the dispatch depth cap.
 */

import type { DomainEvent, JsonObject, JsonValue } from '../types.js';
import type { CompiledDsl, ReactionRule } from '../dsl/types.js';
import type { BoundaryConfig } from '../dsl/types.js';
import type { StateGraph } from '../stategraph/graph.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { Logger } from '../observability/logger.js';
import type { ObjectGraphSchemaRegistry } from '../schema/types.js';
import type { Tracer } from '../observability/tracing.js';
import type { OpenApiDoc } from '../contract/loader.js';
import type { TsReducerRegistry } from './tsReducerRegistry.js';
import type { BoundaryInferenceResult } from '../dsl/schemaInference.js';

import { CelPhase } from '../cel/phases.js';
import { InternalExecutionError } from '../errors.js';
import { projectEvent } from './projection.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Temporary per-UoW ceiling on total staged events (primary + dispatched + reactions).
 * If this is exceeded an InternalExecutionError is thrown to prevent infinite loops.
 * TODO(potemkin-gpdk): replace with fired-set dedup + configurable budget.
 */
export const MAX_UOW_REACTIONS_BUDGET = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FireReactionsInput {
  /** The event that was just staged and projected. */
  readonly triggerEvent: DomainEvent;
  /** Compiled DSL — supplies the reaction registry and boundary configs. */
  readonly dsl: CompiledDsl;
  /** Shadow-graph adapter (reads from shadow, falls back to global). */
  readonly shadowGraph: StateGraph;
  readonly cel: CelEvaluator;
  readonly nextEventId: () => string;
  readonly now: () => string;
  readonly nextSequenceVersion: (aggregateId: string) => number;
  /** How many events have already been staged in this UoW (budget check). */
  readonly currentStagedCount: number;
  readonly logger?: Logger;
  readonly schemaRegistry?: ObjectGraphSchemaRegistry;
  readonly tracer?: Tracer;
  readonly openapi?: OpenApiDoc;
  readonly tsReducerRegistry?: TsReducerRegistry;
  readonly inferredSchemas?: Readonly<Record<string, BoundaryInferenceResult>>;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fire all reactions matching `triggerEvent` and return the newly emitted events.
 *
 * The caller is responsible for:
 *  - pushing the returned events onto `stagedEvents`
 *  - feeding them back into the same reaction-check loop (recursive fan-out)
 *
 * This function only fires reactions for the single given trigger event. It does NOT
 * recursively process the reactions it produces — that is the caller's responsibility
 * (the UoW work queue handles this).
 */
export function fireReactions(input: FireReactionsInput): readonly DomainEvent[] {
  const { triggerEvent, dsl, cel, logger } = input;

  if (!dsl.reactionsByTrigger) return [];

  const log = logger?.child({
    component: 'reactions',
    triggerEventId: triggerEvent.eventId,
    triggerEventType: triggerEvent.type,
    triggerBoundary: triggerEvent.boundary,
  });

  // Look up reactions by both qualified "Boundary:EventType" and bare "EventType"
  const qualifiedKey = `${triggerEvent.boundary}:${triggerEvent.type}`;
  const bareKey = triggerEvent.type;

  const qualifiedBucket = dsl.reactionsByTrigger.get(qualifiedKey) ?? [];
  const bareBucket = dsl.reactionsByTrigger.get(bareKey) ?? [];

  // Union: qualified + bare, deduped by reference identity (a rule can only appear
  // in one bucket since registry keys are disjoint for qualified vs bare).
  const allMatchingReactions: readonly ReactionRule[] = [...qualifiedBucket, ...bareBucket];

  if (allMatchingReactions.length === 0) return [];

  // Deterministic ordering: sort by reacting boundary name ascending, then by
  // original declaration index within each boundary bucket.
  // NOTE(R5/potemkin-atbe): R5 will finalise the ordering spec. For now we sort
  // the union by boundary name, then preserve the registry insertion order within
  // each boundary group (which corresponds to declaration order — guaranteed by
  // buildReactionRegistry in parser.ts).
  const sorted = [...allMatchingReactions].sort((a, b) => {
    const ba = a.boundary ?? '';
    const bb = b.boundary ?? '';
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  });

  const emittedEvents: DomainEvent[] = [];

  // CEL context for when/target/payload evaluations
  const celCtx = {
    event: triggerEvent as unknown as Record<string, unknown>,
    payload: triggerEvent.payload as unknown as Record<string, unknown>,
  };

  for (const reaction of sorted) {
    // Budget check before attempting to fire each reaction
    const totalSoFar = input.currentStagedCount + emittedEvents.length;
    if (totalSoFar >= MAX_UOW_REACTIONS_BUDGET) {
      throw new InternalExecutionError(
        `Reaction budget exceeded: more than ${MAX_UOW_REACTIONS_BUDGET} events staged in a single UoW. ` +
        `Last reaction: "${reaction.name ?? reaction.on}" on boundary "${reaction.boundary}". ` +
        `TODO(potemkin-gpdk): implement fired-set dedup + configurable budget.`,
        {
          code: 'REACTION_BUDGET_EXCEEDED',
          budget: MAX_UOW_REACTIONS_BUDGET,
          reaction: reaction.name ?? reaction.on,
          boundary: reaction.boundary ?? null,
        },
      );
    }

    const reactingBoundaryName = reaction.boundary!;
    const reactingBoundary = dsl.byBoundaryName[reactingBoundaryName];
    if (!reactingBoundary) {
      // Should have been caught at boot (R2 validation), but be defensive
      throw new InternalExecutionError(
        `Reaction references unknown boundary "${reactingBoundaryName}"`,
        { reaction: reaction.name ?? reaction.on, boundary: reactingBoundaryName },
      );
    }

    // Step 1: Evaluate when gate
    if (reaction.when !== undefined) {
      let gateResult: unknown;
      try {
        gateResult = cel.evaluate(reaction.when, celCtx, CelPhase.Behavior);
      } catch (err) {
        // A throwing when gate aborts the UoW (reaction errors are fatal)
        throw new InternalExecutionError(
          `Reaction "${reaction.name ?? reaction.on}" when gate threw: ${err instanceof Error ? err.message : String(err)}`,
          { code: 'REACTION_GATE_ERROR', reaction: reaction.name ?? reaction.on, when: reaction.when },
        );
      }
      if (gateResult !== true) {
        log?.debug({ reaction: reaction.name ?? reaction.on }, 'Reaction when gate false — skipping');
        continue;
      }
    }

    log?.debug({ reaction: reaction.name ?? reaction.on, reactingBoundary: reactingBoundaryName }, 'Reaction gate passed — firing');

    // Step 2: Resolve target aggregate id
    const intent = reaction.intent ?? 'mutation';
    let aggregateId: string;

    if (reaction.target !== undefined) {
      let targetVal: unknown;
      try {
        targetVal = cel.evaluate(reaction.target, celCtx, CelPhase.Behavior);
      } catch (err) {
        throw new InternalExecutionError(
          `Reaction "${reaction.name ?? reaction.on}" target expression threw: ${err instanceof Error ? err.message : String(err)}`,
          { code: 'REACTION_TARGET_ERROR', reaction: reaction.name ?? reaction.on, target: reaction.target },
        );
      }
      if (typeof targetVal !== 'string' || !targetVal) {
        throw new InternalExecutionError(
          `Reaction "${reaction.name ?? reaction.on}" target expression did not produce a non-empty string`,
          { code: 'REACTION_TARGET_ERROR', reaction: reaction.name ?? reaction.on, target: reaction.target, got: String(targetVal) },
        );
      }
      aggregateId = targetVal;
    } else if (intent === 'creation') {
      // No target for creation: generate via the reacting boundary's identity.creation.generate
      const generateExpr = reactingBoundary.identity?.creation?.generate;
      if (generateExpr) {
        const generated = cel.evaluate(generateExpr, celCtx, CelPhase.EventHydration);
        if (typeof generated !== 'string' || !generated) {
          throw new InternalExecutionError(
            `Reaction "${reaction.name ?? reaction.on}" identity generation did not produce a non-empty string`,
            { code: 'REACTION_TARGET_ERROR', reaction: reaction.name ?? reaction.on, generateExpr },
          );
        }
        aggregateId = generated;
      } else {
        aggregateId = input.nextEventId();
      }
    } else {
      throw new InternalExecutionError(
        `Reaction "${reaction.name ?? reaction.on}" has intent "mutation" but no target expression`,
        { code: 'REACTION_TARGET_ERROR', reaction: reaction.name ?? reaction.on },
      );
    }

    // Step 3: Evaluate payload overrides (CEL map merged over payload_template)
    const payloadOverrides: JsonObject = {};
    if (reaction.payload) {
      for (const [field, expr] of Object.entries(reaction.payload)) {
        let val: unknown;
        try {
          val = cel.evaluate(expr, celCtx, CelPhase.Behavior);
        } catch (err) {
          throw new InternalExecutionError(
            `Reaction "${reaction.name ?? reaction.on}" payload field "${field}" threw: ${err instanceof Error ? err.message : String(err)}`,
            { code: 'REACTION_PAYLOAD_ERROR', reaction: reaction.name ?? reaction.on, field, expr },
          );
        }
        payloadOverrides[field] = val as JsonValue;
      }
    }

    // Step 4: Hydrate the emitted event from the reacting boundary's event_catalog
    const emittedEvent = hydrateReactionEvent({
      reaction,
      reactingBoundary,
      aggregateId,
      payloadOverrides,
      triggerEvent,
      cel,
      nextEventId: input.nextEventId,
      now: input.now,
      nextSequenceVersion: input.nextSequenceVersion,
      shadowGraph: input.shadowGraph,
      logger: log,
    });

    // Step 5: Project the emitted event into the shadow graph via the reacting boundary's reducers
    const shadowGraphAdapter = input.shadowGraph;
    projectEvent({
      event: emittedEvent,
      boundary: reactingBoundary,
      graph: shadowGraphAdapter,
      cel,
      logger: input.logger,
      schemaRegistry: input.schemaRegistry,
      tracer: input.tracer,
      openapi: input.openapi,
      ...(input.tsReducerRegistry ? { tsReducerRegistry: input.tsReducerRegistry } : {}),
      ...(() => {
        const inf = input.inferredSchemas?.[reactingBoundaryName];
        return inf && inf.computedOrder.length > 0
          ? {
              computed: dsl.byBoundaryName[reactingBoundaryName]?.state?.computed ?? [],
              computedOrder: inf.computedOrder,
            }
          : {};
      })(),
    });

    emittedEvents.push(emittedEvent);
    log?.debug(
      { emittedEventId: emittedEvent.eventId, emittedEventType: emittedEvent.type, aggregateId },
      'Reaction emitted event staged',
    );
  }

  return emittedEvents;
}

// ---------------------------------------------------------------------------
// Hydration helper
// ---------------------------------------------------------------------------

interface HydrateReactionEventInput {
  readonly reaction: ReactionRule;
  readonly reactingBoundary: BoundaryConfig;
  readonly aggregateId: string;
  readonly payloadOverrides: JsonObject;
  readonly triggerEvent: DomainEvent;
  readonly cel: CelEvaluator;
  readonly nextEventId: () => string;
  readonly now: () => string;
  readonly nextSequenceVersion: (aggregateId: string) => number;
  readonly shadowGraph: StateGraph;
  readonly logger?: Logger;
}

/**
 * Hydrate a reaction-emitted event from the reacting boundary's event_catalog entry.
 *
 * The payload_template is evaluated in EventHydration phase against
 * `{ event: triggerEvent, payload: triggerEvent.payload }` — the same context that
 * when/target/payload use. The reaction's `payload` overrides are merged on top.
 *
 * Uses the same hydration path as behaviour-emitted events in runPatternMatch.
 */
function hydrateReactionEvent(input: HydrateReactionEventInput): DomainEvent {
  const {
    reaction,
    reactingBoundary,
    aggregateId,
    payloadOverrides,
    triggerEvent,
    cel,
    nextEventId,
    now,
    nextSequenceVersion,
    shadowGraph,
    logger,
  } = input;

  const catalogEntry = reactingBoundary.eventCatalog.find(e => e.type === reaction.emit);
  if (!catalogEntry) {
    throw new InternalExecutionError(
      `Reaction "${reaction.name ?? reaction.on}" emit event type "${reaction.emit}" not found in boundary "${reactingBoundary.boundary}" event_catalog`,
      { code: 'REACTION_EMIT_UNKNOWN', reaction: reaction.name ?? reaction.on, emit: reaction.emit, boundary: reactingBoundary.boundary },
    );
  }

  const eventId = nextEventId();

  // Build the hydration CEL context using the trigger event and the current
  // shadow state of the reacting aggregate.
  const payloadTemplateCtx = {
    event: triggerEvent as unknown as Record<string, unknown>,
    payload: triggerEvent.payload as unknown as Record<string, unknown>,
    state: shadowGraph.get(aggregateId) ?? {},
  };

  // Hydrate payload_template in EventHydration phase (same as runPatternMatch)
  const eventPayload: JsonObject = {};
  for (const [field, expr] of Object.entries(catalogEntry.payloadTemplate)) {
    let value: unknown;
    try {
      value = cel.evaluate(expr, payloadTemplateCtx, CelPhase.EventHydration);
    } catch (err) {
      throw new InternalExecutionError(
        `Reaction "${reaction.name ?? reaction.on}" payload_template field "${field}" threw: ${err instanceof Error ? err.message : String(err)}`,
        { code: 'REACTION_PAYLOAD_ERROR', reaction: reaction.name ?? reaction.on, field, expr },
      );
    }
    eventPayload[field] = value as JsonValue;
  }

  // Merge reaction payload overrides on top of the hydrated template
  for (const [field, val] of Object.entries(payloadOverrides)) {
    eventPayload[field] = val;
  }

  const sequenceVersion = nextSequenceVersion(aggregateId);

  const domainEvent: DomainEvent = Object.freeze({
    eventId,
    boundary: reactingBoundary.boundary,
    aggregateId,
    type: catalogEntry.type,
    payload: eventPayload,
    timestamp: now(),
    sequenceVersion,
    causedBy: triggerEvent.eventId,
  });

  logger?.debug(
    { eventId, eventType: catalogEntry.type, aggregateId, boundary: reactingBoundary.boundary },
    'Reaction domain event hydrated',
  );

  return domainEvent;
}
