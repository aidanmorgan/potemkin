/**
 * AUDIT: engine/query.ts — completeness probing tests
 *
 * All tests use plain it(...) — they assert behaviour that must hold in src.
 */

import { runQuery } from '../../../src/engine/query';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createEventStore } from '../../../src/eventstore/store';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { EntityAbsenceError } from '../../../src/errors';
import { makeBoundary } from '../_helpers';

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

it('CONTRACT: limit query param slices the result set (envelope form)', () => {
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
  }) as { items: unknown[] };

  expect(result.items).toHaveLength(2);
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

it('CONTRACT: limit=0 returns empty items array (envelope form)', () => {
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
  }) as { items: unknown[] };

  expect(result.items).toHaveLength(0);
});

it('CONTRACT: invalid limit (non-numeric string) returns all in envelope', () => {
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
  }) as { items: unknown[] };

  // NaN limit should be ignored → return all
  expect(result.items).toHaveLength(2);
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

// ── derived property CEL error is logged at warn and returns null ─────────────

it('derived property CEL evaluation failure logs warn and sets property to null (not silently absent)', () => {
  // The catch block logs at warn and sets the derived property to null, making
  // misconfigured x-derived expressions detectable. Should NOT throw — partial
  // responses are returned with null for failed derived props.

  const alwaysThrowCel = {
    compile: (e: string) => ({ source: e }),
    evaluate: (_expr: string) => {
      throw new Error('CEL runtime error');
    },
  } as any;

  const graph = createStateGraph();
  graph.set('e1', { id: 'e1', value: 5 });

  const openapi = makeOpenApiWithDerived('TestBoundary', { computed: 'state.value * 2' });

  // Should NOT throw — the error is caught and property set to null
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

  // The derived property 'computed' is present but null (sentinel for failed computation)
  expect('computed' in result).toBe(true);
  expect(result.computed).toBeNull();
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

// ── collection query filters by boundary using event store ───────────────────

it('collection query scopes results to the requested boundary via event store', () => {
  // The events store is used to filter entities to those originating from the
  // requested boundary; without this, graph.values() leaks across boundaries.
  const graph = createStateGraph();
  const events = createEventStore();

  // Populate events with the correct boundary for each entity
  events.append([
    {
      eventId: 'evt-widget-1',
      boundary: 'Widget',
      aggregateId: 'widget-1',
      type: 'BaselineEntityCreatedEvent',
      payload: { id: 'widget-1', type: 'Widget' },
      timestamp: '1970-01-01T00:00:00.000Z',
      sequenceVersion: 1,
      causedBy: null,
    },
  ]);
  events.append([
    {
      eventId: 'evt-account-1',
      boundary: 'Account',
      aggregateId: 'account-1',
      type: 'BaselineEntityCreatedEvent',
      payload: { id: 'account-1', type: 'Account' },
      timestamp: '1970-01-01T00:00:00.000Z',
      sequenceVersion: 1,
      causedBy: null,
    },
  ]);

  graph.set('widget-1', { id: 'widget-1', type: 'Widget' });
  graph.set('account-1', { id: 'account-1', type: 'Account' });

  const result = runQuery({
    boundary: makeBoundary({ boundary: 'Widget' }),
    targetId: null,
    queryParams: {},
    graph,
    cel,
    openapi: { raw: {}, paths: {} },
    events,
  }) as any[];

  // Only Widget entities should be returned, not Account entities
  expect(result).toHaveLength(1);
  expect(result[0].id).toBe('widget-1');
});
