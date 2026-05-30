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

import type { DomainEvent, Command, JsonObject, JsonValue } from '../types.js';
import type { SagaConfig, SagaStep } from '../dsl/types.js';
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
  readonly tsReducerRegistry?: import('../engine/tsReducerRegistry.js').TsReducerRegistry;
}

function makeSagaEvent(
  sagaInstanceId: string,
  type: string,
  payload: JsonObject,
  events: EventStore,
): DomainEvent {
  const seqVersion = events.currentSequenceVersion(sagaInstanceId) + 1;
  const evt: DomainEvent = {
    eventId: nextUuidv7(),
    boundary: SAGA_BOUNDARY,
    aggregateId: sagaInstanceId,
    type,
    payload,
    timestamp: new Date().toISOString(),
    sequenceVersion: seqVersion,
    causedBy: null,
  };
  events.append([evt]);
  return evt;
}

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

function buildStepCommand(
  step: SagaStep | { intent: SagaStep['intent']; operationId: string; targetId?: string; payload?: Record<string, string>; boundary?: string },
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
    intent: step.intent,
    operationId: step.operationId,
    targetId,
    payload,
    queryParams: {},
    httpMethod: step.intent === 'creation' ? 'POST' : 'PUT',
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
  } = input;

  const sagaInstanceId = nextUuidv7();
  const log = logger?.child({ component: 'saga', sagaName: saga.name, sagaInstanceId });

  // Build CEL context from trigger
  const celCtx: Record<string, unknown> = {
    command: triggerCommand as unknown as Record<string, unknown>,
    event: triggerEvent as unknown as Record<string, unknown>,
    payload: triggerCommand.payload,
    state: triggerCommand.targetId ? graph.get(triggerCommand.targetId) ?? {} : {},
  };

  makeSagaEvent(sagaInstanceId, 'SagaStarted', {
    sagaName: saga.name,
    triggeredBy: triggerCommand.commandId,
    triggerEventId: triggerEvent.eventId,
  }, events);

  log?.info({ step: 'start' }, 'Saga started');

  const completedSteps: number[] = [];

  for (let i = 0; i < saga.steps.length; i++) {
    const step = saga.steps[i];
    log?.debug({ stepIndex: i, stepName: step.name }, 'Executing saga step');

    try {
      const stepCommand = buildStepCommand(step, step.boundary, cel, celCtx, triggerCommand);

      await executeUnitOfWork({
        command: stepCommand,
        dsl,
        graph,
        events,
        cel,
        validator,
        logger,
        schemaRegistry,
        openapi,
        ...(tsReducerRegistry ? { tsReducerRegistry } : {}),
      });

      completedSteps.push(i);
      makeSagaEvent(sagaInstanceId, 'SagaStepCompleted', {
        sagaName: saga.name,
        stepIndex: i,
        stepName: step.name,
      }, events);

      log?.debug({ stepIndex: i, stepName: step.name }, 'Saga step completed');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.warn({ stepIndex: i, stepName: step.name, err }, 'Saga step failed — running compensation');

      makeSagaEvent(sagaInstanceId, 'SagaStepFailed', {
        sagaName: saga.name,
        stepIndex: i,
        stepName: step.name,
        error: errMsg,
      }, events);

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
            ...(tsReducerRegistry ? { tsReducerRegistry } : {}),
          });

          makeSagaEvent(sagaInstanceId, 'SagaCompensated', {
            sagaName: saga.name,
            compensatedStepIndex: completedIdx,
            compensatedStepName: completedStep.name,
          }, events);

          log?.debug({ compensatedStep: completedIdx }, 'Compensation completed');
        } catch (compErr) {
          const compErrMsg = compErr instanceof Error ? compErr.message : String(compErr);
          log?.error({ compensatedStep: completedIdx, err: compErr }, 'Compensation handler failed');

          // REQ-80: do not abort compensation chain on compensation failure
          makeSagaEvent(sagaInstanceId, 'SagaCompensationFailed', {
            sagaName: saga.name,
            compensatedStepIndex: completedIdx,
            error: compErrMsg,
          }, events);
        }
      }

      makeSagaEvent(sagaInstanceId, 'SagaFailed', {
        sagaName: saga.name,
        failedAtStep: i,
        error: errMsg,
      }, events);

      log?.warn({ saga: saga.name }, 'Saga failed with compensation');
      return;
    }
  }

  makeSagaEvent(sagaInstanceId, 'SagaCompleted', {
    sagaName: saga.name,
    stepsCompleted: saga.steps.length,
  }, events);

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
): SagaConfig[] {
  if (!sagas || sagas.length === 0) return [];

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
    } catch {
      // CEL evaluation error → treat as no-match
    }
  }

  return matched;
}
