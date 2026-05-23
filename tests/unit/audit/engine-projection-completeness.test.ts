/**
 * AUDIT: engine/projection.ts — completeness probing tests
 *
 * Verified behaviours → it(...)
 * Identified gaps    → it.failing(...)
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
    reducers: [{ on: 'StatusChanged', assign: { status: '"active"' } }],
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

// ── AUDIT GAP: reducer assign with CEL returning undefined ────────────────────

it.failing('AUDIT GAP: reducer assign where CEL returns undefined — entity gets undefined property (design violation)', () => {
  // Observed: projection.ts line 101: value = cel.evaluate(...) cast to JsonValue
  // If CEL returns undefined (e.g. accessing a missing field), it is set on the entity as undefined.
  // This violates JsonObject type contract and may cause silent data corruption.
  const undefinedCel = {
    compile: (e: string) => ({ source: e }),
    evaluate: () => undefined,
  } as any;

  const graph = createStateGraph();
  graph.set('agg-1', { existingField: 'value' });

  const boundary = makeBoundary({
    reducers: [{ on: 'Ev', assign: { newField: 'undefinedExpr' } }],
  });

  projectEvent({
    event: makeDomainEvent({ type: 'Ev', payload: {} }),
    boundary,
    graph,
    cel: undefinedCel,
    // No validator — so no guard
  });

  const state = graph.get('agg-1');
  // The test "fails" by design: we expect the engine to reject/skip undefined values,
  // but it actually sets them. The it.failing marker captures this gap.
  expect(state?.newField).not.toBeUndefined();
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

// ── VERIFIED: reducer assign CEL error throws InternalExecutionError ──────────

it('CONTRACT: reducer assign CEL error throws InternalExecutionError (not silently skipped)', () => {
  // Unlike patternMatcher where CEL errors mean no-match, in projection CEL errors throw.
  const graph = createStateGraph();
  graph.set('agg-1', {});
  const boundary = makeBoundary({
    reducers: [{ on: 'Ev', assign: { field: 'undefined_identifier' } }],
  });
  expect(() =>
    projectEvent({ event: makeDomainEvent({ type: 'Ev', payload: {} }), boundary, graph, cel }),
  ).toThrow(InternalExecutionError);
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
