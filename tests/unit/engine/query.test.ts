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

  describe('relationship expansion (?include)', () => {
    it('embeds referenced entities under _<field> while retaining the id array', () => {
      const graph = createStateGraph();
      graph.set('lead-1', { id: 'lead-1', callIds: ['call-1', 'call-2'] });
      graph.set('call-1', { id: 'call-1', outcome: 'INTERESTED' });
      graph.set('call-2', { id: 'call-2', outcome: 'CALLBACK_SCHEDULED' });
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { include: 'callIds' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      const lead = result.find((e) => e.id === 'lead-1');
      expect(lead._callIds).toHaveLength(2);
      expect(lead._callIds.map((c: any) => c.id).sort()).toEqual(['call-1', 'call-2']);
      // Original id array preserved.
      expect(lead.callIds).toEqual(['call-1', 'call-2']);
    });

    it('does not embed when include is absent (feature gated by param)', () => {
      const graph = createStateGraph();
      graph.set('lead-1', { id: 'lead-1', callIds: ['call-1'] });
      graph.set('call-1', { id: 'call-1' });
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: {},
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result[0]._callIds).toBeUndefined();
    });
  });

  describe('multi-field sort (?sort=a,-b)', () => {
    it('sorts by first key, then by second key with `-` meaning descending', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a', status: 'NEW', score: 50 });
      graph.set('b', { id: 'b', status: 'CONTACTED', score: 80 });
      graph.set('c', { id: 'c', status: 'NEW', score: 70 });
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { sort: 'status,-score' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      // status ASC: CONTACTED first, then the two NEW by score DESC (70 then 50).
      expect(result.map((e) => e.id)).toEqual(['b', 'c', 'a']);
    });

    it('single `-`-prefixed field sorts descending (multi-field path)', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a', score: 10 });
      graph.set('b', { id: 'b', score: 30 });
      graph.set('c', { id: 'c', score: 20 });
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { sort: '-score' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result.map((e) => e.score)).toEqual([30, 20, 10]);
    });
  });

  describe('sparse fieldsets (?fields)', () => {
    it('projects only the selected fields plus id (collection)', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a', name: 'A', score: 1, status: 'NEW' });
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { fields: 'name,score' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(Object.keys(result[0]).sort()).toEqual(['id', 'name', 'score']);
      expect(result[0].status).toBeUndefined();
    });

    it('drops non-existent requested fields but always keeps id', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a', name: 'A' });
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { fields: 'nonExistent' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(Object.keys(result[0])).toEqual(['id']);
    });

    it('projects fields on a single-entity lookup, preserving id', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a', name: 'A', score: 1, status: 'NEW' });
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: 'a',
        queryParams: { fields: 'status' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any;
      expect(Object.keys(result).sort()).toEqual(['id', 'status']);
      expect(result.score).toBeUndefined();
    });
  });

  describe('cursor pagination (?cursor)', () => {
    it('emits nextCursor when more pages remain and walks to the next page', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a' });
      graph.set('b', { id: 'b' });
      graph.set('c', { id: 'c' });
      graph.set('d', { id: 'd' });
      const page1 = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { limit: '2', sort: 'id' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as { items: any[]; hasMore: boolean; nextCursor?: string };
      expect(page1.items.map((e) => e.id)).toEqual(['a', 'b']);
      expect(page1.hasMore).toBe(true);
      expect(typeof page1.nextCursor).toBe('string');

      const page2 = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { limit: '2', sort: 'id', cursor: page1.nextCursor! },
        graph,
        cel,
        openapi: emptyDoc,
      }) as { items: any[]; hasMore: boolean; nextCursor?: string };
      // Next page has no overlap with page 1.
      expect(page2.items.map((e) => e.id)).toEqual(['c', 'd']);
      expect(page2.hasMore).toBe(false);
      expect(page2.nextCursor).toBeUndefined();
    });

    it('malformed cursor yields an empty page without crashing', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a' });
      graph.set('b', { id: 'b' });
      const garbage = Buffer.from('not-a-cursor', 'utf8').toString('base64');
      const res = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { limit: '2', cursor: garbage },
        graph,
        cel,
        openapi: emptyDoc,
      }) as { items: any[]; totalCount: number; hasMore: boolean; nextCursor?: string };
      expect(res.items).toHaveLength(0);
      expect(res.totalCount).toBe(2);
      expect(res.hasMore).toBe(false);
      expect(res.nextCursor).toBeUndefined();
    });
  });

  describe('array-aware operators', () => {
    it('?field:contains on an array field does membership', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a', callIds: ['call-1', 'call-2'] });
      graph.set('b', { id: 'b', callIds: ['call-3'] });
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'callIds:contains': 'call-1' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result.map((e) => e.id)).toEqual(['a']);
    });

    it('?field:contains on a string field keeps substring semantics', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a', status: 'RENEW' });
      graph.set('b', { id: 'b', status: 'CLOSED' });
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'status:contains': 'NEW' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result.map((e) => e.id)).toEqual(['a']);
    });

    it('?field:arrayContains matches only when the field is an array', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a', callIds: ['call-1'] });
      graph.set('b', { id: 'b', status: 'NEW' });
      const matchArray = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'callIds:arrayContains': 'call-1' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(matchArray.map((e) => e.id)).toEqual(['a']);

      // A non-array (string) field never matches arrayContains.
      const matchString = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'status:arrayContains': 'NEW' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(matchString).toHaveLength(0);
    });

    it('operator filters walk dotted paths for nested fields', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a', customer: { contact: { email: 'x@gmail.com' } } });
      graph.set('b', { id: 'b', customer: { contact: { email: 'y@yahoo.com' } } });
      graph.set('c', { id: 'c', status: 'NEW' }); // missing nested path
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'customer.contact.email:contains': '@gmail.com' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result.map((e) => e.id)).toEqual(['a']);
    });
  });
});
