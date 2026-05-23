/**
 * AUDIT: engine/query.ts — completeness probing tests
 *
 * Verified behaviours → it(...)
 * Identified gaps    → it.failing(...)
 */

import { runQuery } from '../../../src/engine/query';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { EntityAbsenceError } from '../../../src/errors';
import { makeBoundary } from '../_helpers';
import type { BoundaryConfig } from '../../../src/dsl/types';

const cel = createCelEvaluator();

// OpenAPI doc with x-derived properties
function makeOpenApiWithDerived(boundary: string, derivedProps: Record<string, string>): any {
  const properties: Record<string, any> = {
    id: { type: 'string' },
    value: { type: 'number' },
  };
  for (const [propName, expr] of Object.entries(derivedProps)) {
    properties[propName] = { type: 'number', 'x-derived': expr };
  }
  return {
    raw: {
      components: {
        schemas: {
          [boundary]: {
            type: 'object',
            properties,
          },
        },
      },
    },
    paths: {},
  };
}

// ── VERIFIED: pagination applies limit and offset correctly ───────────────────

it('CONTRACT: limit query param slices the result set', () => {
  const graph = createStateGraph();
  for (let i = 0; i < 5; i++) {
    graph.set(`e${i}`, { id: `e${i}`, value: i });
  }

  const result = runQuery({
    boundary: makeBoundary(),
    targetId: null,
    queryParams: { limit: '2' },
    graph,
    cel,
    openapi: { raw: {}, paths: {} },
  }) as any[];

  expect(result).toHaveLength(2);
});

it('CONTRACT: offset query param skips leading entries', () => {
  const graph = createStateGraph();
  for (let i = 0; i < 5; i++) {
    graph.set(`e${i}`, { id: `e${i}`, value: i });
  }

  const result = runQuery({
    boundary: makeBoundary(),
    targetId: null,
    queryParams: { offset: '3' },
    graph,
    cel,
    openapi: { raw: {}, paths: {} },
  }) as any[];

  expect(result).toHaveLength(2);
});

it('CONTRACT: limit=0 returns empty array', () => {
  const graph = createStateGraph();
  graph.set('e1', { id: 'e1', value: 1 });
  graph.set('e2', { id: 'e2', value: 2 });

  const result = runQuery({
    boundary: makeBoundary(),
    targetId: null,
    queryParams: { limit: '0' },
    graph,
    cel,
    openapi: { raw: {}, paths: {} },
  }) as any[];

  expect(result).toHaveLength(0);
});

it('CONTRACT: invalid limit (non-numeric string) is ignored — returns all', () => {
  const graph = createStateGraph();
  graph.set('e1', { id: 'e1' });
  graph.set('e2', { id: 'e2' });

  const result = runQuery({
    boundary: makeBoundary(),
    targetId: null,
    queryParams: { limit: 'abc' },
    graph,
    cel,
    openapi: { raw: {}, paths: {} },
  }) as any[];

  // NaN limit should be ignored → return all
  expect(result).toHaveLength(2);
});

it('CONTRACT: negative offset is clamped to 0', () => {
  const graph = createStateGraph();
  graph.set('e1', { id: 'e1' });
  graph.set('e2', { id: 'e2' });

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

// ── VERIFIED: queryMapping CEL filters are applied ────────────────────────────

it('CONTRACT: queryMapping filter is applied when matching query param present', () => {
  const graph = createStateGraph();
  graph.set('e1', { id: 'e1', status: 'active' });
  graph.set('e2', { id: 'e2', status: 'inactive' });
  graph.set('e3', { id: 'e3', status: 'active' });

  const boundary = makeBoundary({
    queryMapping: { status: 'state.status == param' },
  });

  const result = runQuery({
    boundary,
    targetId: null,
    queryParams: { status: 'active' },
    graph,
    cel,
    openapi: { raw: {}, paths: {} },
  }) as any[];

  expect(result).toHaveLength(2);
  expect(result.every((e: any) => e.status === 'active')).toBe(true);
});

it('CONTRACT: queryMapping is skipped when param is absent from queryParams', () => {
  const graph = createStateGraph();
  graph.set('e1', { id: 'e1', status: 'active' });
  graph.set('e2', { id: 'e2', status: 'inactive' });

  const boundary = makeBoundary({
    queryMapping: { status: 'state.status == param' },
  });

  const result = runQuery({
    boundary,
    targetId: null,
    queryParams: {}, // no 'status' param
    graph,
    cel,
    openapi: { raw: {}, paths: {} },
  }) as any[];

  expect(result).toHaveLength(2);
});

// ── VERIFIED: x-derived properties applied to ALL entities in collection ──────

it('CONTRACT: derived properties are computed for ALL entities in a collection query', () => {
  // query.ts line 127: sliced.map(entity => applyDerivedProperties(...))
  // Each entity in the sliced result gets derived props applied, not just the first.
  const graph = createStateGraph();
  graph.set('e1', { id: 'e1', value: 10 });
  graph.set('e2', { id: 'e2', value: 20 });
  graph.set('e3', { id: 'e3', value: 30 });

  const openapi = makeOpenApiWithDerived('TestBoundary', { doubled: 'state.value * 2' });

  const result = runQuery({
    boundary: makeBoundary(),
    targetId: null,
    queryParams: {},
    graph,
    cel,
    openapi,
  }) as any[];

  expect(result).toHaveLength(3);
  // ALL entities must have the derived property computed
  for (const entity of result) {
    expect(typeof entity.doubled).toBe('number');
    expect(entity.doubled).toBe((entity.value as number) * 2);
  }
});

it('CONTRACT: derived properties are applied to single-entity query result', () => {
  const graph = createStateGraph();
  graph.set('e1', { id: 'e1', value: 15 });

  const openapi = makeOpenApiWithDerived('TestBoundary', { tripled: 'state.value * 3' });

  const result = runQuery({
    boundary: makeBoundary(),
    targetId: 'e1',
    queryParams: {},
    graph,
    cel,
    openapi,
  }) as any;

  expect(result.tripled).toBe(45);
});

// ── AUDIT GAP: derived property CEL error is silently skipped ────────────────

it('AUDIT GAP (documented): derived property CEL evaluation failure silently skips the property — no error surfaced to caller', () => {
  // query.ts lines 183-188: catch block logs and silently skips failed derived props.
  // Design implication: a misconfigured x-derived expression never surfaces as an error.
  // This is a silent-skip that could produce subtly wrong API responses.
  // This test documents the actual behaviour (silent skip) rather than the desired behaviour.

  const alwaysThrowCel = {
    compile: (e: string) => ({ source: e }),
    evaluate: (_expr: string) => {
      throw new Error('CEL runtime error');
    },
  } as any;

  const graph = createStateGraph();
  graph.set('e1', { id: 'e1', value: 5 });

  const openapi = makeOpenApiWithDerived('TestBoundary', { computed: 'state.value * 2' });

  // Should NOT throw — the error is silently caught
  let result: any;
  expect(() => {
    result = runQuery({
      boundary: makeBoundary(),
      targetId: 'e1',
      queryParams: {},
      graph,
      cel: alwaysThrowCel,
      openapi,
    });
  }).not.toThrow();

  // The derived property 'computed' is silently absent (gap: no error indicator)
  expect('computed' in result).toBe(false);
});

// ── AUDIT GAP: collection query when boundary has no schema → no derived props ─

it('CONTRACT: missing schema in OpenAPI returns entity unchanged (no derived props error)', () => {
  const graph = createStateGraph();
  graph.set('e1', { id: 'e1' });

  const result = runQuery({
    boundary: makeBoundary({ boundary: 'UnknownBoundary' }),
    targetId: 'e1',
    queryParams: {},
    graph,
    cel,
    openapi: { raw: {}, paths: {} }, // no schema for UnknownBoundary
  }) as any;

  expect(result).toEqual({ id: 'e1' });
});

// ── VERIFIED: single entity query returns 404 for absent entity ───────────────

it('CONTRACT: single entity query throws EntityAbsenceError for absent targetId', () => {
  const graph = createStateGraph();

  expect(() =>
    runQuery({
      boundary: makeBoundary(),
      targetId: 'absent-id',
      queryParams: {},
      graph,
      cel,
      openapi: { raw: {}, paths: {} },
    }),
  ).toThrow(EntityAbsenceError);
});

// ── AUDIT GAP: collection query does not filter by boundary — returns ALL graph entries ─

it.failing('AUDIT GAP: collection query returns ALL graph entries regardless of boundary — no boundary-scoping filter', () => {
  // query.ts line 81: graph.values() returns ALL entities across ALL boundaries.
  // There is no filter to restrict results to only the entities belonging to this boundary.
  // This is a critical gap if boundaries share a single StateGraph (which they do in this impl).
  // A Widget collection query would return Accounts too!
  const graph = createStateGraph();
  graph.set('widget-1', { id: 'widget-1', type: 'Widget' });
  graph.set('account-1', { id: 'account-1', type: 'Account' }); // different boundary's entity

  const result = runQuery({
    boundary: makeBoundary({ boundary: 'Widget' }),
    targetId: null,
    queryParams: {},
    graph,
    cel,
    openapi: { raw: {}, paths: {} },
  }) as any[];

  // Expected: only Widget entities (1 result)
  // Observed: all entities in graph regardless of boundary (2 results)
  expect(result).toHaveLength(1);
});
