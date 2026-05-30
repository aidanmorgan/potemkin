/**
 * AUDIT: engine/projection.ts — completeness probing tests
 *
 * All tests use plain it(...) — they assert behaviour that must hold in src.
 */

import { projectEvent } from '../../../src/engine/projection';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { InternalExecutionError } from '../../../src/errors';
import { makeBoundary, makeDomainEvent } from '../_helpers';

const cel = createCelEvaluator();

// ── VERIFIED: validator.validateEntity is called when validator is supplied ────

it('CONTRACT: validator.validateEntity is called after successful reducer execution', () => {
  // Design §6.2 step 3 / req 22: post-mutation entity must be validated before atomic swap.
  // Observed in projection.ts lines 150-152: if (validator) { validator.validateEntity(...) }
  const validateEntity = jest.fn();
  const validator = { validateEntity, validateResponse: jest.fn() } as any;

  const graph = createStateGraph();
  graph.set('agg-1', { status: 'pending' });

  const boundary = makeBoundary({
    reducers: [{ on: 'StatusChanged', patches: [{ op: 'replace', path: '/status', value: '${"active"}' }] }],
  });

  projectEvent({
    event: makeDomainEvent({ type: 'StatusChanged', payload: {} }),
    boundary,
    graph,
    cel,
    validator,
  });

  expect(validateEntity).toHaveBeenCalledTimes(1);
  expect(validateEntity).toHaveBeenCalledWith('TestBoundary', expect.any(Object));
});

it('CONTRACT: validator.validateEntity is NOT called when no validator is provided', () => {
  // When validator is omitted, projection still completes successfully (it's optional).
  const graph = createStateGraph();
  graph.set('agg-1', {});

  expect(() =>
    projectEvent({
      event: makeDomainEvent({ type: 'System.GenericUpdateEvent', payload: { x: 1 } }),
      boundary: makeBoundary(),
      graph,
      cel,
      // No validator supplied
    }),
  ).not.toThrow();
});

// ── AUDIT GAP: validator.validateEntity called BEFORE the atomic swap ─────────

it('CONTRACT: atomic swap (graph.set) occurs after validateEntity (write-after-validate)', () => {
  // projection.ts lines 150-155: validate, then graph.set
  // Confirm that if validateEntity throws, graph.set is NOT called.
  const validateEntity = jest.fn().mockImplementation(() => {
    throw new InternalExecutionError('Schema violation');
  });
  const validator = { validateEntity, validateResponse: jest.fn() } as any;

  const graph = createStateGraph();
  graph.set('agg-1', { status: 'old' });

  const setFn = jest.spyOn(graph, 'set');

  expect(() =>
    projectEvent({
      event: makeDomainEvent({ type: 'System.GenericUpdateEvent', payload: { status: 'new' } }),
      boundary: makeBoundary(),
      graph,
      cel,
      validator,
    }),
  ).toThrow(InternalExecutionError);

  // graph.set should not have been called after validateEntity threw
  expect(setFn).not.toHaveBeenCalled();
  // Original value should be intact
  expect(graph.get('agg-1')?.status).toBe('old');
});

// ── VERIFIED: GenericUpdateEvent deep-merges payload ─────────────────────────

it('CONTRACT: GenericUpdateEvent deep-merges without overwriting unrelated keys', () => {
  const graph = createStateGraph();
  graph.set('agg-1', { a: 1, b: 2 });

  projectEvent({
    event: makeDomainEvent({ type: 'System.GenericUpdateEvent', payload: { b: 99, c: 3 } }),
    boundary: makeBoundary(),
    graph,
    cel,
  });

  const state = graph.get('agg-1')!;
  expect(state.a).toBe(1);
  expect(state.b).toBe(99);
  expect(state.c).toBe(3);
});

// ── VERIFIED: BaselineEntityCreatedEvent replaces state entirely ───────────────

it('CONTRACT: BaselineEntityCreatedEvent replaces entire state (no merge)', () => {
  const graph = createStateGraph();
  graph.set('agg-1', { old: 'data', keep: false });

  projectEvent({
    event: makeDomainEvent({ type: 'BaselineEntityCreatedEvent', payload: { id: 'agg-1', fresh: true } }),
    boundary: makeBoundary(),
    graph,
    cel,
  });

  const state = graph.get('agg-1')!;
  expect(state).toEqual({ id: 'agg-1', fresh: true });
  expect(state).not.toHaveProperty('old');
  expect(state).not.toHaveProperty('keep');
});

// ── VERIFIED: reducer patch applies resolved CEL value ────────────────────────

it('CONTRACT: reducer replace patch applies the resolved CEL value to state', () => {
  const graph = createStateGraph();
  graph.set('agg-1', { field: 'old' });
  const boundary = makeBoundary({
    reducers: [{ on: 'Ev', patches: [{ op: 'replace', path: '/field', value: '${"resolved"}' }] }],
  });
  projectEvent({ event: makeDomainEvent({ type: 'Ev', payload: {} }), boundary, graph, cel });
  expect(graph.get('agg-1')?.field).toBe('resolved');
});

// ── AUDIT GAP: no matching reducer — entity left as-is (not an error) ─────────

it('CONTRACT: event with no matching reducer leaves entity unchanged (no error)', () => {
  // If there is no reducer matching the event type, projection silently skips reducer phase.
  // Observed in projection.ts line 83: filter returns empty array, loop body never runs.
  const graph = createStateGraph();
  graph.set('agg-1', { preserved: 'value' });

  expect(() =>
    projectEvent({
      event: makeDomainEvent({ type: 'UnknownEventType', payload: { ignored: true } }),
      boundary: makeBoundary({ reducers: [] }),
      graph,
      cel,
    }),
  ).not.toThrow();

  expect(graph.get('agg-1')?.preserved).toBe('value');
});
