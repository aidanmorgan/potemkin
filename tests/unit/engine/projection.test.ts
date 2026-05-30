import { projectEvent, setByDotPath, getByDotPath } from '../../../src/engine/projection';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { InternalExecutionError } from '../../../src/errors';
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

  describe('setByDotPath', () => {
    it('sets a top-level key', () => {
      const obj = { a: 1 };
      setByDotPath(obj, 'a', 99);
      expect(obj.a).toBe(99);
    });

    it('sets a nested key', () => {
      const obj = { a: { b: 1 } };
      setByDotPath(obj, 'a.b', 42);
      expect((obj.a as any).b).toBe(42);
    });

    it('creates intermediate objects', () => {
      const obj = {} as any;
      setByDotPath(obj, 'a.b.c', 'value');
      expect(obj.a.b.c).toBe('value');
    });

    it('sets array element by bracket notation', () => {
      const obj = { items: ['x', 'y', 'z'] } as any;
      setByDotPath(obj, 'items[1]', 'replaced');
      expect(obj.items[1]).toBe('replaced');
    });

    it('throws InternalExecutionError for empty path', () => {
      const obj = { a: 1 };
      expect(() => setByDotPath(obj, '', 99)).toThrow();
    });
  });

  describe('getByDotPath', () => {
    it('gets a top-level key', () => {
      expect(getByDotPath({ a: 42 }, 'a')).toBe(42);
    });

    it('gets a nested key', () => {
      expect(getByDotPath({ a: { b: 99 } }, 'a.b')).toBe(99);
    });

    it('returns undefined for missing path', () => {
      expect(getByDotPath({}, 'a.b.c')).toBeUndefined();
    });

    it('gets array element by bracket notation', () => {
      expect(getByDotPath({ items: [10, 20, 30] }, 'items[1]')).toBe(20);
    });

    it('returns undefined on non-object traversal', () => {
      expect(getByDotPath({ a: 42 } as any, 'a.b')).toBeUndefined();
    });
  });
});
