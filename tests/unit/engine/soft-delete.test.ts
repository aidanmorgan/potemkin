/**
 * Unit tests for soft delete behavior.
 *
 * When a DELETE-method request hits the fallback path in pattern matching,
 * the entity is marked with _deleted=true and _deletedAt=<timestamp>
 * instead of being removed from the graph.
 *
 * Collection queries exclude soft-deleted entities by default,
 * but include them when ?includeDeleted=true is passed.
 */

import { runPatternMatch } from '../../../src/engine/patternMatcher';
import { runQuery } from '../../../src/engine/query';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createShadowGraph } from '../../../src/stategraph/shadow';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { makeBoundary, makeCommand, makeDomainEvent } from '../_helpers';
import type { OpenApiDoc } from '../../../src/contract/loader';

const cel = createCelEvaluator();

// Minimal OpenAPI doc stub for query tests
const minimalOpenapi: OpenApiDoc = {
  raw: { components: { schemas: {} } },
  paths: {},
} as unknown as OpenApiDoc;

describe('soft delete', () => {
  describe('patternMatcher — DELETE method fallback', () => {
    it('produces a GenericUpdateEvent with _deleted and _deletedAt on DELETE', () => {
      const graph = createStateGraph();
      graph.set('lead-1', { id: 'lead-1', status: 'NEW' });
      const shadow = createShadowGraph(graph);

      const boundary = makeBoundary({
        fallbackOverride: true,
        behaviors: [],
        eventCatalog: [],
        reducers: [],
      });

      const command = makeCommand({
        intent: 'mutation',
        httpMethod: 'DELETE',
        targetId: 'lead-1',
      });

      let projectedEvent: any = null;
      const result = runPatternMatch({
        command,
        boundary,
        shadow,
        cel,
        nextEventId: () => 'evt-del-1',
        now: () => '2025-06-01T00:00:00.000Z',
        nextSequenceVersion: () => 1,
        projectToShadow: (evt) => {
          projectedEvent = evt;
          // Simulate projection: merge payload into state
          const current = shadow.get(evt.aggregateId) ?? {};
          shadow.stage(evt.aggregateId, { ...current, ...evt.payload });
        },
      });

      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('System.GenericUpdateEvent');
      expect(result.events[0].payload).toMatchObject({
        _deleted: true,
        _deletedAt: '2025-06-01T00:00:00.000Z',
      });

      // Shadow state should have _deleted fields
      const state = shadow.get('lead-1');
      expect(state?._deleted).toBe(true);
      expect(state?._deletedAt).toBe('2025-06-01T00:00:00.000Z');
    });

    it('non-DELETE mutation still uses standard GenericUpdateEvent fallback', () => {
      const graph = createStateGraph();
      graph.set('lead-1', { id: 'lead-1', status: 'NEW' });
      const shadow = createShadowGraph(graph);

      const boundary = makeBoundary({
        fallbackOverride: true,
        behaviors: [],
        eventCatalog: [],
        reducers: [],
      });

      const command = makeCommand({
        intent: 'mutation',
        httpMethod: 'PATCH',
        targetId: 'lead-1',
        payload: { status: 'CONTACTED' },
      });

      const result = runPatternMatch({
        command,
        boundary,
        shadow,
        cel,
        nextEventId: () => 'evt-1',
        now: () => '2025-06-01T00:00:00.000Z',
        nextSequenceVersion: () => 1,
        projectToShadow: (evt) => {
          const current = shadow.get(evt.aggregateId) ?? {};
          shadow.stage(evt.aggregateId, { ...current, ...evt.payload });
        },
      });

      expect(result.events).toHaveLength(1);
      expect(result.events[0].payload).not.toHaveProperty('_deleted');
      expect(result.events[0].payload).toMatchObject({ status: 'CONTACTED' });
    });
  });

  describe('query — soft-deleted entity filtering', () => {
    it('excludes soft-deleted entities from collection queries by default', () => {
      const graph = createStateGraph();
      graph.set('lead-1', { id: 'lead-1', status: 'NEW' });
      graph.set('lead-2', { id: 'lead-2', status: 'NEW', _deleted: true, _deletedAt: '2025-01-01T00:00:00Z' });
      graph.set('lead-3', { id: 'lead-3', status: 'CONTACTED' });

      const boundary = makeBoundary({ boundary: 'Lead' });

      const result = runQuery({
        boundary,
        targetId: null,
        queryParams: {},
        graph,
        cel,
        openapi: minimalOpenapi,
      });

      const entities = result as any[];
      expect(entities).toHaveLength(2);
      expect(entities.map((e: any) => e.id)).toEqual(['lead-1', 'lead-3']);
    });

    it('includes soft-deleted entities when includeDeleted=true', () => {
      const graph = createStateGraph();
      graph.set('lead-1', { id: 'lead-1', status: 'NEW' });
      graph.set('lead-2', { id: 'lead-2', status: 'NEW', _deleted: true, _deletedAt: '2025-01-01T00:00:00Z' });

      const boundary = makeBoundary({ boundary: 'Lead' });

      const result = runQuery({
        boundary,
        targetId: null,
        queryParams: { includeDeleted: 'true' },
        graph,
        cel,
        openapi: minimalOpenapi,
      });

      const entities = result as any[];
      expect(entities).toHaveLength(2);
    });

    it('still returns soft-deleted entities for single-entity lookups', () => {
      const graph = createStateGraph();
      graph.set('lead-2', { id: 'lead-2', status: 'NEW', _deleted: true, _deletedAt: '2025-01-01T00:00:00Z' });

      const boundary = makeBoundary({ boundary: 'Lead' });

      // Single-entity lookup should not filter by _deleted
      const result = runQuery({
        boundary,
        targetId: 'lead-2',
        queryParams: {},
        graph,
        cel,
        openapi: minimalOpenapi,
      });

      expect((result as any).id).toBe('lead-2');
      expect((result as any)._deleted).toBe(true);
    });
  });
});
