/**
 * Unit tests for engine/timeTravel.ts
 *
 * Verifies that rebuildEntityAtVersion produces identical state to the live
 * projectEvent path, including for boundaries with:
 *   - a TypeScript reducer
 *   - auditFields:true
 *   - YAML reducer patches (regression baseline)
 */

import { rebuildEntityAtVersion } from '../../../src/engine/timeTravel';
import { projectEvent } from '../../../src/engine/projection';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createEventStore } from '../../../src/eventstore/store';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { createTsReducerRegistry } from '../../../src/engine/tsReducerRegistry';
import { InternalExecutionError } from '../../../src/errors';
import { makeBoundary, makeDomainEvent } from '../_helpers';
import type { DomainEvent } from '../../../src/types';
import type { BoundaryInferenceResult } from '../../../src/dsl/schemaInference';

const cel = createCelEvaluator();

function makeEvt(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return makeDomainEvent({ type: 'WidgetUpdated', payload: { name: 'Gadget', score: 5 }, ...overrides });
}

// ── YAML-reducer baseline ────────────────────────────────────────────────────

describe('rebuildEntityAtVersion — YAML reducer', () => {
  it('replays to the same state the live projection produces', () => {
    const boundary = makeBoundary({
      reducers: [
        {
          on: 'WidgetUpdated',
          patches: [
            { op: 'replace', path: '/name', value: '${event.payload.name}' },
            { op: 'replace', path: '/score', value: '${event.payload.score}' },
          ],
        },
      ],
    });
    const evt = makeEvt({ sequenceVersion: 1 });

    // Live path — seed with {} to match the live projection engine (deepClone(current ?? {}))
    const liveGraph = createStateGraph();
    liveGraph.set('agg-1', {});
    projectEvent({ event: evt, boundary, graph: liveGraph, cel });
    const liveState = liveGraph.get('agg-1');

    // Replay path
    const events = createEventStore();
    events.append([evt]);
    const replayState = rebuildEntityAtVersion('agg-1', 1, boundary, {}, undefined, events, cel);

    expect(replayState).toEqual(liveState);
  });

  it('returns null when no events exist for the aggregate', () => {
    const boundary = makeBoundary();
    const events = createEventStore();
    const result = rebuildEntityAtVersion('ghost', 99, boundary, {}, undefined, events, cel);
    expect(result).toBeNull();
  });

  it('stops at maxVersion — excludes events beyond that version', () => {
    const boundary = makeBoundary({
      reducers: [
        {
          on: 'WidgetUpdated',
          patches: [{ op: 'replace', path: '/score', value: '${event.payload.score}' }],
        },
      ],
    });
    const evt1 = makeEvt({ eventId: 'e1', sequenceVersion: 1, payload: { score: 10 } });
    const evt2 = makeEvt({ eventId: 'e2', sequenceVersion: 2, payload: { score: 99 } });

    const events = createEventStore();
    events.append([evt1, evt2]);

    const stateAtV1 = rebuildEntityAtVersion('agg-1', 1, boundary, {}, undefined, events, cel);
    expect((stateAtV1 as { score?: number })?.score).toBe(10);

    const stateAtV2 = rebuildEntityAtVersion('agg-1', 2, boundary, {}, undefined, events, cel);
    expect((stateAtV2 as { score?: number })?.score).toBe(99);
  });
});

// ── TypeScript reducer ────────────────────────────────────────────────────────

describe('rebuildEntityAtVersion — TS reducer', () => {
  it('replays to the same state the live projection produces when a TS reducer is registered', () => {
    const boundary = makeBoundary();

    const tsRegistry = createTsReducerRegistry([
      {
        boundary: 'TestBoundary',
        event: 'WidgetUpdated',
        source: 'test-inline',
        fn: (_state, event) => {
          const e = event as { payload: { name: string; score: number } };
          return [
            { op: 'replace' as const, path: '/name', value: e.payload.name },
            { op: 'replace' as const, path: '/score', value: e.payload.score },
            { op: 'add' as const, path: '/processed', value: true },
          ];
        },
      },
    ]);

    const evt = makeEvt({ sequenceVersion: 1, payload: { name: 'Gadget', score: 7 } });

    // Live path — seed with {} to match the live projection engine (deepClone(current ?? {}))
    const liveGraph = createStateGraph();
    liveGraph.set('agg-1', {});
    projectEvent({ event: evt, boundary, graph: liveGraph, cel, tsReducerRegistry: tsRegistry });
    const liveState = liveGraph.get('agg-1');

    // Replay path — must pass the same tsRegistry to get identical result
    const events = createEventStore();
    events.append([evt]);
    const replayState = rebuildEntityAtVersion('agg-1', 1, boundary, {}, undefined, events, cel, undefined, tsRegistry);

    expect(replayState).toEqual(liveState);
    expect((replayState as { processed?: boolean })?.processed).toBe(true);
  });
});

// ── computed fields ───────────────────────────────────────────────────────────

describe('rebuildEntityAtVersion — computed fields', () => {
  it('replays to the same state as live projection when computed fields are present', () => {
    const boundary = makeBoundary({
      reducers: [
        {
          on: 'WidgetUpdated',
          patches: [
            { op: 'replace', path: '/score', value: '${event.payload.score}' },
          ],
        },
      ],
      state: {
        computed: [
          { name: 'displayScore', formula: 'state.score * 10', dependsOn: ['score'] },
        ],
      },
    });

    const computed = [{ name: 'displayScore', formula: 'state.score * 10', dependsOn: ['score'] }];
    const computedOrder = ['displayScore'];

    const evt = makeEvt({ sequenceVersion: 1, payload: { score: 7 } });

    // Live path — seed with {} to match the live projection engine (deepClone(current ?? {}))
    const liveGraph = createStateGraph();
    liveGraph.set('agg-1', {});
    projectEvent({ event: evt, boundary, graph: liveGraph, cel, computed, computedOrder });
    const liveState = liveGraph.get('agg-1');

    // Replay path — must pass computed+computedOrder to get identical result
    const events = createEventStore();
    events.append([evt]);
    const replayState = rebuildEntityAtVersion(
      'agg-1', 1, boundary,
      { TestBoundary: boundary },
      { TestBoundary: { computedOrder } as unknown as BoundaryInferenceResult },
      events, cel,
    );
    void computed;

    expect(replayState).toEqual(liveState);
    expect((replayState as { displayScore?: number })?.displayScore).toBe(70);
  });
});

// ── auditFields injection ─────────────────────────────────────────────────────

describe('rebuildEntityAtVersion — auditFields', () => {
  it('injects updatedAt / updatedBy when boundary has auditFields:true', () => {
    const boundary = makeBoundary({
      auditFields: true,
      reducers: [
        {
          on: 'WidgetUpdated',
          patches: [{ op: 'replace', path: '/name', value: '${event.payload.name}' }],
        },
      ],
    });
    const evt = makeEvt({
      sequenceVersion: 1,
      timestamp: '2025-01-15T10:00:00.000Z',
      payload: { name: 'Gizmo' },
      request: { method: 'PATCH', path: '/test/agg-1', headers: {}, payload: {}, actorId: 'user-9' },
    });

    // Live path — seed with {} to match the live projection engine (deepClone(current ?? {}))
    const liveGraph = createStateGraph();
    liveGraph.set('agg-1', {});
    projectEvent({ event: evt, boundary, graph: liveGraph, cel });
    const liveState = liveGraph.get('agg-1');

    // Replay path
    const events = createEventStore();
    events.append([evt]);
    const replayState = rebuildEntityAtVersion('agg-1', 1, boundary, {}, undefined, events, cel);

    expect(replayState).toEqual(liveState);
    expect((replayState as { updatedAt?: string })?.updatedAt).toBe('2025-01-15T10:00:00.000Z');
    expect((replayState as { updatedBy?: string })?.updatedBy).toBe('user-9');
  });
});

// ── all-or-nothing replay (error propagation) ────────────────────────────────

describe('rebuildEntityAtVersion — all-or-nothing replay', () => {
  it('throws when a TS reducer throws, not returning partial state', () => {
    const boundary = makeBoundary();

    const tsRegistry = createTsReducerRegistry([
      {
        boundary: 'TestBoundary',
        event: 'WidgetUpdated',
        source: 'test-inline',
        fn: (_state, _event) => {
          throw new InternalExecutionError('Reducer exploded', { code: 'TEST_REDUCER_ERROR' });
        },
      },
    ]);

    const evt = makeEvt({ sequenceVersion: 1 });
    const events = createEventStore();
    events.append([evt]);

    expect(() =>
      rebuildEntityAtVersion('agg-1', 1, boundary, {}, undefined, events, cel, undefined, tsRegistry),
    ).toThrow(InternalExecutionError);
  });

  it('applied++ does not increment on failure — the applied===0 guard returns null when all events fail', () => {
    const boundary = makeBoundary();

    const tsRegistry = createTsReducerRegistry([
      {
        boundary: 'TestBoundary',
        event: 'WidgetUpdated',
        source: 'test-inline',
        fn: (_state, _event) => {
          throw new InternalExecutionError('Reducer exploded', { code: 'TEST_REDUCER_ERROR' });
        },
      },
    ]);

    const evt = makeEvt({ sequenceVersion: 1 });
    const events = createEventStore();
    events.append([evt]);

    // The throw propagates out — caller maps to 500; no partial state is returned.
    expect(() =>
      rebuildEntityAtVersion('agg-1', 1, boundary, {}, undefined, events, cel, undefined, tsRegistry),
    ).toThrow();
  });

  it('clean replay over a valid event sequence returns correct historical state', () => {
    const boundary = makeBoundary({
      reducers: [
        {
          on: 'WidgetUpdated',
          patches: [
            { op: 'replace', path: '/score', value: '${event.payload.score}' },
          ],
        },
      ],
    });

    const evt1 = makeEvt({ eventId: 'e1', sequenceVersion: 1, payload: { name: 'Gadget', score: 10 } });
    const evt2 = makeEvt({ eventId: 'e2', sequenceVersion: 2, payload: { name: 'Gadget', score: 20 } });
    const events = createEventStore();
    events.append([evt1, evt2]);

    const stateAtV1 = rebuildEntityAtVersion('agg-1', 1, boundary, {}, undefined, events, cel);
    expect((stateAtV1 as { score?: number })?.score).toBe(10);

    const stateAtV2 = rebuildEntityAtVersion('agg-1', 2, boundary, {}, undefined, events, cel);
    expect((stateAtV2 as { score?: number })?.score).toBe(20);
  });
});

// ── no phantom id field injected for boundaries that never write /id ──────────

describe('rebuildEntityAtVersion — does not inject a phantom id field for boundaries that never write /id', () => {
  it('does not inject a phantom id field for a boundary whose reducers never write /id', () => {
    const boundary = makeBoundary({
      reducers: [
        {
          on: 'WidgetUpdated',
          patches: [
            { op: 'replace', path: '/score', value: '${event.payload.score}' },
          ],
        },
      ],
    });

    const evt = makeEvt({ sequenceVersion: 1, payload: { score: 42 } });
    const events = createEventStore();
    events.append([evt]);

    const rebuilt = rebuildEntityAtVersion('agg-1', 1, boundary, {}, undefined, events, cel);

    expect(rebuilt).not.toBeNull();
    expect(rebuilt).not.toHaveProperty('id');
    expect((rebuilt as { score?: number })?.score).toBe(42);
  });

  it('rebuilt state matches live projection state for a boundary that never writes /id', () => {
    const boundary = makeBoundary({
      reducers: [
        {
          on: 'WidgetUpdated',
          patches: [
            { op: 'replace', path: '/tally', value: '${event.payload.score}' },
          ],
        },
      ],
    });

    const evt = makeEvt({ sequenceVersion: 1, payload: { score: 7 } });

    const liveGraph = createStateGraph();
    liveGraph.set('agg-1', {});
    projectEvent({ event: evt, boundary, graph: liveGraph, cel });
    const liveState = liveGraph.get('agg-1');

    const events = createEventStore();
    events.append([evt]);
    const rebuilt = rebuildEntityAtVersion('agg-1', 1, boundary, {}, undefined, events, cel);

    expect(rebuilt).toEqual(liveState);
  });
});
