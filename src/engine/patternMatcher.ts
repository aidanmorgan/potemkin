import type { Command, DomainEvent, JsonObject, JsonValue } from '../types.js';
import type { BoundaryConfig } from '../dsl/types.js';
import type { ShadowGraph } from '../stategraph/shadow.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { Logger } from '../observability/logger.js';
import type { Tracer } from '../observability/tracing.js';
import type { ObjectGraphSchemaRegistry } from '../schema/types.js';
import type { ScriptRegistry, ScriptContext } from '../scripts/types.js';
import { CelPhase } from '../cel/phases.js';

import { getTracer, SpanStatusCode } from '../observability/tracing.js';
import {
  EntityAbsenceError,
  EntityConflictError,
  UnhandledOperationError,
  InternalExecutionError,
} from '../errors.js';
import { matchHeadersAnd } from './headerMatch.js';
import { checkScopes } from '../identity/scopeChecker.js';
import { lookupOperationId } from '../contract/loader.js';
import type { OpenApiDoc } from '../contract/loader.js';
import { matchRoute } from '../contract/router.js';
import { nextUuidv7 } from '../ids/uuidv7.js';
import { deepClone, deepMerge } from '../stategraph/graph.js';

const TS_SENTINEL = 'ts:';

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
   * Callback to obtain the next monotonic sequence version for an aggregate.
   * The UoW supplies this, accounting for already-staged events in this UoW.
   */
  readonly nextSequenceVersion: (aggregateId: string) => number;
  /**
   * OpenAPI document used to resolve the request's operationId from (path, method).
   * Behaviors are dispatched by matching match.operationId against this resolved id.
   */
  readonly openapi: OpenApiDoc;
  /**
   * Callback to project a domain event into the shadow graph immediately after
   * staging, ensuring causal consistency for subsequent rule evaluations within the same UoW.
   * The UoW supplies this so the pattern matcher doesn't need a direct reference to the
   * projection engine (avoids a circular import path).
   */
  readonly projectToShadow: (event: DomainEvent) => void;
  /**
   * Optional tracer for the engine.patternMatch span. When provided, the span is emitted
   * via this tracer (enabling injection by UoW for testability). Falls back to
   * getTracer('engine') when absent.
   */
  readonly tracer?: Tracer;
  /** Optional script registry for ts: sentinel resolution. */
  readonly scriptRegistry?: ScriptRegistry;
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
  return withSpanSync('engine.patternMatch', () => _runPatternMatch(input), input.tracer);
}

// ---------------------------------------------------------------------------
// Helper: evaluate a CEL or ts: expression
// ---------------------------------------------------------------------------

export function evaluateExpr(
  expr: string,
  celCtx: Record<string, unknown>,
  phase: CelPhase,
  cel: CelEvaluator,
  scriptRegistry: ScriptRegistry | undefined,
  boundary: string,
  scriptCtxBuilder: () => ScriptContext,
): unknown {
  if (expr.startsWith(TS_SENTINEL)) {
    // Defense-in-depth: ts: refs are forbidden in the Reducer phase.
    if (phase === CelPhase.Reducer) {
      throw new InternalExecutionError(
        `ts: sentinel "${expr}" reached Reducer phase — this is forbidden`,
        { code: 'SCRIPT_IN_REDUCER_PHASE', expr },
      );
    }
    const scriptName = expr.slice(TS_SENTINEL.length);
    if (!scriptRegistry) {
      throw new InternalExecutionError(
        `ts: sentinel "${expr}" used but no script registry available`,
        { code: 'SCRIPT_EXECUTION_FAILED', scriptName },
      );
    }
    const handle = scriptRegistry.get(boundary, scriptName);
    if (!handle) {
      throw new InternalExecutionError(
        `Script "${scriptName}" not found in registry for boundary "${boundary}"`,
        { code: 'SCRIPT_EXECUTION_FAILED', scriptName, boundary },
      );
    }
    return handle.fn(scriptCtxBuilder());
  }
  return cel.evaluate(expr, celCtx, phase);
}

function _runPatternMatch(input: PatternMatchInput): PatternMatchOutcome {
  const { command, boundary, shadow, cel, nextEventId, now, logger, nextSequenceVersion, projectToShadow, scriptRegistry, openapi } = input;
  const log = logger?.child({ component: 'patternMatcher', commandId: command.commandId, boundary: command.boundary });

  // Resolve the request's operationId. Secondary (cascade) commands carry an explicit
  // operationId (their path is synthetic). Inbound commands resolve it from (path,
  // method): the command path is a concrete URL, so resolve the templated contract path
  // first, then look up its operationId. No resolvable operationId means the route is
  // not in the OpenAPI contract → 404 (the gateway normally screens this earlier).
  let operationId: string | undefined = command.operationId;
  if (operationId === undefined) {
    const route = matchRoute(openapi, command.httpMethod, command.path);
    operationId = route ? lookupOperationId(openapi, route.contractPath, command.httpMethod) : undefined;
  }
  if (operationId === undefined) {
    log?.debug({ path: command.path, method: command.httpMethod }, 'No operationId resolved for request — route not in OpenAPI contract');
    throw new EntityAbsenceError(
      `No OpenAPI operation matches ${command.httpMethod} ${command.path}`,
      { method: command.httpMethod, path: command.path, boundary: boundary.boundary },
    );
  }

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

  // Step 2: Evaluation Loop — first-match resolution.
  // operationId selects the candidate behavior; match.condition (below) narrows further.
  for (const behavior of boundary.behaviors) {
    if (behavior.match.operationId !== operationId) {
      log?.debug({ behaviorName: behavior.name, behaviorOperationId: behavior.match.operationId, operationId }, 'Skipping behavior — operationId mismatch');
      continue;
    }

    // Header matching: all declared headers must match (AND semantics).
    // Name lookup is case-insensitive; '*' and 'present' are any-value sentinels.
    if (behavior.match.headers && Object.keys(behavior.match.headers).length > 0) {
      if (!matchHeadersAnd(behavior.match.headers, command.headers ?? {})) {
        log?.debug({ behaviorName: behavior.name }, 'Skipping behavior — header match failed');
        continue;
      }
    }

    const celCtx = {
      command: command as unknown as Record<string, unknown>,
      state: existingState ?? {},
      payload: command.payload,
    };

    const buildScriptCtx = (): ScriptContext => ({
      command,
      state: existingState,
      payload: command.payload as JsonObject,
      helpers: {
        uuid: () => nextUuidv7(),
        now: input.now,
        deepClone: <T>(v: T) => deepClone(v as JsonValue) as unknown as T,
        deepMerge: (a: JsonObject, b: JsonObject) => deepMerge(a, b),
      },
      logger: log ?? logger ?? ({ child: () => ({} as Logger), info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Logger),
    });

    // RBAC scope check runs before requires[] and match.condition.
    if (behavior.match.requiredScopes && behavior.match.requiredScopes.length > 0) {
      // throws AuthenticationRequiredError (401) or AuthorizationDeniedError (403)
      checkScopes(command.actor, behavior.match.requiredScopes, behavior.name);
    }

    // Evaluate requires[] FIRST (before match.condition)
    if (behavior.match.requires && behavior.match.requires.length > 0) {
      for (const req of behavior.match.requires) {
        let condResult: unknown;
        try {
          condResult = evaluateExpr(
            req.condition, celCtx, CelPhase.Behavior, cel, scriptRegistry,
            boundary.boundary, buildScriptCtx,
          );
        } catch (err) {
          if (err instanceof InternalExecutionError || req.condition.startsWith(TS_SENTINEL)) {
            throw new InternalExecutionError(
              `Requires condition "${req.name}" script failed for behavior "${behavior.name}": ${err instanceof Error ? err.message : String(err)}`,
              { code: 'SCRIPT_EXECUTION_FAILED', behavior: behavior.name, requirement: req.name },
            );
          }
          // Genuine CEL evaluation/parse miss — treat as failed requirement
          condResult = false;
          log?.debug({ behaviorName: behavior.name, requiresName: req.name, err }, 'Requires condition evaluation error');
        }

        if (condResult !== true) {
          log?.info({ behaviorName: behavior.name, requiresName: req.name }, 'Requires guard failed — returning 422');
          throw new UnhandledOperationError(
            req.errorMessage || `Precondition "${req.name}" failed`,
            {
              code: req.errorCode || 'PRECONDITION_FAILED',
              message: req.errorMessage,
              requirement: req.name,
            },
          );
        }
      }
    }

    log?.debug({ behaviorName: behavior.name }, 'Evaluating behavior condition');

    let matched: boolean;
    try {
      const result = evaluateExpr(
        behavior.match.condition, celCtx, CelPhase.Behavior, cel, scriptRegistry,
        boundary.boundary, buildScriptCtx,
      );
      matched = result === true;
    } catch (err) {
      if (err instanceof InternalExecutionError || behavior.match.condition.startsWith(TS_SENTINEL)) {
        throw new InternalExecutionError(
          `Behavior condition script failed for behavior "${behavior.name}": ${err instanceof Error ? err.message : String(err)}`,
          { code: 'SCRIPT_EXECUTION_FAILED', behavior: behavior.name },
        );
      }
      // Genuine CEL evaluation/parse miss — treat as no-match
      log?.debug({ behaviorName: behavior.name, err }, 'Behavior condition evaluation error — treating as no-match');
      matched = false;
    }

    if (!matched) {
      log?.debug({ behaviorName: behavior.name }, 'Behavior condition evaluated to false');
      continue;
    }

    // Determine aggregateId (needed for payload template evaluation)
    let aggregateId: string;
    if (command.targetId != null) {
      aggregateId = command.targetId;
    } else if (command.intent === 'creation') {
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
      aggregateId = command.commandId;
    }

    // -----------------------------------------------------------------------
    // Emit resolution: emit (single) or emit_when (conditional multi-emit)
    // -----------------------------------------------------------------------
    // If emit is present, fire it unconditionally. Then process emit_when entries.
    const allStagedEvents: DomainEvent[] = [];

    // Helper to emit a single event by catalog type
    const emitEventByType = (eventType: string, currentAggId: string): DomainEvent => {
      const catalogEntry = boundary.eventCatalog.find(e => e.type === eventType);
      if (!catalogEntry) {
        throw new InternalExecutionError(`Unknown emit reference '${eventType}' in boundary '${boundary.boundary}'`, {
          emit: eventType,
          boundary: boundary.boundary,
        });
      }

      const eventId = nextEventId();
      // Use current shadow state for payload context
      const payloadCtx = {
        command: command as unknown as Record<string, unknown>,
        state: shadow.get(currentAggId) ?? {},
        payload: command.payload,
      };

      const buildPayloadScriptCtx = (): ScriptContext => ({
        command,
        state: shadow.get(currentAggId),
        payload: command.payload as JsonObject,
        helpers: {
          uuid: () => nextUuidv7(),
          now: input.now,
          deepClone: <T>(v: T) => deepClone(v as JsonValue) as unknown as T,
          deepMerge: (a: JsonObject, b: JsonObject) => deepMerge(a, b),
        },
        logger: log ?? logger ?? ({ child: () => ({} as Logger), info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Logger),
      });

      const eventPayload: JsonObject = {};
      for (const [field, expr] of Object.entries(catalogEntry.payloadTemplate)) {
        const value = evaluateExpr(
          expr, payloadCtx, CelPhase.EventHydration, cel, scriptRegistry,
          boundary.boundary, buildPayloadScriptCtx,
        );
        eventPayload[field] = value as JsonValue;
      }

      const sequenceVersion = nextSequenceVersion(currentAggId);

      const requestSnapshot = {
        method: command.httpMethod,
        path: command.path,
        query: command.queryParams,
        headers: command.headers ?? {},
        payload: command.payload,
        ...(command.actor !== undefined
          ? { actorId: command.actor.id, actorScopes: command.actor.scopes }
          : {}),
      };

      const domainEvent: DomainEvent = {
        eventId,
        boundary: command.boundary,
        aggregateId: currentAggId,
        type: catalogEntry.type,
        payload: eventPayload,
        timestamp: now(),
        sequenceVersion,
        causedBy: command.commandId,
        request: requestSnapshot,
      };

      log?.debug({ eventId, eventType: catalogEntry.type, aggregateId: currentAggId }, 'Domain event constructed');

      // Immediately project into shadow for causal consistency
      projectToShadow(domainEvent);

      return domainEvent;
    };

    // Fire unconditional `emit` (if present)
    if (behavior.emit !== undefined) {
      log?.info({ behaviorName: behavior.name, emit: behavior.emit }, 'Behavior matched — emitting');
      const evt = emitEventByType(behavior.emit, aggregateId);
      allStagedEvents.push(evt);
    }

    // Process emit_when entries (after shadow is updated by unconditional emit)
    if (behavior.emitWhen && behavior.emitWhen.length > 0) {
      log?.info({ behaviorName: behavior.name }, 'Behavior matched — processing emit_when');
      for (const ewEntry of behavior.emitWhen) {
        // Evaluate when condition against CURRENT shadow state
        const emitWhenCtx = {
          command: command as unknown as Record<string, unknown>,
          state: shadow.get(aggregateId) ?? {},
          payload: command.payload,
        };
        const buildEmitWhenScriptCtx = (): ScriptContext => ({
          command,
          state: shadow.get(aggregateId),
          payload: command.payload as JsonObject,
          helpers: {
            uuid: () => nextUuidv7(),
            now: input.now,
            deepClone: <T>(v: T) => deepClone(v as JsonValue) as unknown as T,
            deepMerge: (a: JsonObject, b: JsonObject) => deepMerge(a, b),
          },
          logger: log ?? logger ?? ({ child: () => ({} as Logger), info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Logger),
        });

        let whenResult: unknown;
        try {
          whenResult = evaluateExpr(
            ewEntry.when, emitWhenCtx, CelPhase.Behavior, cel, scriptRegistry,
            boundary.boundary, buildEmitWhenScriptCtx,
          );
        } catch (err) {
          if (err instanceof InternalExecutionError || ewEntry.when.startsWith(TS_SENTINEL)) {
            throw new InternalExecutionError(
              `emit_when condition script failed for behavior "${behavior.name}": ${err instanceof Error ? err.message : String(err)}`,
              { code: 'SCRIPT_EXECUTION_FAILED', behavior: behavior.name, when: ewEntry.when },
            );
          }
          // Genuine CEL evaluation/parse miss — skip this emit_when entry
          log?.debug({ behaviorName: behavior.name, when: ewEntry.when, err }, 'emit_when condition error');
          whenResult = false;
        }

        if (whenResult === true) {
          log?.debug({ behaviorName: behavior.name, emit: ewEntry.emit }, 'emit_when matched');
          const evt = emitEventByType(ewEntry.emit, aggregateId);
          allStagedEvents.push(evt);
        }
      }
    }

    // Evaluate postcondition AFTER projection
    if (behavior.postcondition !== undefined) {
      const postState = shadow.get(aggregateId);
      const postCtx = {
        command: command as unknown as Record<string, unknown>,
        state: postState ?? {},
        event: allStagedEvents.length > 0
          ? (allStagedEvents[0] as unknown as Record<string, unknown>)
          : {},
        payload: command.payload,
      };
      const buildPostScriptCtx = (): ScriptContext => ({
        command,
        state: postState,
        event: allStagedEvents[0],
        payload: command.payload as JsonObject,
        helpers: {
          uuid: () => nextUuidv7(),
          now: input.now,
          deepClone: <T>(v: T) => deepClone(v as JsonValue) as unknown as T,
          deepMerge: (a: JsonObject, b: JsonObject) => deepMerge(a, b),
        },
        logger: log ?? logger ?? ({ child: () => ({} as Logger), info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Logger),
      });

      let postResult: unknown;
      try {
        postResult = evaluateExpr(
          behavior.postcondition, postCtx, CelPhase.Behavior, cel, scriptRegistry,
          boundary.boundary, buildPostScriptCtx,
        );
      } catch (err) {
        throw new InternalExecutionError(
          `Postcondition evaluation failed for behavior "${behavior.name}": ${err instanceof Error ? err.message : String(err)}`,
          { code: 'POSTCONDITION_VIOLATED', behavior: behavior.name, expression: behavior.postcondition },
        );
      }

      if (postResult !== true) {
        log?.warn({ behaviorName: behavior.name, postcondition: behavior.postcondition }, 'Postcondition violated');
        throw new InternalExecutionError(
          `Postcondition violated for behavior "${behavior.name}"`,
          { code: 'POSTCONDITION_VIOLATED', behavior: behavior.name, expression: behavior.postcondition },
        );
      }
    }

    // Build secondary commands
    const secondaryCommands: Command[] = [];
    if (behavior.dispatchCommands) {
      const postProjectionState = shadow.get(aggregateId) ?? {};
      const dispatchCtx = {
        command: command as unknown as Record<string, unknown>,
        state: postProjectionState,
        payload: command.payload,
        event: allStagedEvents.length > 0
          ? (allStagedEvents[0] as unknown as Record<string, unknown>)
          : {},
      };
      const buildDispatchScriptCtx = (): ScriptContext => ({
        command,
        state: postProjectionState,
        event: allStagedEvents[0],
        payload: command.payload as JsonObject,
        helpers: {
          uuid: () => nextUuidv7(),
          now: input.now,
          deepClone: <T>(v: T) => deepClone(v as JsonValue) as unknown as T,
          deepMerge: (a: JsonObject, b: JsonObject) => deepMerge(a, b),
        },
        logger: log ?? logger ?? ({ child: () => ({} as Logger), info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Logger),
      });

      for (const spec of behavior.dispatchCommands) {
        // Evaluate condition if present; skip on false
        if (spec.condition !== undefined) {
          let condResult: unknown;
          try {
            condResult = evaluateExpr(
              spec.condition, dispatchCtx, CelPhase.Behavior, cel, scriptRegistry,
              boundary.boundary, buildDispatchScriptCtx,
            );
          } catch (err) {
            if (err instanceof InternalExecutionError || spec.condition.startsWith(TS_SENTINEL)) {
              throw new InternalExecutionError(
                `dispatch_commands condition script failed for behavior "${behavior.name}": ${err instanceof Error ? err.message : String(err)}`,
                { code: 'SCRIPT_EXECUTION_FAILED', behavior: behavior.name, condition: spec.condition },
              );
            }
            // Genuine CEL evaluation/parse miss — skip this secondary command
            log?.debug({ condition: spec.condition, err }, 'dispatch_commands condition error — skipping');
            condResult = false;
          }
          if (condResult !== true) {
            log?.debug({ condition: spec.condition }, 'dispatch_commands condition false — skipping');
            continue;
          }
        }

        const targetIdVal = evaluateExpr(
          spec.targetId, dispatchCtx, CelPhase.Behavior, cel, scriptRegistry,
          boundary.boundary, buildDispatchScriptCtx,
        );
        const resolvedTargetId = typeof targetIdVal === 'string' ? targetIdVal : null;

        if (spec.intent === 'mutation' && (typeof targetIdVal !== 'string' || !targetIdVal)) {
          throw new InternalExecutionError(
            `dispatch_commands entry for operation "${spec.operationId}" has intent "mutation" but target_id did not resolve to a non-empty string`,
            { code: 'REACTION_TARGET_ERROR', operationId: spec.operationId, got: String(targetIdVal) },
          );
        }

        const secondaryPayload: JsonObject = {};
        if (spec.payload) {
          for (const [field, expr] of Object.entries(spec.payload)) {
            const val = evaluateExpr(
              expr, dispatchCtx, CelPhase.Behavior, cel, scriptRegistry,
              boundary.boundary, buildDispatchScriptCtx,
            );
            secondaryPayload[field] = val as JsonValue;
          }
        }

        const secondaryCommand: Command = {
          commandId: nextEventId(),
          boundary: spec.boundary,
          intent: spec.intent,
          operationId: spec.operationId,
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
      events: allStagedEvents,
      secondaryCommands,
      state: finalState,
    };
  }

  // Step 3: Fallback Evaluation
  if (boundary.fallbackOverride) {
    if (command.intent === 'query') {
      // Query with fallback_override returns the current State Graph node directly.
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

    // On DELETE, attach soft-delete markers to the merge payload.
    const isDelete = command.httpMethod === 'DELETE';
    const eventPayload: JsonObject = isDelete
      ? { ...command.payload, _deleted: true, _deletedAt: now() }
      : command.payload;

    const genericEvent: DomainEvent = {
      eventId,
      boundary: command.boundary,
      aggregateId,
      type: 'System.GenericUpdateEvent',
      payload: eventPayload,
      timestamp: now(),
      sequenceVersion,
      causedBy: command.commandId,
      request: {
        method: command.httpMethod,
        path: command.path,
        query: command.queryParams,
        headers: command.headers ?? {},
        payload: command.payload,
        ...(command.actor !== undefined
          ? { actorId: command.actor.id, actorScopes: command.actor.scopes }
          : {}),
      },
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
 * Synchronous wrapper that starts an active span, runs `fn`, ends the span, then
 * re-throws any error. Accepts an optional injected tracer for testability;
 * falls back to getTracer('engine') when absent.
 */
function withSpanSync<T>(
  name: string,
  fn: () => T,
  injectedTracer?: Tracer,
): T {
  const tracer = injectedTracer ?? getTracer('engine');
  let result!: T;
  let threw = false;
  let thrownErr: unknown;
  tracer.startActiveSpan(name, (span) => {
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
