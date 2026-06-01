/**
 * Unit tests for engine/timeTravel.ts (potemkin-5d39)
 *
 * Verifies that rebuildEntityAtVersion produces identical state to the live
 * projectEvent path, including for boundaries with:
 *   - a TypeScript reducer (C3)
 *   - auditFields:true
 *   - YAML reducer patches (regression baseline)
 */

import { rebuildEntityAtVersion } from '../../../src/engine/timeTravel';
import { projectEvent } from '../../../src/engine/projection';
import { createStateGraph } from '../../../src/stategraph/graph';
import { createEventStore } from '../../../src/eventstore/store';
import { createCelEvaluator } from '../../../src/cel/evaluator';
import { createTsReducerRegistry } from '../../../src/engine/tsReducerRegistry';
import { makeBoundary, makeDomainEvent } from '../_helpers';
import type { DomainEvent } from '../../../src/types';

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

    // Live path
    const liveGraph = createStateGraph();
    liveGraph.set('agg-1', { id: 'agg-1' });
    projectEvent({ event: evt, boundary, graph: liveGraph, cel });
    const liveState = liveGraph.get('agg-1');

    // Replay path
    const events = createEventStore();
    events.append([evt]);
    const replayState = rebuildEntityAtVersion('agg-1', 1, boundary, events, cel);

    expect(replayState).toEqual(liveState);
  });

  it('returns null when no events exist for the aggregate', () => {
    const boundary = makeBoundary();
    const events = createEventStore();
    const result = rebuildEntityAtVersion('ghost', 99, boundary, events, cel);
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

    const stateAtV1 = rebuildEntityAtVersion('agg-1', 1, boundary, events, cel);
    expect((stateAtV1 as { score?: number })?.score).toBe(10);

    const stateAtV2 = rebuildEntityAtVersion('agg-1', 2, boundary, events, cel);
    expect((stateAtV2 as { score?: number })?.score).toBe(99);
  });
});

// ── TypeScript reducer (C3) — potemkin-5d39 core ─────────────────────────────

describe('rebuildEntityAtVersion — TS reducer (potemkin-5d39)', () => {
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

    // Live path
    const liveGraph = createStateGraph();
    liveGraph.set('agg-1', { id: 'agg-1' });
    projectEvent({ event: evt, boundary, graph: liveGraph, cel, tsReducerRegistry: tsRegistry });
    const liveState = liveGraph.get('agg-1');

    // Replay path — must pass the same tsRegistry to get identical result
    const events = createEventStore();
    events.append([evt]);
    const replayState = rebuildEntityAtVersion('agg-1', 1, boundary, events, cel, undefined, tsRegistry);

    expect(replayState).toEqual(liveState);
    expect((replayState as { processed?: boolean })?.processed).toBe(true);
  });
});

// ── computed fields — potemkin-e2oh ──────────────────────────────────────────

describe('rebuildEntityAtVersion — computed fields (potemkin-e2oh)', () => {
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

    // Live path — projectEvent with computed fields
    const liveGraph = createStateGraph();
    liveGraph.set('agg-1', { id: 'agg-1' });
    projectEvent({ event: evt, boundary, graph: liveGraph, cel, computed, computedOrder });
    const liveState = liveGraph.get('agg-1');

    // Replay path — must pass computed+computedOrder to get identical result
    const events = createEventStore();
    events.append([evt]);
    const replayState = rebuildEntityAtVersion(
      'agg-1', 1, boundary, events, cel, undefined, undefined, computed, computedOrder,
    );

    expect(replayState).toEqual(liveState);
    expect((replayState as { displayScore?: number })?.displayScore).toBe(70);
  });
});

// ── auditFields injection — potemkin-5d39 ────────────────────────────────────

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

    // Live path
    const liveGraph = createStateGraph();
    liveGraph.set('agg-1', { id: 'agg-1' });
    projectEvent({ event: evt, boundary, graph: liveGraph, cel });
    const liveState = liveGraph.get('agg-1');

    // Replay path
    const events = createEventStore();
    events.append([evt]);
    const replayState = rebuildEntityAtVersion('agg-1', 1, boundary, events, cel);

    expect(replayState).toEqual(liveState);
    expect((replayState as { updatedAt?: string })?.updatedAt).toBe('2025-01-15T10:00:00.000Z');
    expect((replayState as { updatedBy?: string })?.updatedBy).toBe('user-9');
  });
});
