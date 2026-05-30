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
    eventCatalog: [
      {
        type: 'LeadCreated',
        payloadTemplate: { id: 'command.payload.id', label: 'command.payload.label' },
      },
    ],
  };
}

describe('projection runtime — patches: ops', () => {
  function projectLeadCreated(reducers: readonly ReducerRule[]): Record<string, unknown> {
    const boundary = makeBoundary(reducers);
    const graph = createStateGraph();
    const event: DomainEvent = {
      type: 'LeadCreated',
      aggregateId: 'lead-1',
      timestamp: new Date().toISOString(),
      payload: { id: 'lead-1', label: 'Acme' },
      sequence: 1,
    } as unknown as DomainEvent;
    projectEvent({ graph, boundary, event, cel, logger: log });
    return graph.get('lead-1') as Record<string, unknown>;
  }

  it('replace patch sets a top-level field', () => {
    const state = projectLeadCreated([
      { on: 'LeadCreated', patches: [{ op: 'replace', path: '/status', value: "${'NEW'}" }] },
    ]);
    expect(state['status']).toBe('NEW');
  });

  it('add patch sets a new field', () => {
    const state = projectLeadCreated([
      { on: 'LeadCreated', patches: [{ op: 'add', path: '/foo', value: "${'bar'}" }] },
    ]);
    expect(state['foo']).toBe('bar');
  });

  it('remove patch deletes a field', () => {
    const state = projectLeadCreated([
      {
        on: 'LeadCreated',
        patches: [
          { op: 'replace', path: '/temp', value: "${'x'}" },
          { op: 'remove', path: '/temp' },
        ],
      },
    ]);
    expect(state['temp']).toBeUndefined();
  });

  it('append patch appends to an array; auto-initialises an empty array', () => {
    const state = projectLeadCreated([
      {
        on: 'LeadCreated',
        patches: [
          { op: 'append', path: '/tags', value: "${'red'}" },
          { op: 'append', path: '/tags', value: "${'green'}" },
        ],
      },
    ]);
    expect(state['tags']).toEqual(['red', 'green']);
  });

  it('prepend patch unshifts to an array', () => {
    const state = projectLeadCreated([
      {
        on: 'LeadCreated',
        patches: [
          { op: 'append', path: '/tags', value: "${'b'}" },
          { op: 'prepend', path: '/tags', value: "${'a'}" },
        ],
      },
    ]);
    expect(state['tags']).toEqual(['a', 'b']);
  });

  it('increment patch adds to a numeric field', () => {
    const state = projectLeadCreated([
      {
        on: 'LeadCreated',
        patches: [
          { op: 'replace', path: '/score', value: 10 },
          { op: 'increment', path: '/score', by: 5 },
        ],
      },
    ]);
    expect(state['score']).toBe(15);
  });

  it('merge patch shallow-merges into an object field', () => {
    const state = projectLeadCreated([
      {
        on: 'LeadCreated',
        patches: [
          { op: 'replace', path: '/meta', value: { a: 1 } },
          { op: 'merge', path: '/meta', value: { b: 2 } },
        ],
      },
    ]);
    expect(state['meta']).toEqual({ a: 1, b: 2 });
  });

  it('upsert patch updates an existing array entry by key', () => {
    const state = projectLeadCreated([
      {
        on: 'LeadCreated',
        patches: [
          { op: 'replace', path: '/items', value: [{ id: 'a', qty: 1 }] },
          { op: 'upsert', path: '/items', key: 'id', value: { id: 'a', qty: 9 } },
        ],
      },
    ]);
    expect(state['items']).toEqual([{ id: 'a', qty: 9 }]);
  });

  it('upsert patch appends when no entry matches', () => {
    const state = projectLeadCreated([
      {
        on: 'LeadCreated',
        patches: [
          { op: 'replace', path: '/items', value: [{ id: 'a' }] },
          { op: 'upsert', path: '/items', key: 'id', value: { id: 'b' } },
        ],
      },
    ]);
    expect(state['items']).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('move patch relocates a field from source to target', () => {
    const state = projectLeadCreated([
      {
        on: 'LeadCreated',
        patches: [
          { op: 'replace', path: '/draftLabel', value: "${'Acme Corp'}" },
          { op: 'move', from: '/draftLabel', path: '/finalLabel' },
        ],
      },
    ]);
    expect(state['finalLabel']).toBe('Acme Corp');
    expect(state['draftLabel']).toBeUndefined();
  });

  it('copy patch duplicates a field, leaving the source intact', () => {
    const state = projectLeadCreated([
      {
        on: 'LeadCreated',
        patches: [
          { op: 'replace', path: '/origin', value: "${'web'}" },
          { op: 'copy', from: '/origin', path: '/channel' },
        ],
      },
    ]);
    expect(state['origin']).toBe('web');
    expect(state['channel']).toBe('web');
  });

  it('move patch relocates a nested object subtree', () => {
    const state = projectLeadCreated([
      {
        on: 'LeadCreated',
        patches: [
          { op: 'replace', path: '/tmp', value: { contact: { email: 'a@b.com' } } },
          { op: 'move', from: '/tmp/contact', path: '/contact' },
        ],
      },
    ]);
    expect(state['contact']).toEqual({ email: 'a@b.com' });
    expect((state['tmp'] as Record<string, unknown>)['contact']).toBeUndefined();
  });

  it('copy patch deep-clones so mutating the copy leaves the source unchanged', () => {
    const state = projectLeadCreated([
      {
        on: 'LeadCreated',
        patches: [
          { op: 'replace', path: '/source', value: { nested: { n: 1 } } },
          { op: 'copy', from: '/source', path: '/dest' },
          { op: 'replace', path: '/dest/nested/n', value: 99 },
        ],
      },
    ]);
    expect((state['source'] as { nested: { n: number } }).nested.n).toBe(1);
    expect((state['dest'] as { nested: { n: number } }).nested.n).toBe(99);
  });

  it('nested JSON-pointer path translates to dot path', () => {
    const state = projectLeadCreated([
      {
        on: 'LeadCreated',
        patches: [
          { op: 'replace', path: '/audit', value: {} },
          { op: 'replace', path: '/audit/lastChangedBy', value: "${'system'}" },
        ],
      },
    ]);
    expect((state['audit'] as Record<string, unknown>)['lastChangedBy']).toBe('system');
  });
});
