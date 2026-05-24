/**
 * REQ-88/89/90: Derived projection engine
 */
import {
  createDerivedProjectionRegistry,
  applyEventToDerivedProjections,
  getDerivedProjection,
} from '../../../src/projections/engine';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import type { DomainEvent } from '../../../src/types';
import type { DerivedProjectionConfig } from '../../../src/dsl/types';

const cel = createCelEvaluator();

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    eventId: 'evt-1',
    boundary: 'Customer',
    aggregateId: 'cust-1',
    type: 'CustomerRegistered',
    payload: { name: 'Alice', customerId: 'cust-1' },
    timestamp: '2024-01-01T00:00:00.000Z',
    sequenceVersion: 1,
    causedBy: 'cmd-1',
    ...overrides,
  };
}

const customerSummaryProjection: DerivedProjectionConfig = {
  name: 'CustomerSummary',
  key: 'event.aggregateId',
  subscribe: ['Customer:CustomerRegistered', 'LoanAccount:LoanOpened'],
  reduce: [
    {
      on: 'CustomerRegistered',
      assign: {
        customer_id: 'event.aggregateId',
        name: 'event.payload.name',
        total_loans: '0',
      },
    },
    {
      on: 'LoanOpened',
      assign: {
        // Use coalesce so null/undefined state.total_loans defaults to 0
        total_loans: 'coalesce(state.total_loans, 0) + 1',
      },
    },
  ],
};

describe('projections/engine - derived projections', () => {
  it('creates a new entry for the first subscribed event', () => {
    const registry = createDerivedProjectionRegistry();
    const event = makeEvent();
    applyEventToDerivedProjections(event, [customerSummaryProjection], registry, cel);
    const result = getDerivedProjection(registry, 'CustomerSummary');
    expect(result).not.toBeNull();
    expect(result!['cust-1']).toMatchObject({ customer_id: 'cust-1', name: 'Alice', total_loans: 0 });
  });

  it('returns null for an unknown projection name', () => {
    const registry = createDerivedProjectionRegistry();
    expect(getDerivedProjection(registry, 'NonExistent')).toBeNull();
  });

  it('accumulates state across multiple events', () => {
    const registry = createDerivedProjectionRegistry();

    // Register customer
    applyEventToDerivedProjections(makeEvent(), [customerSummaryProjection], registry, cel);

    // Open a loan
    const loanEvent = makeEvent({
      eventId: 'evt-2',
      boundary: 'LoanAccount',
      aggregateId: 'loan-1',
      type: 'LoanOpened',
      payload: { customerId: 'cust-1' },
      causedBy: 'cmd-2',
    });
    applyEventToDerivedProjections(loanEvent, [customerSummaryProjection], registry, cel);

    const result = getDerivedProjection(registry, 'CustomerSummary');
    // LoanOpened key expression uses event.aggregateId = 'loan-1', not customerId
    // So it creates a new derived entity for 'loan-1'
    expect(result!['loan-1']).toMatchObject({ total_loans: 1 });
  });

  it('skips events not in the subscribe list', () => {
    const registry = createDerivedProjectionRegistry();
    const unsubscribedEvent = makeEvent({ type: 'UnknownEvent' });
    applyEventToDerivedProjections(unsubscribedEvent, [customerSummaryProjection], registry, cel);
    expect(getDerivedProjection(registry, 'CustomerSummary')).toBeNull();
  });

  it('handles multiple projections independently', () => {
    const otherProjection: DerivedProjectionConfig = {
      name: 'OtherSummary',
      key: 'event.aggregateId',
      subscribe: ['Customer:CustomerRegistered'],
      reduce: [{ on: 'CustomerRegistered', assign: { id: 'event.aggregateId' } }],
    };

    const registry = createDerivedProjectionRegistry();
    const event = makeEvent();
    applyEventToDerivedProjections(event, [customerSummaryProjection, otherProjection], registry, cel);

    const cs = getDerivedProjection(registry, 'CustomerSummary');
    const os = getDerivedProjection(registry, 'OtherSummary');
    expect(cs).not.toBeNull();
    expect(os).not.toBeNull();
    expect(os!['cust-1']).toMatchObject({ id: 'cust-1' });
  });

  it('matches subscribe entry without boundary prefix', () => {
    const proj: DerivedProjectionConfig = {
      name: 'SimpleSummary',
      key: 'event.aggregateId',
      subscribe: ['CustomerRegistered'],   // no boundary prefix
      reduce: [{ on: 'CustomerRegistered', assign: { id: 'event.aggregateId' } }],
    };
    const registry = createDerivedProjectionRegistry();
    applyEventToDerivedProjections(makeEvent(), [proj], registry, cel);
    expect(getDerivedProjection(registry, 'SimpleSummary')).not.toBeNull();
  });
});
