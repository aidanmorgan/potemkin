/**
 * Unit tests for query operator features:
 *  - Sorting (?sort=field&order=asc|desc)
 *  - Query operators (?field:operator=value)
 *  - Full-text search (?q=searchTerm)
 */

import { runQuery } from '../../../src/engine/query';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { makeBoundary } from '../_helpers';
import type { JsonObject } from '../../../src/types';

const emptyDoc = { raw: {}, paths: {} };
const cel = createCelEvaluator();

function makeGraph(entries: Array<Record<string, unknown>>) {
  const graph = createStateGraph();
  for (const e of entries) {
    graph.set(e.id as string, e as JsonObject);
  }
  return graph;
}

const sampleEntities = [
  { id: 'lead-1', companyName: 'Apex Solutions Ltd', contactName: 'Jordan', status: 'NEW', score: 50, createdAt: '2025-01-01T00:00:00.000Z' },
  { id: 'lead-2', companyName: 'BlueSky Tech', contactName: 'Sam', status: 'CONTACTED', score: 80, createdAt: '2025-02-15T00:00:00.000Z' },
  { id: 'lead-3', companyName: 'Cornerstone Corp', contactName: 'Alex', status: 'QUALIFIED', score: 20, createdAt: '2025-03-10T00:00:00.000Z' },
  { id: 'lead-4', companyName: 'Delta Dynamics', contactName: 'Morgan', status: 'DISQUALIFIED', score: 70, createdAt: '2025-04-01T00:00:00.000Z' },
  { id: 'lead-5', companyName: 'Echo Enterprises', contactName: 'Taylor', status: 'NEW', score: 50, createdAt: '2025-05-20T00:00:00.000Z' },
];

describe('Query operators', () => {

  // ── Sorting ─────────────────────────────────────────────────────────────────

  describe('sorting (?sort=field&order=asc|desc)', () => {
    it('sorts by numeric field ascending (default order)', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { sort: 'score' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      const scores = result.map((e: any) => e.score);
      expect(scores).toEqual([20, 50, 50, 70, 80]);
    });

    it('sorts by numeric field descending', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { sort: 'score', order: 'desc' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      const scores = result.map((e: any) => e.score);
      expect(scores).toEqual([80, 70, 50, 50, 20]);
    });

    it('sorts by string field ascending', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { sort: 'companyName', order: 'asc' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      const names = result.map((e: any) => e.companyName);
      expect(names).toEqual([
        'Apex Solutions Ltd',
        'BlueSky Tech',
        'Cornerstone Corp',
        'Delta Dynamics',
        'Echo Enterprises',
      ]);
    });

    it('sorts by string field descending', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { sort: 'companyName', order: 'desc' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      const names = result.map((e: any) => e.companyName);
      expect(names).toEqual([
        'Echo Enterprises',
        'Delta Dynamics',
        'Cornerstone Corp',
        'BlueSky Tech',
        'Apex Solutions Ltd',
      ]);
    });

    it('sorts by date field ascending', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { sort: 'createdAt', order: 'asc' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      const dates = result.map((e: any) => e.createdAt);
      expect(dates).toEqual([
        '2025-01-01T00:00:00.000Z',
        '2025-02-15T00:00:00.000Z',
        '2025-03-10T00:00:00.000Z',
        '2025-04-01T00:00:00.000Z',
        '2025-05-20T00:00:00.000Z',
      ]);
    });

    it('sorts by date field descending', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { sort: 'createdAt', order: 'desc' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      const dates = result.map((e: any) => e.createdAt);
      expect(dates).toEqual([
        '2025-05-20T00:00:00.000Z',
        '2025-04-01T00:00:00.000Z',
        '2025-03-10T00:00:00.000Z',
        '2025-02-15T00:00:00.000Z',
        '2025-01-01T00:00:00.000Z',
      ]);
    });

    it('handles null/undefined field values by sorting them to the end', () => {
      const graph = makeGraph([
        { id: 'a', score: 10 },
        { id: 'b', score: null },
        { id: 'c', score: 30 },
      ]);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { sort: 'score', order: 'asc' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result[0].score).toBe(10);
      expect(result[1].score).toBe(30);
      expect(result[2].score).toBeNull();
    });

    it('sorting is applied before pagination', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { sort: 'score', order: 'desc', limit: '2' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as { items: Array<{ score: number }> };
      expect(result.items).toHaveLength(2);
      expect(result.items[0].score).toBe(80);
      expect(result.items[1].score).toBe(70);
    });

    it('no-op when sort param is absent', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: {},
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(5);
    });
  });

  // ── Comparison operators ────────────────────────────────────────────────────

  describe('comparison operators (gt, gte, lt, lte)', () => {
    it('gt: filters entities with score > 50', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'score:gt': '50' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result.every((e: any) => e.score > 50)).toBe(true);
      expect(result).toHaveLength(2); // 70 and 80
    });

    it('gte: filters entities with score >= 50', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'score:gte': '50' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result.every((e: any) => e.score >= 50)).toBe(true);
      expect(result).toHaveLength(4); // 50, 50, 70, 80
    });

    it('lt: filters entities with score < 50', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'score:lt': '50' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result.every((e: any) => e.score < 50)).toBe(true);
      expect(result).toHaveLength(1); // 20
    });

    it('lte: filters entities with score <= 50', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'score:lte': '50' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result.every((e: any) => e.score <= 50)).toBe(true);
      expect(result).toHaveLength(3); // 20, 50, 50
    });

    it('ne: filters entities with score != 50', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'score:ne': '50' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result.every((e: any) => e.score !== 50)).toBe(true);
      expect(result).toHaveLength(3); // 20, 70, 80
    });

    it('comparison on date fields', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'createdAt:gte': '2025-03-01T00:00:00.000Z' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(3); // March, April, May
    });

    it('excludes entities with null field value for gt', () => {
      const graph = makeGraph([
        { id: 'a', score: 10 },
        { id: 'b', score: null },
      ]);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'score:gt': '5' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('a');
    });

    it('ne includes entities with null field value', () => {
      const graph = makeGraph([
        { id: 'a', score: 10 },
        { id: 'b', score: null },
      ]);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'score:ne': '10' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('b');
    });
  });

  // ── String operators ────────────────────────────────────────────────────────

  describe('string operators (contains, startsWith, endsWith)', () => {
    it('contains: case-insensitive substring match', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'companyName:contains': 'Corp' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(1);
      expect(result[0].companyName).toBe('Cornerstone Corp');
    });

    it('contains: case-insensitive', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'companyName:contains': 'corp' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(1);
    });

    it('startsWith: prefix match', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'companyName:startsWith': 'Blue' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(1);
      expect(result[0].companyName).toBe('BlueSky Tech');
    });

    it('startsWith: case-insensitive', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'companyName:startsWith': 'blue' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(1);
    });

    it('endsWith: suffix match', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'companyName:endsWith': 'Tech' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(1);
      expect(result[0].companyName).toBe('BlueSky Tech');
    });

    it('endsWith: case-insensitive', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'companyName:endsWith': 'tech' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(1);
    });

    it('string operator returns false for non-string field', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'score:contains': '50' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(0);
    });
  });

  // ── IN operator ─────────────────────────────────────────────────────────────

  describe('IN operator (?field:in=value1,value2)', () => {
    it('filters by set of values', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'status:in': 'NEW,CONTACTED' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(3); // 2 NEW + 1 CONTACTED
      result.forEach((e: any) => {
        expect(['NEW', 'CONTACTED']).toContain(e.status);
      });
    });

    it('single value in IN operator', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'status:in': 'QUALIFIED' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('QUALIFIED');
    });

    it('IN with values containing spaces', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'status:in': 'NEW, CONTACTED' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(3); // trims whitespace
    });
  });

  // ── Full-text search ────────────────────────────────────────────────────────

  describe('full-text search (?q=searchTerm)', () => {
    it('searches across all string fields case-insensitively', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { q: 'apex' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(1);
      expect(result[0].companyName).toBe('Apex Solutions Ltd');
    });

    it('matches contact name field', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { q: 'Jordan' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(1);
      expect(result[0].contactName).toBe('Jordan');
    });

    it('returns multiple matches', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { q: 'lead-' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      // All 5 entities have 'lead-' in their id field
      expect(result).toHaveLength(5);
    });

    it('returns empty array when no match', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { q: 'nonexistent-string-xyz' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(0);
    });

    it('empty search term returns all entities', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { q: '' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(5);
    });

    it('does not match on non-string fields', () => {
      const graph = makeGraph([
        { id: 'a', name: 'Test', score: 42 },
      ]);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { q: '42' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      // score is a number, not a string — should not match
      expect(result).toHaveLength(0);
    });
  });

  // ── Combined filters ───────────────────────────────────────────────────────

  describe('combined filters', () => {
    it('operator filter + sorting', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'score:gte': '50', sort: 'score', order: 'desc' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      expect(result).toHaveLength(4);
      const scores = result.map((e: any) => e.score);
      expect(scores).toEqual([80, 70, 50, 50]);
    });

    it('queryMapping + operator filter', () => {
      const graph = makeGraph(sampleEntities);
      const boundary = makeBoundary({
        queryMapping: { status: 'state.status == param' },
      });
      const result = runQuery({
        boundary,
        targetId: null,
        queryParams: { status: 'NEW', 'score:gte': '50' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      // Only NEW leads with score >= 50
      expect(result).toHaveLength(2);
      result.forEach((e: any) => {
        expect(e.status).toBe('NEW');
        expect(e.score).toBeGreaterThanOrEqual(50);
      });
    });

    it('full-text search + sorting', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { q: 'NEW', sort: 'companyName', order: 'asc' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      // NEW matches status field of lead-1 and lead-5
      expect(result).toHaveLength(2);
      expect(result[0].companyName).toBe('Apex Solutions Ltd');
      expect(result[1].companyName).toBe('Echo Enterprises');
    });

    it('operator filter + full-text search + sorting + pagination', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'score:gte': '50', q: 'lead-', sort: 'score', order: 'desc', limit: '2' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as { items: Array<{ score: number }> };
      expect(result.items).toHaveLength(2);
      expect(result.items[0].score).toBe(80);
      expect(result.items[1].score).toBe(70);
    });

    it('invalid operator key is ignored', () => {
      const graph = makeGraph(sampleEntities);
      const result = runQuery({
        boundary: makeBoundary(),
        targetId: null,
        queryParams: { 'score:bogus': '50' },
        graph,
        cel,
        openapi: emptyDoc,
      }) as any[];
      // Unrecognized operator — treated as plain query param (no queryMapping for it), so no filtering
      expect(result).toHaveLength(5);
    });
  });
});
