/**
 * REQ-73 through REQ-80: Saga orchestrator
 */
import { findTriggeredSagas, runSaga } from '../../../src/sagas/orchestrator';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { createEventStore } from '../../../src/eventstore/store';
import { createStateGraph } from '../../../src/stategraph/graph';
import type { SagaConfig } from '../../../src/dsl/types';
import type { Command, DomainEvent, ExecutionResult } from '../../../src/types';

jest.mock('../../../src/engine/uow', () => ({
  executeUnitOfWork: jest.fn(),
}));

// Imported after jest.mock so we get the mock instance.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeUnitOfWork } = require('../../../src/engine/uow') as {
  executeUnitOfWork: jest.Mock;
};

const cel = createCelEvaluator();

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    commandId: 'cmd-1',
    boundary: 'Lead',
    intent: 'creation',
    targetId: null,
    payload: { principal: 100000 },
    queryParams: {},
    httpMethod: 'POST',
    path: '/loans',
    origin: 'inbound',
    depth: 0,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    eventId: 'evt-1',
    boundary: 'Lead',
    aggregateId: 'loan-1',
    type: 'LeadCreated',
    payload: { principal: 100000 },
    timestamp: '2024-01-01T00:00:00.000Z',
    sequenceVersion: 1,
    causedBy: 'cmd-1',
    ...overrides,
  };
}

const loanApprovalSaga: SagaConfig = {
  name: 'LoanApproval',
  trigger: {
    boundary: 'Lead',
    intent: 'creation',
    condition: 'command.payload.principal > 50000',
  },
  steps: [
    {
      name: 'reserveCredit',
      boundary: 'CreditBureau',
      intent: 'mutation',
      operationId: 'reserveCredit',
      targetId: '"cust-1"',
      payload: { amount: 'command.payload.principal' },
      compensation: {
        intent: 'mutation',
        operationId: 'releaseCredit',
        payload: { release: 'command.payload.principal' },
      },
    },
  ],
};

describe('sagas/orchestrator - findTriggeredSagas', () => {
  it('returns matching saga when condition is met', () => {
    const cmd = makeCommand({ payload: { principal: 100000 } });
    const evt = makeEvent();
    const matched = findTriggeredSagas([loanApprovalSaga], cmd, evt, cel);
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe('LoanApproval');
  });

  it('returns empty array when condition is false', () => {
    const cmd = makeCommand({ payload: { principal: 10000 } }); // < 50000
    const evt = makeEvent();
    const matched = findTriggeredSagas([loanApprovalSaga], cmd, evt, cel);
    expect(matched).toHaveLength(0);
  });

  it('returns empty array when boundary does not match', () => {
    const cmd = makeCommand({ boundary: 'OtherBoundary' });
    const evt = makeEvent({ boundary: 'OtherBoundary' });
    const matched = findTriggeredSagas([loanApprovalSaga], cmd, evt, cel);
    expect(matched).toHaveLength(0);
  });

  it('returns empty array when intent does not match', () => {
    const cmd = makeCommand({ intent: 'mutation' });
    const evt = makeEvent();
    const matched = findTriggeredSagas([loanApprovalSaga], cmd, evt, cel);
    expect(matched).toHaveLength(0);
  });

  it('returns empty array when sagas is undefined', () => {
    const matched = findTriggeredSagas(undefined, makeCommand(), makeEvent(), cel);
    expect(matched).toHaveLength(0);
  });

  it('returns empty array when sagas is empty', () => {
    const matched = findTriggeredSagas([], makeCommand(), makeEvent(), cel);
    expect(matched).toHaveLength(0);
  });

  it('returns multiple matching sagas', () => {
    const saga2: SagaConfig = { ...loanApprovalSaga, name: 'AnotherSaga' };
    const cmd = makeCommand({ payload: { principal: 100000 } });
    const evt = makeEvent();
    const matched = findTriggeredSagas([loanApprovalSaga, saga2], cmd, evt, cel);
    expect(matched).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// runSaga — CEL context accumulation (potemkin-u2hb)
// ---------------------------------------------------------------------------

function makeRunSagaInput(saga: SagaConfig, cmdOverrides: Partial<Command> = {}) {
  const events = createEventStore();
  const graph = createStateGraph();
  const triggerCommand = makeCommand(cmdOverrides);
  const triggerEvent = makeEvent();
  return {
    saga,
    triggerCommand,
    triggerEvent,
    dsl: { boundaries: [], byBoundaryName: {}, scriptRegistry: {} } as never,
    graph,
    events,
    cel,
    validator: {} as never,
  };
}

describe('sagas/orchestrator - runSaga CEL context accumulation (potemkin-u2hb)', () => {
  beforeEach(() => {
    executeUnitOfWork.mockReset();
  });

  it('step 2 CEL payload expression can reference step 1 result via steps.<name>', async () => {
    // Step 1 returns a result with body containing creditId.
    // Step 2's targetId CEL expression references steps.reserveCredit.body.creditId.
    const step1Result: ExecutionResult = {
      status: 201,
      body: { creditId: 'credit-abc', amount: 5000 },
      events: [],
    };
    const step2Result: ExecutionResult = {
      status: 200,
      body: { ok: true },
      events: [],
    };
    executeUnitOfWork
      .mockResolvedValueOnce(step1Result)
      .mockResolvedValueOnce(step2Result);

    const twoStepSaga: SagaConfig = {
      name: 'TwoStepSaga',
      trigger: { boundary: 'Lead', intent: 'creation', condition: 'true' },
      steps: [
        {
          name: 'reserveCredit',
          boundary: 'CreditBureau',
          intent: 'creation',
          operationId: 'reserveCredit',
          payload: { amount: 'command.payload.principal' },
        },
        {
          name: 'bookLoan',
          boundary: 'Loan',
          intent: 'mutation',
          operationId: 'bookLoan',
          // References step 1's result body
          targetId: 'steps.reserveCredit.body.creditId',
          payload: { ref: 'steps.reserveCredit.body.creditId' },
        },
      ],
    };

    const input = makeRunSagaInput(twoStepSaga, { payload: { principal: 10000 } });
    await runSaga(input);

    expect(executeUnitOfWork).toHaveBeenCalledTimes(2);

    // The second call's command must have targetId resolved from step 1's result.
    const calls = executeUnitOfWork.mock.calls as Array<[{ command: Command }]>;
    expect(calls[1][0].command.targetId).toBe('credit-abc');
    expect(calls[1][0].command.payload).toMatchObject({ ref: 'credit-abc' });
  });

  it('step 2 CEL payload expression can reference step 1 result via prevStep', async () => {
    const step1Result: ExecutionResult = {
      status: 201,
      body: { id: 'obj-99' },
      events: [],
    };
    const step2Result: ExecutionResult = {
      status: 200,
      body: {},
      events: [],
    };
    executeUnitOfWork
      .mockResolvedValueOnce(step1Result)
      .mockResolvedValueOnce(step2Result);

    const saga: SagaConfig = {
      name: 'PrevStepSaga',
      trigger: { boundary: 'Lead', intent: 'creation', condition: 'true' },
      steps: [
        {
          name: 'createObj',
          boundary: 'Obj',
          intent: 'creation',
          operationId: 'createObj',
          payload: {},
        },
        {
          name: 'confirmObj',
          boundary: 'Obj',
          intent: 'mutation',
          operationId: 'confirmObj',
          targetId: 'prevStep.body.id',
          payload: {},
        },
      ],
    };

    const input = makeRunSagaInput(saga);
    await runSaga(input);

    const calls2 = executeUnitOfWork.mock.calls as Array<[{ command: Command }]>;
    expect(calls2[1][0].command.targetId).toBe('obj-99');
  });

  it('trigger context (command/event/payload) is preserved for all steps', async () => {
    const result: ExecutionResult = { status: 200, body: {}, events: [] };
    executeUnitOfWork.mockResolvedValue(result);

    const saga: SagaConfig = {
      name: 'TriggerCtxSaga',
      trigger: { boundary: 'Lead', intent: 'creation', condition: 'true' },
      steps: [
        {
          name: 'step1',
          boundary: 'X',
          intent: 'mutation',
          operationId: 'doX',
          payload: { amount: 'command.payload.principal' },
        },
        {
          name: 'step2',
          boundary: 'Y',
          intent: 'mutation',
          operationId: 'doY',
          payload: { amount: 'command.payload.principal' },
        },
      ],
    };

    const input = makeRunSagaInput(saga, { payload: { principal: 42 } });
    await runSaga(input);

    const calls = executeUnitOfWork.mock.calls as Array<[{ command: Command }]>;
    for (const [callInput] of calls) {
      expect(callInput.command.payload).toMatchObject({ amount: 42 });
    }
  });
});

// ---------------------------------------------------------------------------
// buildStepCommand httpMethod mapping (potemkin-v2pu)
// ---------------------------------------------------------------------------

describe('sagas/orchestrator - runSaga httpMethod mapping (potemkin-v2pu)', () => {
  beforeEach(() => {
    executeUnitOfWork.mockReset();
    executeUnitOfWork.mockResolvedValue({ status: 200, body: {}, events: [] });
  });

  it('creation-intent step produces httpMethod POST', async () => {
    const saga: SagaConfig = {
      name: 'CreationSaga',
      trigger: { boundary: 'Lead', intent: 'creation', condition: 'true' },
      steps: [
        {
          name: 'createStep',
          boundary: 'X',
          intent: 'creation',
          operationId: 'createX',
          payload: {},
        },
      ],
    };

    const input = makeRunSagaInput(saga);
    await runSaga(input);

    const [[callInput]] = executeUnitOfWork.mock.calls as Array<[{ command: Command }]>;
    expect(callInput.command.httpMethod).toBe('POST');
  });

  it('mutation-intent step produces httpMethod PUT', async () => {
    const saga: SagaConfig = {
      name: 'MutationSaga',
      trigger: { boundary: 'Lead', intent: 'creation', condition: 'true' },
      steps: [
        {
          name: 'updateStep',
          boundary: 'X',
          intent: 'mutation',
          operationId: 'updateX',
          targetId: '"x-1"',
          payload: {},
        },
      ],
    };

    const input = makeRunSagaInput(saga);
    await runSaga(input);

    const [[callInput]] = executeUnitOfWork.mock.calls as Array<[{ command: Command }]>;
    expect(callInput.command.httpMethod).toBe('PUT');
  });

  it('deletion-intent step produces httpMethod DELETE', async () => {
    const saga: SagaConfig = {
      name: 'DeletionSaga',
      trigger: { boundary: 'Lead', intent: 'creation', condition: 'true' },
      steps: [
        {
          name: 'deleteStep',
          boundary: 'X',
          // Cast: deletion is a valid runtime intent for saga steps even though
          // the base Intent union does not include it yet.
          intent: 'deletion' as never,
          operationId: 'deleteX',
          targetId: '"x-1"',
          payload: {},
        },
      ],
    };

    const input = makeRunSagaInput(saga);
    await runSaga(input);

    const [[callInput]] = executeUnitOfWork.mock.calls as Array<[{ command: Command }]>;
    expect(callInput.command.httpMethod).toBe('DELETE');
  });

  it('deletion-intent compensation produces httpMethod DELETE', async () => {
    // A creation step followed by failure triggers compensation with deletion intent.
    executeUnitOfWork
      .mockResolvedValueOnce({ status: 201, body: { id: 'x-1' }, events: [] })
      .mockRejectedValueOnce(new Error('step 2 failed'))
      .mockResolvedValueOnce({ status: 204, body: {}, events: [] }); // compensation

    const saga: SagaConfig = {
      name: 'CompensationDeletionSaga',
      trigger: { boundary: 'Lead', intent: 'creation', condition: 'true' },
      steps: [
        {
          name: 'createX',
          boundary: 'X',
          intent: 'creation',
          operationId: 'createX',
          payload: {},
          compensation: {
            // Compensating a creation means deleting the created resource.
            intent: 'deletion' as never,
            operationId: 'deleteX',
            targetId: '"x-1"',
          },
        },
        {
          name: 'failingStep',
          boundary: 'Y',
          intent: 'mutation',
          operationId: 'doY',
          targetId: '"y-1"',
          payload: {},
        },
      ],
    };

    const input = makeRunSagaInput(saga);
    await runSaga(input);

    // Third call is the compensation for createX.
    const calls = executeUnitOfWork.mock.calls as Array<[{ command: Command }]>;
    const compensationCall = calls[2];
    expect(compensationCall[0].command.httpMethod).toBe('DELETE');
  });
});
