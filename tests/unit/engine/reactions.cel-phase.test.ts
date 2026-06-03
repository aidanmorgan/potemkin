/**
 * reactions.cel-phase.test.ts — R5: CEL context/phase and deterministic ordering.
 *
 * Acceptance criteria (potemkin-atbe / R5):
 *  1. when/target/payload evaluate against { event, payload } where event carries
 *     type, aggregateId, payload, sequenceVersion, boundary; payload aliases event.payload.
 *  2. $now()/$uuidv7() are permitted in the emitted event's payload_template
 *     (CelPhase.EventHydration); the same builtins used inside the emitted event's
 *     reducer throw CEL_PHASE_BANNED (CelPhase.Reducer).
 *  3. Deterministic ordering: for a single trigger event, matching reactions fire in
 *     boundary-name-ascending order, then declaration index. This is enforced by an
 *     explicit two-key sort, not sort-stability assumptions.
 */

import { createCelEvaluator } from '../../../src/cel/evaluator';
import { createStateGraph } from '../../../src/stategraph/graph';
import { CelPhase } from '../../../src/cel/phases';
import { projectEvent } from '../../../src/engine/projection';
import { makeBoundary, makeDomainEvent } from '../_helpers';

// ---------------------------------------------------------------------------
// AC2 — reducer-phase ban for $uuidv7 and $now
// ---------------------------------------------------------------------------
// The emitted event's reducers run via projectEvent (CelPhase.Reducer).
// Prove that using $uuidv7() or $now() in a reducer patch value throws CEL_PHASE_BANNED.

describe('R5 AC2: non-deterministic builtins throw CEL_PHASE_BANNED in reducer phase', () => {
  const cel = createCelEvaluator();

  it('$uuidv7() in a reducer patch value throws CEL_PHASE_BANNED', () => {
    const graph = createStateGraph();
    graph.set('agg-1', {});

    const boundary = makeBoundary({
      reducers: [
        {
          on: 'TestEvent',
          patches: [{ op: 'replace', path: '/id', value: '${$uuidv7()}' }],
        },
      ],
    });

    const event = makeDomainEvent({ type: 'TestEvent', payload: {} });

    expect(() => projectEvent({ event, boundary, graph, cel })).toThrow('CEL_PHASE_BANNED');
  });

  it('$now() in a reducer patch value throws CEL_PHASE_BANNED', () => {
    const graph = createStateGraph();
    graph.set('agg-1', {});

    const boundary = makeBoundary({
      reducers: [
        {
          on: 'TestEvent',
          patches: [{ op: 'replace', path: '/ts', value: '${$now()}' }],
        },
      ],
    });

    const event = makeDomainEvent({ type: 'TestEvent', payload: {} });

    expect(() => projectEvent({ event, boundary, graph, cel })).toThrow('CEL_PHASE_BANNED');
  });

  it('$uuidv7() is permitted in EventHydration phase', () => {
    // The CEL evaluator evaluating $uuidv7() in EventHydration phase must NOT throw.
    const result = cel.evaluate('$uuidv7()', {}, CelPhase.EventHydration);
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);
  });

  it('$now() is permitted in EventHydration phase', () => {
    const result = cel.evaluate('$now()', {}, CelPhase.EventHydration);
    expect(typeof result).toBe('string');
    // ISO-8601 date string
    expect(new Date(result as string).getTime()).toBeGreaterThan(0);
  });

  it('$uuidv7() in Behavior phase does not throw', () => {
    const result = cel.evaluate('$uuidv7()', {}, CelPhase.Behavior);
    expect(typeof result).toBe('string');
  });

  it('$uuidv7() in Reducer phase throws CEL_PHASE_BANNED', () => {
    expect(() => cel.evaluate('$uuidv7()', {}, CelPhase.Reducer)).toThrow('CEL_PHASE_BANNED');
  });

  it('$now() in Reducer phase throws CEL_PHASE_BANNED', () => {
    expect(() => cel.evaluate('$now()', {}, CelPhase.Reducer)).toThrow('CEL_PHASE_BANNED');
  });
});

// ---------------------------------------------------------------------------
// AC3 — deterministic sort order: boundary name ascending, then declaration index
// ---------------------------------------------------------------------------
// Test the sort logic indirectly by checking that the exported sort behaviour in
// fireReactions produces a stable two-key order, using a minimal mock setup.

import { fireReactions } from '../../../src/engine/reactions';
import type { CompiledDsl } from '../../../src/dsl/types';
import type { DomainEvent } from '../../../src/types';

/**
 * Build a minimal CompiledDsl with a reactionsByTrigger map that has two reactions
 * for the same trigger event, assigned to different boundaries in a specified order.
 *
 * The registry buckets are built directly to avoid needing the full compileDsl pipeline.
 */
function makeMinimalDsl(reactions: Array<{ boundary: string; name: string }>): CompiledDsl {
  const byBoundaryName: Record<string, ReturnType<typeof makeBoundary>> = {};
  for (const r of reactions) {
    byBoundaryName[r.boundary] = makeBoundary({
      boundary: r.boundary,
      contractPath: `/test-${r.boundary.toLowerCase()}`,
      eventCatalog: [
        {
          type: 'NotifyEvent',
          payloadTemplate: {
            id: 'event.aggregateId',
          },
        },
      ],
      reducers: [
        {
          on: 'NotifyEvent',
          patches: [{ op: 'replace', path: '/id', value: '${event.payload.id}' }],
        },
      ],
    });
  }

  const reactionRules = reactions.map(r => ({
    name: r.name,
    on: 'TriggerBoundary:TriggerEvent',
    boundary: r.boundary,
    emit: 'NotifyEvent',
    intent: 'mutation' as const,
    target: '"agg-1"',
  }));

  const reactionsByTrigger = new Map([
    ['TriggerBoundary:TriggerEvent', reactionRules],
  ]);

  return {
    boundaries: Object.values(byBoundaryName),
    byContractPath: {},
    byBoundaryName,
    reactionsByTrigger,
  } as unknown as CompiledDsl;
}

describe('R5 AC3: reactions for a single trigger fire in boundary-name-ascending order', () => {
  const cel = createCelEvaluator();

  /**
   * Fire reactions for a trigger and return the boundary names of emitted events in order.
   * Uses fireReactions directly with a minimal DSL to isolate the ordering logic.
   */
  function getEmittedBoundaryOrder(reactions: Array<{ boundary: string; name: string }>): string[] {
    const dsl = makeMinimalDsl(reactions);
    const shadowGraph = createStateGraph();
    shadowGraph.set('agg-1', { id: 'agg-1' });

    const triggerEvent: DomainEvent = {
      eventId: 'evt-trigger-1',
      boundary: 'TriggerBoundary',
      aggregateId: 'agg-trigger-1',
      type: 'TriggerEvent',
      payload: {},
      timestamp: '2024-01-01T00:00:00.000Z',
      sequenceVersion: 1,
      causedBy: 'cmd-1',
    };

    let seq = 0;
    const emitted = fireReactions({
      triggerEvent,
      dsl,
      shadowGraph,
      cel,
      nextEventId: () => `evt-${++seq}`,
      now: () => '2024-01-01T00:00:00.000Z',
      nextSequenceVersion: () => 1,
      firedReactions: new Set(),
      currentReactionEventCount: 0,
    });

    return emitted.map(e => e.boundary);
  }

  it('Alpha boundary fires before Bravo when declared Bravo-first', () => {
    // Registry declares Bravo first, then Alpha — sort must override declaration order
    const order = getEmittedBoundaryOrder([
      { boundary: 'Bravo', name: 'bravo-reaction' },
      { boundary: 'Alpha', name: 'alpha-reaction' },
    ]);
    expect(order).toEqual(['Alpha', 'Bravo']);
  });

  it('Alpha boundary fires before Bravo when declared Alpha-first', () => {
    // Declaration order already matches sort order — must still be correct
    const order = getEmittedBoundaryOrder([
      { boundary: 'Alpha', name: 'alpha-reaction' },
      { boundary: 'Bravo', name: 'bravo-reaction' },
    ]);
    expect(order).toEqual(['Alpha', 'Bravo']);
  });

  it('ordering is identical across two independent runs (determinism)', () => {
    const reactions = [
      { boundary: 'Bravo', name: 'bravo-reaction' },
      { boundary: 'Alpha', name: 'alpha-reaction' },
    ];
    const run1 = getEmittedBoundaryOrder(reactions);
    const run2 = getEmittedBoundaryOrder(reactions);
    expect(run1).toEqual(run2);
    expect(run1).toEqual(['Alpha', 'Bravo']);
  });

  it('three boundaries sort in ascending name order regardless of declaration order', () => {
    const order = getEmittedBoundaryOrder([
      { boundary: 'Zebra', name: 'z-reaction' },
      { boundary: 'Alpha', name: 'a-reaction' },
      { boundary: 'Mango', name: 'm-reaction' },
    ]);
    expect(order).toEqual(['Alpha', 'Mango', 'Zebra']);
  });

  it('two reactions on the same boundary fire in declaration index order', () => {
    // Both reactions target the same boundary — tiebreaker is declaration index.
    // To observe the order, each reaction targets a different aggregate.
    const dsl = makeMinimalDsl([
      { boundary: 'Alpha', name: 'alpha-first' },
      { boundary: 'Alpha', name: 'alpha-second' },
    ]);

    // Override targets so both fire (dedup by reactionId@aggregateId, not by boundary)
    const reactionRules = [
      {
        name: 'alpha-first',
        on: 'TriggerBoundary:TriggerEvent',
        boundary: 'Alpha',
        emit: 'NotifyEvent',
        intent: 'mutation' as const,
        target: '"agg-1"',
      },
      {
        name: 'alpha-second',
        on: 'TriggerBoundary:TriggerEvent',
        boundary: 'Alpha',
        emit: 'NotifyEvent',
        intent: 'mutation' as const,
        target: '"agg-2"',
      },
    ];

    const dslWithDistinctTargets = {
      ...dsl,
      reactionsByTrigger: new Map([['TriggerBoundary:TriggerEvent', reactionRules]]),
    } as unknown as CompiledDsl;

    const shadowGraph = createStateGraph();
    shadowGraph.set('agg-1', { id: 'agg-1' });
    shadowGraph.set('agg-2', { id: 'agg-2' });

    const triggerEvent: DomainEvent = {
      eventId: 'evt-trigger-1',
      boundary: 'TriggerBoundary',
      aggregateId: 'agg-trigger-1',
      type: 'TriggerEvent',
      payload: {},
      timestamp: '2024-01-01T00:00:00.000Z',
      sequenceVersion: 1,
      causedBy: 'cmd-1',
    };

    let seq = 0;
    const emitted = fireReactions({
      triggerEvent,
      dsl: dslWithDistinctTargets,
      shadowGraph,
      cel,
      nextEventId: () => `evt-${++seq}`,
      now: () => '2024-01-01T00:00:00.000Z',
      nextSequenceVersion: () => 1,
      firedReactions: new Set(),
      currentReactionEventCount: 0,
    });

    // alpha-first targets agg-1, alpha-second targets agg-2; declaration order preserved
    expect(emitted).toHaveLength(2);
    expect(emitted[0]!.aggregateId).toBe('agg-1');
    expect(emitted[1]!.aggregateId).toBe('agg-2');
  });
});
