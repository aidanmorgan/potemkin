/**
 * Derived projection engine
 *
 * assign/append forms were removed; all reduce entries now use patches.
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
    boundary: 'Lead',
    aggregateId: 'cust-1',
    type: 'LeadCreated',
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
  subscribe: ['Lead:LeadCreated', 'Lead:OpportunityCreated'],
  reduce: [
    {
      on: 'LeadCreated',
      patches: [
        { op: 'add', path: '/customer_id', value: '${event.aggregateId}' },
        { op: 'add', path: '/name', value: '${event.payload.name}' },
        { op: 'add', path: '/total_loans', value: 0 },
      ],
    },
    {
      on: 'OpportunityCreated',
      patches: [
        // increment with default (1) increments total_loans
        { op: 'increment', path: '/total_loans', by: 1 },
      ],
    },
  ],
};

describe('projections/engine - derived projections', () => {
  it('evaluates a ${...} interpolated counter reduce to a real number', () => {
    const registry = createDerivedProjectionRegistry();
    const proj: DerivedProjectionConfig = {
      name: 'Counter',
      key: 'event.aggregateId',
      subscribe: ['Lead:LeadCreated'],
      reduce: [
        { on: 'LeadCreated', patches: [{ op: 'add', path: '/total', value: '${coalesce(state.total, 0) + 1}' }] },
      ],
    };
    applyEventToDerivedProjections(makeEvent(), [proj], registry, cel);
    applyEventToDerivedProjections(makeEvent({ eventId: 'evt-2' }), [proj], registry, cel);
    const result = getDerivedProjection(registry, 'Counter');
    expect(result!['cust-1']).toMatchObject({ total: 2 });
  });

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
      boundary: 'Lead',
      aggregateId: 'loan-1',
      type: 'OpportunityCreated',
      payload: { customerId: 'cust-1' },
      causedBy: 'cmd-2',
    });
    applyEventToDerivedProjections(loanEvent, [customerSummaryProjection], registry, cel);

    const result = getDerivedProjection(registry, 'CustomerSummary');
    // LeadCreated key expression uses event.aggregateId = 'loan-1', not customerId
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
      subscribe: ['Lead:LeadCreated'],
      reduce: [{ on: 'LeadCreated', patches: [{ op: 'add', path: '/id', value: '${event.aggregateId}' }] }],
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
      subscribe: ['LeadCreated'],   // no boundary prefix
      reduce: [{ on: 'LeadCreated', patches: [{ op: 'add', path: '/id', value: '${event.aggregateId}' }] }],
    };
    const registry = createDerivedProjectionRegistry();
    applyEventToDerivedProjections(makeEvent(), [proj], registry, cel);
    expect(getDerivedProjection(registry, 'SimpleSummary')).not.toBeNull();
  });

  it('applies patches: add/replace through the canonical applyPatches path', () => {
    const registry = createDerivedProjectionRegistry();
    const proj: DerivedProjectionConfig = {
      name: 'PatchTest',
      key: 'event.aggregateId',
      subscribe: ['Lead:LeadCreated'],
      reduce: [
        {
          on: 'LeadCreated',
          patches: [
            { op: 'add', path: '/status', value: '${event.payload.name}' },
            { op: 'replace', path: '/status', value: '"active"' },
          ],
        },
      ],
    };
    applyEventToDerivedProjections(makeEvent(), [proj], registry, cel);
    const result = getDerivedProjection(registry, 'PatchTest');
    expect(result!['cust-1']).toMatchObject({ status: 'active' });
  });

  it('patches: increment auto-vivifies at 0 when path is absent', () => {
    const registry = createDerivedProjectionRegistry();
    const proj: DerivedProjectionConfig = {
      name: 'IncrTest',
      key: 'event.aggregateId',
      subscribe: ['Lead:LeadCreated'],
      reduce: [
        { on: 'LeadCreated', patches: [{ op: 'increment', path: '/count', by: 3 }] },
      ],
    };
    applyEventToDerivedProjections(makeEvent(), [proj], registry, cel);
    const result = getDerivedProjection(registry, 'IncrTest');
    expect(result!['cust-1']).toMatchObject({ count: 3 });
  });

  it('patches: append creates an array when path is absent', () => {
    const registry = createDerivedProjectionRegistry();
    const proj: DerivedProjectionConfig = {
      name: 'AppendTest',
      key: 'event.aggregateId',
      subscribe: ['Lead:LeadCreated'],
      reduce: [
        { on: 'LeadCreated', patches: [{ op: 'append', path: '/tags', value: '"vip"' }] },
      ],
    };
    applyEventToDerivedProjections(makeEvent(), [proj], registry, cel);
    const result = getDerivedProjection(registry, 'AppendTest');
    expect(result!['cust-1']).toMatchObject({ tags: ['vip'] });
  });

  it('patches: EVAL_FAILED sentinel — CEL error skips write and leaves prior state intact', () => {
    const registry = createDerivedProjectionRegistry();
    const proj: DerivedProjectionConfig = {
      name: 'EvalFail',
      key: 'event.aggregateId',
      subscribe: ['Lead:LeadCreated'],
      reduce: [
        {
          on: 'LeadCreated',
          patches: [
            // First patch sets a known value
            { op: 'add', path: '/safe', value: '"ok"' },
            // Second patch references a function that does not exist in CEL — will throw
            { op: 'add', path: '/broken', value: '${this_function_does_not_exist_xyz()}' },
          ],
        },
      ],
    };
    applyEventToDerivedProjections(makeEvent(), [proj], registry, cel);
    const result = getDerivedProjection(registry, 'EvalFail');
    // The safe patch applied; the broken patch was skipped
    expect(result!['cust-1']).toMatchObject({ safe: 'ok' });
    // broken key was never written — prior state (absent) is intact
    expect((result!['cust-1'] as Record<string, unknown>)['broken']).toBeUndefined();
  });
});
