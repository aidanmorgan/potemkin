import { projectEvent } from '../../../src/engine/projection';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { rootLogger } from '../../../src/observability/logger';
import type { BoundaryConfig, ReducerRule } from '../../../src/dsl/types';
import type { DomainEvent } from '../../../src/types';

const cel = createCelEvaluator();
const log = rootLogger();

function makeBoundary(reducerEntries: readonly ReducerRule[]): BoundaryConfig {
  return {
    boundary: 'Lead',
    contractPath: '/leads',
    fallbackOverride: false,
    behaviors: [],
    reducers: reducerEntries,
    eventCatalog: [{ type: 'LeadCreated', payloadTemplate: {} }],
  };
}

function project(reducers: readonly ReducerRule[]) {
  const boundary = makeBoundary(reducers);
  const graph = createStateGraph();
  const event: DomainEvent = {
    type: 'LeadCreated',
    aggregateId: 'lead-1',
    timestamp: new Date().toISOString(),
    payload: { id: 'lead-1', label: 'Acme' },
    sequence: 1,
  } as unknown as DomainEvent;
  return projectEvent({ graph, boundary, event, cel, logger: log });
}

describe('projection — reducer patch journal', () => {
  it('returns one journal entry per applied patch', () => {
    const { journal } = project([
      {
        on: 'LeadCreated',
        patches: [
          { op: 'replace', path: '/status', value: "${'NEW'}" },
          { op: 'append', path: '/tags', value: "${'hot'}" },
        ],
      },
    ]);
    expect(journal).toHaveLength(2);
  });

  it('tags every journal entry with source=reducer', () => {
    const { journal } = project([
      {
        on: 'LeadCreated',
        patches: [
          { op: 'replace', path: '/status', value: "${'NEW'}" },
          { op: 'increment', path: '/score', by: 3 },
        ],
      },
    ]);
    expect(journal.every((e) => e.source === 'reducer')).toBe(true);
  });

  it('preserves patch op and path in the journal in list order', () => {
    const { journal } = project([
      {
        on: 'LeadCreated',
        patches: [
          { op: 'replace', path: '/status', value: "${'NEW'}" },
          { op: 'replace', path: '/label', value: '${event.payload.label}' },
        ],
      },
    ]);
    expect(journal.map((e) => `${e.op} ${e.path}`)).toEqual([
      'replace /status',
      'replace /label',
    ]);
  });

  it('returns an empty journal for an event with no matching reducer', () => {
    const { journal } = project([{ on: 'SomeOtherEvent', patches: [{ op: 'add', path: '/x', value: 1 }] }]);
    expect(journal).toEqual([]);
  });
});
