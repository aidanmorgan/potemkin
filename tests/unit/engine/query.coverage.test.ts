/**
 * Coverage backfill for engine/query.ts
 *
 * Uncovered lines:
 *  - 102: `return false;` in CEL filter catch block — when filter CEL throws, entity is excluded
 *  - 161: `return entity;` in applyDerivedProperties — when boundarySchema has no `properties` key
 */

import { runQuery } from '../../../src/engine/query';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { makeBoundary } from '../_helpers';
import { EntityAbsenceError } from '../../../src/errors';

const cel = createCelEvaluator();

describe('engine/query.ts additional coverage', () => {

  // ── Line 102: CEL filter catch returns false (entity excluded) ───────────────

  describe('queryMapping filter CEL error returns false (line 102)', () => {
    it('excludes entity when filter CEL throws (returns false from catch)', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a', status: 'active' });
      graph.set('b', { id: 'b', status: 'closed' });

      // A CEL expression that always throws (references undefined variable)
      const boundary = makeBoundary({
        queryMapping: { status: 'state.completely_undefined_variable_xyz_that_throws' },
      });

      // When filter CEL throws, catch returns false → entity excluded
      // The param is present so the filter IS applied (not skipped)
      const result = runQuery({
        boundary,
        targetId: null,
        queryParams: { status: 'active' },
        graph,
        cel,
        openapi: { raw: {}, paths: {} },
      }) as any[];

      // Both entities are excluded because the CEL expression always throws
      expect(result).toHaveLength(0);
    });

    it('CEL filter catch returns false — does not throw (graceful exclusion)', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a' });

      const boundary = makeBoundary({
        queryMapping: { foo: 'undefined_ident_filter_throws' },
      });

      expect(() =>
        runQuery({
          boundary,
          targetId: null,
          queryParams: { foo: 'bar' },
          graph,
          cel,
          openapi: { raw: {}, paths: {} },
        }),
      ).not.toThrow();
    });
  });

  // ── Line 161: applyDerivedProperties with no `properties` key ───────────────

  describe('applyDerivedProperties — no properties key on schema (line 161)', () => {
    it('returns entity unchanged when schema has no properties key', () => {
      const graph = createStateGraph();
      const entity = { id: 'a', value: 42 };
      graph.set('a', entity);

      // Schema exists for TestBoundary but has no `properties` key
      const doc = {
        raw: {
          components: {
            schemas: {
              TestBoundary: {
                type: 'object',
                // Deliberately no 'properties' key → hits line 161 `return entity`
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

      // Entity returned unchanged since no derived properties were found
      expect(result).toEqual(entity);
    });

    it('collection query: returns entities unchanged when schema has no properties', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a' });
      graph.set('b', { id: 'b' });

      const doc = {
        raw: {
          components: {
            schemas: {
              TestBoundary: {
                type: 'object',
                // No properties — line 161 branch
              },
            },
          },
        },
        paths: {},
      };

      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: {},
        graph,
        cel,
        openapi: doc,
      }) as any[];

      expect(result).toHaveLength(2);
    });
  });

  // ── limit=0 edge case ────────────────────────────────────────────────────────

  describe('limit=0 query param', () => {
    it('returns empty items array when limit=0 (envelope form)', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a' });
      graph.set('b', { id: 'b' });

      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { limit: '0' },
        graph,
        cel,
        openapi: { raw: {}, paths: {} },
      }) as { items: unknown[] };

      expect(result.items).toHaveLength(0);
    });
  });

  // ── negative offset treated as 0 ─────────────────────────────────────────────

  describe('negative offset defaults to 0', () => {
    it('treats negative offset as 0', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a' });
      graph.set('b', { id: 'b' });

      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { offset: '-5' },
        graph,
        cel,
        openapi: { raw: {}, paths: {} },
      }) as any[];

      expect(result).toHaveLength(2);
    });
  });

  // ── Lines 113, 116: Array-form offset and limit params ───────────────────────

  describe('array-form query params for offset and limit (lines 113, 116)', () => {
    it('uses first element when offset is provided as array (line 113)', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a' });
      graph.set('b', { id: 'b' });
      graph.set('c', { id: 'c' });

      // queryParams.offset as string[] → parseInt(offsetParam[0])
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { offset: ['1', '2'] }, // array form — should use '1'
        graph,
        cel,
        openapi: { raw: {}, paths: {} },
      }) as any[];

      expect(result).toHaveLength(2); // 3 items - offset 1 = 2 items
    });

    it('uses first element when limit is provided as array (envelope form)', () => {
      const graph = createStateGraph();
      graph.set('a', { id: 'a' });
      graph.set('b', { id: 'b' });
      graph.set('c', { id: 'c' });

      // queryParams.limit as string[] → parseInt(limitParam[0])
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { limit: ['2', '5'] }, // array form — should use '2'
        graph,
        cel,
        openapi: { raw: {}, paths: {} },
      }) as { items: unknown[] };

      expect(result.items).toHaveLength(2);
    });
  });

  // ── Line 50: non-Error throw from _runQuery (String branch in span catch) ────

  describe('non-Error throw in runQuery span catch (line 50)', () => {
    it('throws EntityAbsenceError even for missing entity — Error instanceof branch covered', () => {
      const graph = createStateGraph();

      expect(() =>
        runQuery({
          boundary: makeBoundary(),
          targetId: 'missing-id',
          queryParams: {},
          graph,
          cel,
          openapi: { raw: {}, paths: {} },
        }),
      ).toThrow(EntityAbsenceError);
    });
  });
});
