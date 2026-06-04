/**
 * reactions.guards.test.ts — mutation-kill tests for two strict guards in fireReactions.
 *
 * bead 8uu7 (reaction half): the `when` gate uses strict boolean equality (`=== true`).
 *   A truthy-non-true CEL result (non-empty string, number 1, etc.) must NOT fire the
 *   reaction. A mutation to loose truthiness (`!gateResult` inverted, or `if (gateResult)`)
 *   would let these through silently.
 *
 * bead ng5u (budget half): the per-UoW budget check uses `>= budget` (not `> budget`).
 *   Exactly `budget` events emitted in a single fireReactions call must succeed (no throw),
 *   and exactly `budget + 1` must throw ReactionBudgetExceededError. A `>=` → `>` mutation
 *   would allow the budget+1 case to pass silently.
 */

import { createCelEvaluator } from '../../../src/cel/evaluator';
import { createStateGraph } from '../../../src/stategraph/graph';
import { fireReactions } from '../../../src/engine/reactions';
import { ReactionBudgetExceededError } from '../../../src/errors';
import type { CompiledDsl } from '../../../src/dsl/types';
import type { DomainEvent } from '../../../src/types';
import { makeBoundary } from '../_helpers';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal CompiledDsl for a single boundary that reacts to TriggerEvent.
 * Each reaction target must be a DISTINCT aggregate id (so dedup never suppresses them)
 * unless the caller intentionally wants dedup.
 */
function makeGateDsl(whenExpr: string): CompiledDsl {
  const boundary = makeBoundary({
    boundary: 'Target',
    contractPath: '/test-target',
    eventCatalog: [
      {
        type: 'TargetEvent',
        payloadTemplate: { id: 'event.aggregateId' },
      },
    ],
    reducers: [
      {
        on: 'TargetEvent',
        patches: [{ op: 'replace', path: '/id', value: '${event.payload.id}' }],
      },
    ],
  });

  const reactionRule = {
    name: 'gated-reaction',
    on: 'TriggerBoundary:TriggerEvent',
    boundary: 'Target',
    emit: 'TargetEvent',
    intent: 'mutation' as const,
    target: '"agg-target"',
    when: whenExpr,
  };

  return {
    boundaries: [boundary],
    byContractPath: {},
    byBoundaryName: { Target: boundary },
    reactionsByTrigger: new Map([['TriggerBoundary:TriggerEvent', [reactionRule]]]),
  } as unknown as CompiledDsl;
}

function makeTriggerEvent(): DomainEvent {
  return {
    eventId: 'evt-trigger-guards',
    boundary: 'TriggerBoundary',
    aggregateId: 'agg-trigger',
    type: 'TriggerEvent',
    payload: {},
    timestamp: '2024-01-01T00:00:00.000Z',
    sequenceVersion: 1,
    causedBy: 'cmd-guards',
  };
}

/**
 * Build a fan-out DSL where N distinct reactions each target their own unique aggregate.
 * This lets us emit exactly N events from one fireReactions call without dedup interference.
 */
function makeFanOutDsl(count: number): { dsl: CompiledDsl; aggregateIds: string[] } {
  const boundary = makeBoundary({
    boundary: 'FanOut',
    contractPath: '/test-fanout',
    eventCatalog: [
      {
        type: 'FanEvent',
        payloadTemplate: { id: 'event.aggregateId' },
      },
    ],
    reducers: [
      {
        on: 'FanEvent',
        patches: [{ op: 'replace', path: '/id', value: '${event.payload.id}' }],
      },
    ],
  });

  const aggregateIds = Array.from({ length: count }, (_, i) => `fan-agg-${i}`);

  const reactionRules = aggregateIds.map((aggId, i) => ({
    name: `fan-reaction-${i}`,
    on: 'TriggerBoundary:TriggerEvent',
    boundary: 'FanOut',
    emit: 'FanEvent',
    intent: 'mutation' as const,
    // Inline CEL string literal for the target aggregate id
    target: `"${aggId}"`,
  }));

  const dsl: CompiledDsl = {
    boundaries: [boundary],
    byContractPath: {},
    byBoundaryName: { FanOut: boundary },
    reactionsByTrigger: new Map([['TriggerBoundary:TriggerEvent', reactionRules]]),
  } as unknown as CompiledDsl;

  return { dsl, aggregateIds };
}

// ---------------------------------------------------------------------------
// bead 8uu7 (reaction half): strict === true gate
// ---------------------------------------------------------------------------
//
// The `when` guard at reactions.ts ~233 is:
//   if (gateResult !== true) { ... continue; }
//
// A mutation to loose truthiness (`!gateResult` or `if (!gateResult)`) would let a
// non-empty string or the number 1 pass the gate and fire the reaction.
// These tests would fail under that mutation.

describe('8uu7 reaction gate: truthy-non-true when result must NOT fire the reaction', () => {
  const cel = createCelEvaluator();

  function fireWithGate(whenExpr: string): readonly DomainEvent[] {
    const dsl = makeGateDsl(whenExpr);
    const shadowGraph = createStateGraph();
    shadowGraph.set('agg-target', { id: 'agg-target' });

    let seq = 0;
    return fireReactions({
      triggerEvent: makeTriggerEvent(),
      dsl,
      shadowGraph,
      cel,
      nextEventId: () => `evt-${++seq}`,
      now: () => '2024-01-01T00:00:00.000Z',
      nextSequenceVersion: () => 1,
      firedReactions: new Set(),
      currentReactionEventCount: 0,
    });
  }

  it('when gate returning a non-empty string ("yes") suppresses the reaction', () => {
    // CEL `"yes"` evaluates to the string "yes" — truthy but not the boolean true.
    // gateResult !== true → reaction must be skipped (0 emitted events).
    // Under a !gateResult / loose-truthiness mutation, "yes" is truthy → reaction fires.
    const emitted = fireWithGate('"yes"');
    expect(emitted).toHaveLength(0);
  });

  it('when gate returning the number 1 suppresses the reaction', () => {
    // CEL `1` evaluates to the integer 1 — truthy but not the boolean true.
    // gateResult !== true → reaction must be skipped (0 emitted events).
    // Under a loose mutation, 1 is truthy → reaction fires.
    const emitted = fireWithGate('1');
    expect(emitted).toHaveLength(0);
  });

  it('when gate returning boolean true fires the reaction (control)', () => {
    // Confirm the guard is not over-restrictive: explicit true must pass.
    const emitted = fireWithGate('true');
    expect(emitted).toHaveLength(1);
  });

  it('when gate returning boolean false suppresses the reaction (baseline)', () => {
    // false !== true → reaction suppressed. This would be caught by existing tests
    // but is included here as a counterpart to the truthy-non-true cases.
    const emitted = fireWithGate('false');
    expect(emitted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// bead ng5u (budget half): exact boundary for >= budget check
// ---------------------------------------------------------------------------
//
// The budget check at reactions.ts ~318 is:
//   const totalReactionEvents = input.currentReactionEventCount + emittedEvents.length;
//   if (totalReactionEvents >= budget) { throw ReactionBudgetExceededError; }
//
// With `currentReactionEventCount = 0` and N fan-out reactions (each unique aggregate):
//   - After processing the kth reaction (0-indexed), emittedEvents.length = k.
//   - At the start of processing reaction k, totalReactionEvents = k.
//   - For k = 0..budget-1: totalReactionEvents < budget → proceeds → emits.
//   - For k = budget: totalReactionEvents = budget >= budget → throws.
//
// So: budget = N → exactly N events succeed, the (N+1)th throws.
//
// A `>=` → `>` mutation would allow the budget+1 case to pass silently.
// These two tests kill that mutation:

describe('ng5u reaction budget: >= boundary — exactly budget events allowed, budget+1 throws', () => {
  const cel = createCelEvaluator();

  function fireWithBudget(reactionCount: number, budget: number): readonly DomainEvent[] {
    const { dsl, aggregateIds } = makeFanOutDsl(reactionCount);
    const shadowGraph = createStateGraph();
    for (const id of aggregateIds) {
      shadowGraph.set(id, { id });
    }

    let seq = 0;
    return fireReactions({
      triggerEvent: makeTriggerEvent(),
      dsl,
      shadowGraph,
      cel,
      nextEventId: () => `evt-${++seq}`,
      now: () => '2024-01-01T00:00:00.000Z',
      nextSequenceVersion: () => 1,
      firedReactions: new Set(),
      currentReactionEventCount: 0,
      maxUowEvents: budget,
    });
  }

  // Use a small, precise budget so the test is fast and the boundary is unambiguous.
  const BUDGET = 4;

  it(`exactly budget (${BUDGET}) reaction events are allowed — no error`, () => {
    // BUDGET reactions, budget = BUDGET → totalReactionEvents peaks at BUDGET-1 < BUDGET → all fire.
    // Under a >= → > mutation, BUDGET events would still succeed (no difference here).
    // This test is the "green side" that confirms the feature works.
    expect(() => fireWithBudget(BUDGET, BUDGET)).not.toThrow();
    const emitted = fireWithBudget(BUDGET, BUDGET);
    expect(emitted).toHaveLength(BUDGET);
  });

  it(`exactly budget+1 (${BUDGET + 1}) reaction events throws ReactionBudgetExceededError`, () => {
    // BUDGET+1 reactions, budget = BUDGET → at the (BUDGET+1)th attempt,
    // totalReactionEvents = BUDGET >= BUDGET → throws.
    // Under a >= → > mutation: BUDGET > BUDGET is false → the (BUDGET+1)th event fires
    // silently — this test would FAIL, catching the mutation.
    expect(() => fireWithBudget(BUDGET + 1, BUDGET)).toThrow(ReactionBudgetExceededError);
  });

  it(`budget+1 error has HTTP status 508`, () => {
    try {
      fireWithBudget(BUDGET + 1, BUDGET);
      throw new Error('Expected ReactionBudgetExceededError');
    } catch (err) {
      expect(err).toBeInstanceOf(ReactionBudgetExceededError);
      expect((err as ReactionBudgetExceededError).status).toBe(508);
    }
  });

  it('budget-1 reactions with budget = budget-1 all succeed (budget-1 < budget is not an off-by-one)', () => {
    // Confirm that budget-1 events with budget = budget-1 also pass cleanly.
    const b = BUDGET - 1;
    expect(() => fireWithBudget(b, b)).not.toThrow();
    const emitted = fireWithBudget(b, b);
    expect(emitted).toHaveLength(b);
  });
});
