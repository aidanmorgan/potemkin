import type { Command, DomainEvent, JsonObject, JsonValue } from '../types.js';
import type { BoundaryConfig } from '../dsl/types.js';
import type { ShadowGraph } from '../stategraph/shadow.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { Logger } from '../observability/logger.js';
import type { ObjectGraphSchemaRegistry } from '../schema/types.js';
import { CelPhase } from '../cel/phases.js';
import { getTracer, withSpan } from '../observability/tracing.js';
import {
  EntityAbsenceError,
  EntityConflictError,
  UnhandledOperationError,
  InternalExecutionError,
} from '../errors.js';

export interface PatternMatchInput {
  readonly command: Command;
  readonly boundary: BoundaryConfig;
  readonly shadow: ShadowGraph;
  readonly cel: CelEvaluator;
  readonly nextEventId: () => string;
  readonly now: () => string;
  /** Optional logger for pattern evaluation traces. */
  readonly logger?: Logger;
  /** Optional schema registry for validating state paths in pattern conditions. */
  readonly schemaRegistry?: ObjectGraphSchemaRegistry;
  /**
   * [ADDITIVE] Callback to obtain the next monotonic sequence version for an aggregate.
   * The UoW supplies this, accounting for already-staged events in this UoW.
   */
  readonly nextSequenceVersion: (aggregateId: string) => number;
  /**
   * [ADDITIVE] Callback to project a domain event into the shadow graph immediately after
   * staging, ensuring causal consistency for subsequent rule evaluations within the same UoW.
   * The UoW supplies this so the pattern matcher doesn't need a direct reference to the
   * projection engine (avoids a circular import path).
   */
  readonly projectToShadow: (event: DomainEvent) => void;
}

export interface PatternMatchOutcome {
  /** Events staged during this match (primary and any fallback generic event). */
  readonly events: readonly DomainEvent[];
  /** Secondary commands queued for cascading execution inside the UoW. */
  readonly secondaryCommands: readonly Command[];
  /** Post-match shadow state for the target aggregate, or null if deleted/absent. */
  readonly state: JsonObject | null;
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
  return withSpanSync(getTracer('engine'), 'engine.patternMatch', () => {
    return _runPatternMatch(input);
  });
}

function _runPatternMatch(input: PatternMatchInput): PatternMatchOutcome {
  const { command, boundary, shadow, cel, nextEventId, now, logger, nextSequenceVersion, projectToShadow } = input;
  const log = logger?.child({ component: 'patternMatcher', commandId: command.commandId, boundary: command.boundary });

  // Step 1: Context Assembly
  const existingState = command.targetId != null ? shadow.get(command.targetId) : null;

  if (command.targetId != null) {
    if (command.intent === 'mutation' && existingState === null) {
      log?.debug({ targetId: command.targetId }, 'Entity absent for mutation intent');
      throw new EntityAbsenceError(
        `Entity '${command.targetId}' not found in boundary '${boundary.boundary}'`,
        { targetId: command.targetId, boundary: boundary.boundary },
      );
    }
    if (command.intent === 'creation' && existingState !== null) {
      log?.debug({ targetId: command.targetId }, 'Entity already exists for creation intent');
      throw new EntityConflictError(
        `Entity '${command.targetId}' already exists in boundary '${boundary.boundary}'`,
        { targetId: command.targetId, boundary: boundary.boundary },
      );
    }
  }

  // Step 2: Evaluation Loop — first-match resolution
  for (const behavior of boundary.behaviors) {
    if (behavior.match.intent !== command.intent) {
      log?.debug({ behaviorName: behavior.name, behaviorIntent: behavior.match.intent, commandIntent: command.intent }, 'Skipping behavior — intent mismatch');
      continue;
    }

    const celCtx = {
      command: command as unknown as Record<string, unknown>,
      state: existingState ?? {},
      payload: command.payload,
    };

    log?.debug({ behaviorName: behavior.name }, 'Evaluating behavior condition');

    let matched: boolean;
    try {
      const result = cel.evaluate(behavior.match.condition, celCtx, CelPhase.Behavior);
      matched = result === true;
    } catch (err) {
      log?.debug({ behaviorName: behavior.name, err }, 'Behavior condition evaluation error — treating as no-match');
      matched = false;
    }

    if (!matched) {
      log?.debug({ behaviorName: behavior.name }, 'Behavior condition evaluated to false');
      continue;
    }

    log?.info({ behaviorName: behavior.name, emit: behavior.emit }, 'Behavior matched');

    // Look up event catalog entry
    const catalogEntry = boundary.eventCatalog.find(e => e.type === behavior.emit);
    if (!catalogEntry) {
      throw new InternalExecutionError(`Unknown emit reference '${behavior.emit}' in boundary '${boundary.boundary}'`, {
        emit: behavior.emit,
        boundary: boundary.boundary,
      });
    }

    // Determine aggregateId
    let aggregateId: string;
    if (command.targetId != null) {
      aggregateId = command.targetId;
    } else if (command.intent === 'creation') {
      // Auto-generate via identity config
      const generateExpr = boundary.identity?.creation?.generate;
      if (generateExpr) {
        const generated = cel.evaluate(generateExpr, celCtx, CelPhase.EventHydration);
        if (typeof generated !== 'string' || !generated) {
          throw new InternalExecutionError('Identity generation expression did not produce a non-empty string', {
            generateExpr,
          });
        }
        aggregateId = generated;
      } else {
        aggregateId = nextEventId();
      }
    } else {
      // collection-level non-creation — use commandId as a stable key
      aggregateId = command.commandId;
    }

    const eventId = nextEventId();

    // Evaluate payload template
    const payloadCtx = {
      command: command as unknown as Record<string, unknown>,
      state: shadow.get(aggregateId) ?? {},
      payload: command.payload,
    };
    const eventPayload: JsonObject = {};
    for (const [field, expr] of Object.entries(catalogEntry.payloadTemplate)) {
      const value = cel.evaluate(expr, payloadCtx, CelPhase.EventHydration);
      eventPayload[field] = value as JsonValue;
    }

    const sequenceVersion = nextSequenceVersion(aggregateId);

    const domainEvent: DomainEvent = {
      eventId,
      boundary: command.boundary,
      aggregateId,
      type: catalogEntry.type,
      payload: eventPayload,
      timestamp: now(),
      sequenceVersion,
      causedBy: command.commandId,
    };

    log?.debug({ eventId, eventType: catalogEntry.type, aggregateId }, 'Domain event constructed');

    // Immediately project into shadow for causal consistency
    projectToShadow(domainEvent);

    // Build secondary commands
    const secondaryCommands: Command[] = [];
    if (behavior.dispatchCommands) {
      const postProjectionState = shadow.get(aggregateId) ?? {};
      const dispatchCtx = {
        command: command as unknown as Record<string, unknown>,
        state: postProjectionState,
        payload: command.payload,
        event: domainEvent,
      };

      for (const spec of behavior.dispatchCommands) {
        const targetIdVal = cel.evaluate(spec.targetId, dispatchCtx, CelPhase.Behavior);
        const resolvedTargetId = typeof targetIdVal === 'string' ? targetIdVal : null;

        const secondaryPayload: JsonObject = {};
        if (spec.payload) {
          for (const [field, expr] of Object.entries(spec.payload)) {
            const val = cel.evaluate(expr, dispatchCtx, CelPhase.Behavior);
            secondaryPayload[field] = val as JsonValue;
          }
        }

        const secondaryCommand: Command = {
          commandId: nextEventId(),
          boundary: spec.boundary,
          intent: spec.intent,
          targetId: resolvedTargetId,
          payload: secondaryPayload,
          queryParams: {},
          httpMethod: spec.intent === 'creation' ? 'POST' : 'PUT',
          path: '',
          origin: 'secondary',
          depth: command.depth + 1,
        };

        secondaryCommands.push(secondaryCommand);
        log?.debug({ secondaryCommandId: secondaryCommand.commandId, boundary: spec.boundary }, 'Secondary command queued');
      }
    }

    const finalState = shadow.get(aggregateId);

    return {
      events: [domainEvent],
      secondaryCommands,
      state: finalState,
    };
  }

  // Step 3: Fallback Evaluation
  if (boundary.fallbackOverride) {
    if (command.intent === 'query') {
      // Per req 33: query with fallback_override returns the current State Graph node directly
      const aggregateId = command.targetId;
      if (aggregateId === null) {
        // Collection-level query with no behaviors matched — return empty
        return {
          events: [],
          secondaryCommands: [],
          state: null,
        };
      }
      const state = shadow.get(aggregateId);
      if (state === null) {
        throw new EntityAbsenceError(
          `Entity '${aggregateId}' not found in boundary '${boundary.boundary}'`,
          { targetId: aggregateId, boundary: boundary.boundary },
        );
      }
      log?.info({ intent: command.intent, aggregateId }, 'No behavior matched query — returning current state via fallback');
      return {
        events: [],
        secondaryCommands: [],
        state,
      };
    }

    log?.info({ intent: command.intent }, 'No behavior matched — applying GenericUpdateEvent fallback');

    const aggregateId = command.targetId ?? command.commandId;
    const eventId = nextEventId();
    const sequenceVersion = nextSequenceVersion(aggregateId);

    const genericEvent: DomainEvent = {
      eventId,
      boundary: command.boundary,
      aggregateId,
      type: 'System.GenericUpdateEvent',
      payload: command.payload,
      timestamp: now(),
      sequenceVersion,
      causedBy: command.commandId,
    };

    projectToShadow(genericEvent);

    const finalState = shadow.get(aggregateId);

    return {
      events: [genericEvent],
      secondaryCommands: [],
      state: finalState,
    };
  }

  // Step 4: No match, no fallback
  log?.debug({ intent: command.intent, boundary: boundary.boundary }, 'No behavior matched and no fallback — throwing UnhandledOperationError');
  throw new UnhandledOperationError(
    `No matching behavior for command '${command.intent}' in boundary '${boundary.boundary}'`,
    { intent: command.intent, boundary: boundary.boundary, commandId: command.commandId },
  );
}

/**
 * Synchronous wrapper around `withSpan` for use when the implementation is synchronous.
 * `withSpan` is async, but our pattern matcher logic is sync — we wrap the result.
 */
function withSpanSync<T>(
  tracer: Parameters<typeof withSpan>[0],
  name: string,
  fn: () => T,
): T {
  // We use the sync tracer.startActiveSpan API directly here so we don't force
  // the public function to be async when the whole call chain is sync.
  const { trace, context, SpanStatusCode } = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
  const t = trace.getTracer('engine');
  let result!: T;
  let threw = false;
  let thrownErr: unknown;
  t.startActiveSpan(name, (span) => {
    try {
      result = fn();
    } catch (err) {
      threw = true;
      thrownErr = err;
      if (err instanceof Error) span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
    } finally {
      span.end();
    }
  });
  if (threw) throw thrownErr;
  return result;
}
