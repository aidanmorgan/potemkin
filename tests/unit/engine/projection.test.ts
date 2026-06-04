import { projectEvent } from '../../../src/engine/projection';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { makeBoundary, makeDomainEvent } from '../_helpers';

describe('engine/projection', () => {
  const cel = createCelEvaluator();

  describe('projectEvent — GenericUpdateEvent', () => {
    it('deep-merges payload onto existing state', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { status: 'active', count: 1 });
      const event = makeDomainEvent({ type: 'System.GenericUpdateEvent', payload: { count: 2 } });
      projectEvent({ event, boundary: makeBoundary(), graph, cel });
      expect(graph.get('agg-1')?.count).toBe(2);
      expect(graph.get('agg-1')?.status).toBe('active');
    });

    it('creates new entity from empty state', () => {
      const graph = createStateGraph();
      const event = makeDomainEvent({ type: 'System.GenericUpdateEvent', payload: { name: 'New' } });
      projectEvent({ event, boundary: makeBoundary(), graph, cel });
      expect(graph.get('agg-1')).toEqual({ name: 'New' });
    });
  });

  describe('projectEvent — BaselineEntityCreatedEvent', () => {
    it('replaces existing state with event payload entirely', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { old: 'stuff' });
      const event = makeDomainEvent({
        type: 'BaselineEntityCreatedEvent',
        payload: { id: 'agg-1', status: 'new' },
      });
      projectEvent({ event, boundary: makeBoundary(), graph, cel });
      expect(graph.get('agg-1')).toEqual({ id: 'agg-1', status: 'new' });
      expect(graph.get('agg-1')).not.toHaveProperty('old');
    });
  });

  describe('projectEvent — reducer replace_state', () => {
    it('replaces state with the event payload wholesale', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { stale: 'gone', status: 'old' });
      const boundary = makeBoundary({
        reducers: [{ on: 'ChargeCreated', replaceState: true }],
      });
      const event = makeDomainEvent({
        type: 'ChargeCreated',
        payload: { id: 'agg-1', object: 'charge', amount: 2000, captured: true },
      });
      projectEvent({ event, boundary, graph, cel });
      expect(graph.get('agg-1')).toEqual({ id: 'agg-1', object: 'charge', amount: 2000, captured: true });
      expect(graph.get('agg-1')).not.toHaveProperty('stale');
    });

    it('applies patches AFTER the wholesale replace', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { old: true });
      const boundary = makeBoundary({
        reducers: [{
          on: 'Created',
          replaceState: true,
          patches: [{ op: 'replace', path: '/status', value: '${"succeeded"}' }],
        }],
      });
      const event = makeDomainEvent({ type: 'Created', payload: { id: 'agg-1', status: 'pending' } });
      projectEvent({ event, boundary, graph, cel });
      expect(graph.get('agg-1')).toEqual({ id: 'agg-1', status: 'succeeded' });
    });
  });

  describe('projectEvent — reducer replace patch', () => {
    it('applies a replace patch to state', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { status: 'pending' });
      const boundary = makeBoundary({
        reducers: [{ on: 'StatusChanged', patches: [{ op: 'replace', path: '/status', value: '${"active"}' }] }],
      });
      const event = makeDomainEvent({ type: 'StatusChanged', payload: {} });
      projectEvent({ event, boundary, graph, cel });
      expect(graph.get('agg-1')?.status).toBe('active');
    });

    it('applies a nested replace patch via JSON pointer (auto-vivifies)', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { meta: { version: 0 } });
      const boundary = makeBoundary({
        reducers: [{ on: 'Updated', patches: [{ op: 'replace', path: '/meta/version', value: '${1}' }] }],
      });
      const event = makeDomainEvent({ type: 'Updated', payload: {} });
      projectEvent({ event, boundary, graph, cel });
      expect((graph.get('agg-1')?.meta as any)?.version).toBe(1);
    });
  });

  describe('projectEvent — reducer append patch', () => {
    it('appends value to existing array', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { items: ['a'] });
      const boundary = makeBoundary({
        reducers: [{ on: 'ItemAdded', patches: [{ op: 'append', path: '/items', value: '${"b"}' }] }],
      });
      const event = makeDomainEvent({ type: 'ItemAdded', payload: {} });
      projectEvent({ event, boundary, graph, cel });
      expect(graph.get('agg-1')?.items).toEqual(['a', 'b']);
    });

    it('creates array when path does not exist', () => {
      const graph = createStateGraph();
      graph.set('agg-1', {});
      const boundary = makeBoundary({
        reducers: [{ on: 'Ev', patches: [{ op: 'append', path: '/tags', value: '${"first"}' }] }],
      });
      const event = makeDomainEvent({ type: 'Ev', payload: {} });
      projectEvent({ event, boundary, graph, cel });
      expect(graph.get('agg-1')?.tags).toEqual(['first']);
    });
  });

  describe('projectEvent — atomic swap', () => {
    it('mutates graph state after projection', () => {
      const graph = createStateGraph();
      const event = makeDomainEvent({ type: 'System.GenericUpdateEvent', payload: { x: 42 } });
      projectEvent({ event, boundary: makeBoundary(), graph, cel });
      expect(graph.get('agg-1')?.x).toBe(42);
    });
  });

  describe('projectEvent — audit fields', () => {
    it('sets updatedAt to the event timestamp on a mutation when auditFields is enabled', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { status: 'pending' });
      const boundary = makeBoundary({
        auditFields: true,
        reducers: [{ on: 'StatusChanged', patches: [{ op: 'replace', path: '/status', value: '${"active"}' }] }],
      });
      const event = makeDomainEvent({
        type: 'StatusChanged',
        payload: {},
        timestamp: '2025-03-04T12:34:56.000Z',
      });
      projectEvent({ event, boundary, graph, cel });
      expect(graph.get('agg-1')?.updatedAt).toBe('2025-03-04T12:34:56.000Z');
    });

    it('sets updatedBy to the request actorId when present', () => {
      const graph = createStateGraph();
      graph.set('agg-1', {});
      const boundary = makeBoundary({ auditFields: true });
      const event = makeDomainEvent({
        type: 'StatusChanged',
        payload: {},
        request: { method: 'POST', path: '/test', headers: {}, payload: {}, actorId: 'user-77' },
      });
      projectEvent({ event, boundary, graph, cel });
      expect(graph.get('agg-1')?.updatedBy).toBe('user-77');
    });

    it('sets updatedBy to null when the request has no actorId', () => {
      const graph = createStateGraph();
      graph.set('agg-1', {});
      const boundary = makeBoundary({ auditFields: true });
      const event = makeDomainEvent({ type: 'StatusChanged', payload: {} });
      projectEvent({ event, boundary, graph, cel });
      expect(graph.get('agg-1')?.updatedBy).toBeNull();
    });

    it('does not inject audit fields when auditFields is not enabled', () => {
      const graph = createStateGraph();
      graph.set('agg-1', {});
      const boundary = makeBoundary(); // auditFields defaults to undefined
      const event = makeDomainEvent({ type: 'StatusChanged', payload: {} });
      projectEvent({ event, boundary, graph, cel });
      expect(graph.get('agg-1')).not.toHaveProperty('updatedAt');
      expect(graph.get('agg-1')).not.toHaveProperty('updatedBy');
    });

    it('does not inject audit fields on a BaselineEntityCreatedEvent', () => {
      const graph = createStateGraph();
      const boundary = makeBoundary({ auditFields: true });
      const event = makeDomainEvent({
        type: 'BaselineEntityCreatedEvent',
        payload: { id: 'agg-1', status: 'new' },
      });
      projectEvent({ event, boundary, graph, cel });
      expect(graph.get('agg-1')).toEqual({ id: 'agg-1', status: 'new' });
    });

    it('refreshes updatedAt on each successive mutation', () => {
      const graph = createStateGraph();
      graph.set('agg-1', {});
      const boundary = makeBoundary({ auditFields: true });
      projectEvent({
        event: makeDomainEvent({ type: 'A', payload: {}, timestamp: '2025-01-01T00:00:00.000Z' }),
        boundary, graph, cel,
      });
      expect(graph.get('agg-1')?.updatedAt).toBe('2025-01-01T00:00:00.000Z');
      projectEvent({
        event: makeDomainEvent({ type: 'B', payload: {}, timestamp: '2025-06-15T09:00:00.000Z' }),
        boundary, graph, cel,
      });
      expect(graph.get('agg-1')?.updatedAt).toBe('2025-06-15T09:00:00.000Z');
    });
  });

  describe('projectEvent — soft delete via DSL reducer', () => {
    it('projects _deleted=true (boolean) and _deletedAt from a reducer patch list', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { id: 'agg-1', status: 'active' });
      const boundary = makeBoundary({
        reducers: [{
          on: 'LeadDeleted',
          patches: [
            { op: 'replace', path: '/_deleted', value: '${true}' },
            { op: 'replace', path: '/_deletedAt', value: '${event.timestamp}' },
          ],
        }],
      });
      const event = makeDomainEvent({
        type: 'LeadDeleted',
        payload: {},
        timestamp: '2025-04-04T08:00:00.000Z',
      });
      projectEvent({ event, boundary, graph, cel });
      const node = graph.get('agg-1');
      expect(node?._deleted).toBe(true);
      expect(typeof node?._deleted).toBe('boolean');
      expect(node?._deletedAt).toBe('2025-04-04T08:00:00.000Z');
    });

    it('preserves the rest of the entity state when soft-deleting (does not remove from graph)', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { id: 'agg-1', companyName: 'Acme', status: 'active' });
      const boundary = makeBoundary({
        reducers: [{
          on: 'LeadDeleted',
          patches: [{ op: 'replace', path: '/_deleted', value: '${true}' }],
        }],
      });
      const event = makeDomainEvent({ type: 'LeadDeleted', payload: {} });
      projectEvent({ event, boundary, graph, cel });
      const node = graph.get('agg-1');
      expect(node).not.toBeNull();
      expect(node?.companyName).toBe('Acme');
      expect(node?.status).toBe('active');
      expect(node?._deleted).toBe(true);
    });

    it('records the soft-delete patches in the projection journal', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { id: 'agg-1' });
      const boundary = makeBoundary({
        reducers: [{
          on: 'LeadDeleted',
          patches: [
            { op: 'replace', path: '/_deleted', value: '${true}' },
            { op: 'replace', path: '/_deletedAt', value: '${event.timestamp}' },
          ],
        }],
      });
      const event = makeDomainEvent({ type: 'LeadDeleted', payload: {} });
      const { journal } = projectEvent({ event, boundary, graph, cel });
      const paths = journal.map(j => j.path);
      expect(paths).toContain('/_deleted');
      expect(paths).toContain('/_deletedAt');
    });

    it('sets both soft-delete and audit fields when auditFields is enabled on a delete event', () => {
      const graph = createStateGraph();
      graph.set('agg-1', { id: 'agg-1' });
      const boundary = makeBoundary({
        auditFields: true,
        reducers: [{
          on: 'LeadDeleted',
          patches: [
            { op: 'replace', path: '/_deleted', value: '${true}' },
            { op: 'replace', path: '/_deletedAt', value: '${event.timestamp}' },
          ],
        }],
      });
      const event = makeDomainEvent({
        type: 'LeadDeleted',
        payload: {},
        timestamp: '2025-05-05T05:05:05.000Z',
        request: { method: 'DELETE', path: '/test/agg-1', headers: {}, payload: {}, actorId: 'user-88' },
      });
      projectEvent({ event, boundary, graph, cel });
      const node = graph.get('agg-1');
      expect(node?._deleted).toBe(true);
      expect(node?._deletedAt).toBe('2025-05-05T05:05:05.000Z');
      expect(node?.updatedAt).toBe('2025-05-05T05:05:05.000Z');
      expect(node?.updatedBy).toBe('user-88');
    });
  });

});
