import { runQuery } from '../../../src/engine/query';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { EntityAbsenceError } from '../../../src/errors';
import { makeBoundary } from '../_helpers';

const emptyDoc = { raw: {}, paths: {} };
const cel = createCelEvaluator();

describe('engine/query', () => {
  describe('single-entity query', () => {
    it('returns the entity when found', () => {
      const graph = createStateGraph();
      graph.set('loan-1', { id: 'loan-1', amount: 1000 });
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: 'loan-1',
        queryParams: {},
        graph,
        cel,
        openapi: emptyDoc,
      });
      expect(result).toEqual({ id: 'loan-1', amount: 1000 });
    });

    it('throws EntityAbsenceError when entity not found', () => {
      const graph = createStateGraph();
      expect(() =>
        runQuery({
          boundary: makeBoundary(),
          targetId: 'missing',
          queryParams: {},
          graph,
          cel,
          openapi: emptyDoc,
        }),
      ).toThrow(EntityAbsenceError);
    });

    it('EntityAbsenceError includes targetId', () => {
      const graph = createStateGraph();
      try {
        runQuery({
          boundary: makeBoundary(),
          targetId: 'gone',
          queryParams: {},
          graph,
          cel,
          openapi: emptyDoc,
        });
      } catch (e) {
        expect((e as EntityAbsenceError).details).toMatchObject({ targetId: 'gone' });
      }
    });
  });

  describe('collection query', () => {
    it('returns all entities when no filters', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a' });
      graph.set('b', { id: 'b' });
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: {},
        graph,
        cel,
        openapi: emptyDoc,
      });
      expect(Array.isArray(result)).toBe(true);
      expect((result as any[]).length).toBe(2);
    });

    it('returns empty array when graph is empty', () => {
      const graph = createStateGraph();
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: {},
        graph,
        cel,
        openapi: emptyDoc,
      });
      expect(result).toEqual([]);
    });

    it('applies queryMapping filter', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a', status: 'active' });
      graph.set('b', { id: 'b', status: 'closed' });
      const boundary = makeBoundary({
        queryMapping: { status: 'state.status == param' },
      });
      const result = runQuery({
        boundary,
        targetId: null,
        queryParams: { status: 'active' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe('a');
    });

    it('pagination: limit applied (envelope form)', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a' });
      graph.set('b', { id: 'b' });
      graph.set('c', { id: 'c' });
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { limit: '2' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as { items: unknown[] };
      expect(result.items).toHaveLength(2);
    });

    it('pagination: offset applied', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a' });
      graph.set('b', { id: 'b' });
      graph.set('c', { id: 'c' });
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { offset: '2' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(1);
    });

    it('pagination: invalid offset defaults to 0', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a' });
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { offset: 'bad' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(1);
    });

    it('skips filter when queryParam not present', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a', status: 'active' });
      const boundary = makeBoundary({
        queryMapping: { status: 'state.status == param' },
      });
      const result = runQuery({
        boundary,
        targetId: null,
        queryParams: {},
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(1);
    });
  });

  describe('derived properties', () => {
    it('computes x-derived properties from openapi schema', () => {
      const graph = createStateGraph();
      graph.set('a', { count: 5 });
      const doc = {
        raw: {
          components: {
            schemas: {
              TestBoundary: {
                type: 'object',
                properties: {
                  count: { type: 'number' },
                  doubled: { type: 'number', 'x-derived': 'state.count * 2' },
                },
              },
            },
          },
        },
        paths: {},
      };
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: 'a',
        queryParams: {},
        graph,
        cel,
        openapi: doc,
      }) as any;
      expect(result.doubled).toBe(10);
    });

    it('skips derived property when CEL throws', () => {
      const graph = createStateGraph();
      graph.set('a', { count: 5 });
      const doc = {
        raw: {
          components: {
            schemas: {
              TestBoundary: {
                type: 'object',
                properties: {
                  count: { type: 'number' },
                  broken: { type: 'string', 'x-derived': 'undefined_ident' },
                },
              },
            },
          },
        },
        paths: {},
      };
      // Should not throw, just skip broken derived property
      expect(() =>
        runQuery({
          boundary: makeBoundary(),
          targetId: 'a',
          queryParams: {},
          graph,
          cel,
          openapi: doc,
        }),
      ).not.toThrow();
    });
  });
});
