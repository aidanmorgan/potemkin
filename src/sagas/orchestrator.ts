/**
 * Saga Orchestrator — REQ-73 through REQ-80
 *
 * ## Atomicity choice: post-commit compensation
 *
 * Sagas run AFTER the primary UoW commit.  The primary event (e.g. LoanOpened)
 * is committed first so the aggregate exists when downstream steps run.
 * If step N fails, compensation handlers for steps N-1 … 0 are dispatched in
 * reverse order as compensating commands, each generating their own compensating
 * events.  This means:
 *  - The primary event is always durable.
 *  - Compensation is "best-effort": if a compensation handler itself throws,
 *    a `SagaCompensationFailed` saga event is recorded but the chain continues.
 *
 * Rationale: within-UoW atomicity (staging everything before commit) would mean
 * compensation events are staged before any step actually executes, which is
 * semantically incorrect.  Post-commit compensation matches the standard Saga
 * pattern (a sequence of local transactions with compensating transactions).
 *
 * ## Saga event log
 *
 * Saga lifecycle events are stored in the EventStore under boundary `__saga__`
 * with the sagaInstanceId as aggregateId:
 *  - SagaStarted
 *  - SagaStepCompleted
 *  - SagaStepFailed
 *  - SagaCompensated
 *  - SagaCompensationFailed
 *  - SagaCompleted
 *  - SagaFailed
 */

import type { DomainEvent, Command, Intent, JsonObject, JsonValue } from '../types.js';
import type { SagaConfig } from '../dsl/types.js';
import type { TsReducerRegistry } from '../engine/tsReducerRegistry.js';
import type { BoundaryInferenceResult } from '../dsl/schemaInference.js';
import type { EventStore } from '../eventstore/store.js';
import type { StateGraph } from '../stategraph/graph.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { ContractValidator } from '../contract/validator.js';
import type { CompiledDsl } from '../dsl/types.js';
import type { Logger } from '../observability/logger.js';
import type { ObjectGraphSchemaRegistry } from '../schema/types.js';
import type { OpenApiDoc } from '../contract/loader.js';
import { executeUnitOfWork } from '../engine/uow.js';
import { nextUuidv7 } from '../ids/uuidv7.js';
import { CelPhase } from '../cel/phases.js';

const SAGA_BOUNDARY = '__saga__';

export interface SagaRunInput {
  readonly saga: SagaConfig;
  /** The triggering command (used to build step payloads via CEL context). */
  readonly triggerCommand: Command;
  /** The primary domain event emitted by the trigger. */
  readonly triggerEvent: DomainEvent;
  readonly dsl: CompiledDsl;
  readonly graph: StateGraph;
  readonly events: EventStore;
  readonly cel: CelEvaluator;
  readonly validator: ContractValidator;
  readonly logger?: Logger;
  readonly schemaRegistry?: ObjectGraphSchemaRegistry;
  readonly openapi?: OpenApiDoc;
  /** C3: TS-reducer registry threaded into saga-step units of work. */
  readonly tsReducerRegistry?: TsReducerRegistry;
  /** C5: per-boundary inferred schemas threaded into saga-step units of work. */
  readonly inferredSchemas?: Readonly<Record<string, BoundaryInferenceResult>>;
  /**
   * Per-BootedSystem aggregate lock map. When supplied, every saga-step
   * executeUnitOfWork call serializes on the SAME map as live gateway requests,
   * so a concurrent inbound request and an in-flight saga step targeting the
   * same aggregate cannot interleave. Omitting it (e.g. in unit tests that mock
   * executeUnitOfWork) creates a fresh no-op map per step.
   */
  readonly aggregateLocks?: Map<string, Promise<void>>;
}

function makeSagaEvent(
  sagaInstanceId: string,
  type: string,
  payload: JsonObject,
  events: EventStore,
  now: () => string,
): DomainEvent {
  const seqVersion = events.currentSequenceVersion(sagaInstanceId) + 1;
  const evt: DomainEvent = {
    eventId: nextUuidv7(),
    boundary: SAGA_BOUNDARY,
    aggregateId: sagaInstanceId,
    type,
    payload,
    timestamp: now(),
    sequenceVersion: seqVersion,
    causedBy: null,
  };
  events.append([evt]);
  return evt;
}

/**
 * Extended intent that includes 'deletion' for saga steps/compensations.
 * The base Intent union covers creation/mutation/query; saga steps may also
 * carry 'deletion' to produce a DELETE-method command (potemkin-v2pu).
 */
type SagaIntent = Intent | 'deletion';

/**
 * Evaluate CEL expressions in a step's payload/targetId against the trigger context.
 */
function evalStepContext(
  cel: CelEvaluator,
  expr: string,
  celCtx: Record<string, unknown>,
): JsonValue {
  const result = cel.evaluate(expr, celCtx, CelPhase.Behavior);
  return result as JsonValue;
}

/** Map a saga step intent to the appropriate HTTP method. */
function intentToHttpMethod(intent: SagaIntent): string {
  switch (intent) {
    case 'creation':
      return 'POST';
    case 'deletion':
      return 'DELETE';
    default:
      return 'PUT';
  }
}

type StepSpec = {
  intent: SagaIntent;
  operationId: string;
  targetId?: string;
  payload?: Record<string, string>;
  boundary?: string;
};

function buildStepCommand(
  step: StepSpec,
  boundary: string,
  cel: CelEvaluator,
  celCtx: Record<string, unknown>,
  parentCommand: Command,
): Command {
  let targetId: string | null = null;
  if (step.targetId) {
    const resolved = evalStepContext(cel, step.targetId, celCtx);
    targetId = typeof resolved === 'string' ? resolved : null;
  }

  const payload: JsonObject = {};
  if (step.payload) {
    for (const [field, expr] of Object.entries(step.payload)) {
      payload[field] = evalStepContext(cel, expr, celCtx);
    }
  }

  return {
    commandId: nextUuidv7(),
    boundary,
    intent: step.intent as Intent,
    operationId: step.operationId,
    targetId,
    payload,
    queryParams: {},
    httpMethod: intentToHttpMethod(step.intent),
    path: '',
    origin: 'secondary',
    depth: parentCommand.depth + 1,
    actor: parentCommand.actor,
  };
}

/**
 * Run a saga instance triggered by a primary event.
 *
 * This function is called AFTER the primary UoW has committed.
 */
export async function runSaga(input: SagaRunInput): Promise<void> {
  const {
    saga,
    triggerCommand,
    triggerEvent,
    dsl,
    graph,
    events,
    cel,
    validator,
    logger,
    schemaRegistry,
    openapi,
    tsReducerRegistry,
    inferredSchemas,
    aggregateLocks,
  } = input;

  const sagaInstanceId = nextUuidv7();
  const log = logger?.child({ component: 'saga', sagaName: saga.name, sagaInstanceId });
  const now = (): string => new Date(Date.now() + cel.getClockOffset()).toISOString();

  // Build CEL context from trigger.
  // `steps` is populated after each step completes so subsequent steps can
  // reference prior results via `steps.<name>.body`, `steps.<name>.status`,
  // etc.  `prevStep` always points to the most-recently-completed step result.
  const stepsAccumulator: Record<string, unknown> = {};
  const celCtx: Record<string, unknown> = {
    command: triggerCommand as unknown as Record<string, unknown>,
    event: triggerEvent as unknown as Record<string, unknown>,
    payload: triggerCommand.payload,
    state: triggerCommand.targetId ? graph.get(triggerCommand.targetId) ?? {} : {},
    steps: stepsAccumulator,
    prevStep: null,
  };

  makeSagaEvent(sagaInstanceId, 'SagaStarted', {
    sagaName: saga.name,
    triggeredBy: triggerCommand.commandId,
    triggerEventId: triggerEvent.eventId,
  }, events, now);

  log?.info({ step: 'start' }, 'Saga started');

  const completedSteps: number[] = [];

  for (let i = 0; i < saga.steps.length; i++) {
    const step = saga.steps[i];
    log?.debug({ stepIndex: i, stepName: step.name }, 'Executing saga step');

    try {
      const stepCommand = buildStepCommand(step, step.boundary, cel, celCtx, triggerCommand);

      const stepResult = await executeUnitOfWork({
        command: stepCommand,
        dsl,
        graph,
        events,
        cel,
        validator,
        logger,
        schemaRegistry,
        openapi,
        ...(aggregateLocks ? { aggregateLocks } : {}),
        ...(tsReducerRegistry ? { tsReducerRegistry } : {}),
        ...(inferredSchemas ? { inferredSchemas } : {}),
      });

      // Accumulate step result so subsequent steps can reference it via CEL.
      const stepSummary = { status: stepResult.status, body: stepResult.body };
      stepsAccumulator[step.name] = stepSummary;
      celCtx.prevStep = stepSummary;

      completedSteps.push(i);
      makeSagaEvent(sagaInstanceId, 'SagaStepCompleted', {
        sagaName: saga.name,
        stepIndex: i,
        stepName: step.name,
      }, events, now);

      log?.debug({ stepIndex: i, stepName: step.name }, 'Saga step completed');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.warn({ stepIndex: i, stepName: step.name, err }, 'Saga step failed — running compensation');

      makeSagaEvent(sagaInstanceId, 'SagaStepFailed', {
        sagaName: saga.name,
        stepIndex: i,
        stepName: step.name,
        error: errMsg,
      }, events, now);

      // Run compensation handlers in reverse order for completed steps
      for (let j = completedSteps.length - 1; j >= 0; j--) {
        const completedIdx = completedSteps[j];
        const completedStep = saga.steps[completedIdx];
        if (!completedStep.compensation) continue;

        log?.debug({ compensatingStep: completedIdx, stepName: completedStep.name }, 'Running compensation');

        try {
          const compensation = completedStep.compensation;
          const compBoundary = completedStep.boundary;
          const compCommand = buildStepCommand(
            {
              intent: compensation.intent,
              operationId: compensation.operationId,
              targetId: compensation.targetId ?? completedStep.targetId,
              payload: compensation.payload,
            },
            compBoundary,
            cel,
            celCtx,
            triggerCommand,
          );

          await executeUnitOfWork({
            command: compCommand,
            dsl,
            graph,
            events,
            cel,
            validator,
            logger,
            schemaRegistry,
            openapi,
            ...(aggregateLocks ? { aggregateLocks } : {}),
            ...(tsReducerRegistry ? { tsReducerRegistry } : {}),
            ...(inferredSchemas ? { inferredSchemas } : {}),
          });

          makeSagaEvent(sagaInstanceId, 'SagaCompensated', {
            sagaName: saga.name,
            compensatedStepIndex: completedIdx,
            compensatedStepName: completedStep.name,
          }, events, now);

          log?.debug({ compensatedStep: completedIdx }, 'Compensation completed');
        } catch (compErr) {
          const compErrMsg = compErr instanceof Error ? compErr.message : String(compErr);
          log?.error({ compensatedStep: completedIdx, err: compErr }, 'Compensation handler failed');

          // REQ-80: do not abort compensation chain on compensation failure
          makeSagaEvent(sagaInstanceId, 'SagaCompensationFailed', {
            sagaName: saga.name,
            compensatedStepIndex: completedIdx,
            error: compErrMsg,
          }, events, now);
        }
      }

      makeSagaEvent(sagaInstanceId, 'SagaFailed', {
        sagaName: saga.name,
        failedAtStep: i,
        error: errMsg,
      }, events, now);

      log?.warn({ saga: saga.name }, 'Saga failed with compensation');
      return;
    }
  }

  makeSagaEvent(sagaInstanceId, 'SagaCompleted', {
    sagaName: saga.name,
    stepsCompleted: saga.steps.length,
  }, events, now);

  log?.info({ saga: saga.name }, 'Saga completed successfully');
}

/**
 * Check whether any sagas are triggered by the given primary event and command.
 * Returns matching sagas.
 */
export function findTriggeredSagas(
  sagas: readonly SagaConfig[] | undefined,
  triggerCommand: Command,
  triggerEvent: DomainEvent,
  cel: CelEvaluator,
  logger?: Logger,
): SagaConfig[] {
  if (!sagas || sagas.length === 0) return [];

  const log = logger?.child({ component: 'saga' });
  const matched: SagaConfig[] = [];
  const celCtx: Record<string, unknown> = {
    command: triggerCommand as unknown as Record<string, unknown>,
    event: triggerEvent as unknown as Record<string, unknown>,
    payload: triggerCommand.payload,
  };

  for (const saga of sagas) {
    const { trigger } = saga;
    if (trigger.boundary !== triggerCommand.boundary) continue;
    if (trigger.intent !== triggerCommand.intent) continue;

    try {
      const result = cel.evaluate(trigger.condition, celCtx, CelPhase.Behavior);
      if (result === true) {
        matched.push(saga);
      }
    } catch (err) {
      // A throwing trigger condition is treated as no-match, but surfaced so a
      // malformed condition does not silently prevent a saga from ever firing.
      log?.warn(
        { sagaName: saga.name, condition: trigger.condition, err },
        'Saga trigger condition evaluation failed — treating as no-match',
      );
    }
  }

  return matched;
}
