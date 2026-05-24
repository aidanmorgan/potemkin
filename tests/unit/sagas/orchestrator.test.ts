/**
 * REQ-73 through REQ-80: Saga orchestrator
 */
import { findTriggeredSagas } from '../../../src/sagas/orchestrator';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import type { SagaConfig } from '../../../src/dsl/types';
import type { Command, DomainEvent } from '../../../src/types';

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
      targetId: '"cust-1"',
      payload: { amount: 'command.payload.principal' },
      compensation: {
        intent: 'mutation',
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
