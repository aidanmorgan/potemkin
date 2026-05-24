/**
 * AUDIT: engine/patternMatcher.ts — completeness probing tests
 *
 * Verified behaviours → it(...)
 * Identified gaps    → it.failing(...)
 */

import { runPatternMatch } from '../../../src/engine/patternMatcher';
import type { PatternMatchInput } from '../../../src/engine/patternMatcher';
import {
  EntityAbsenceError,
  InternalExecutionError,
  UnhandledOperationError,
} from '../../../src/errors';
import { makeBoundary, makeCommand } from '../_helpers';
import type { ShadowGraph } from '../../../src/stategraph/shadow';

// ── minimal helpers ────────────────────────────────────────────────────────────

function makeNoopShadow(initial: Record<string, Record<string, unknown> | null> = {}): ShadowGraph {
  const staged = new Map<string, Record<string, unknown>>();

  return {
    get: (id: string) => {
      if (staged.has(id)) return staged.get(id) as any;
      return initial[id] ?? null;
    },
    stage: jest.fn((id: string, val: any) => { staged.set(id, val); }),
    has: (id: string) => staged.has(id) || (initial[id] ?? null) !== null,
    shadowed: () => staged as any,
    commitInto: jest.fn(),
  } as unknown as ShadowGraph;
}

const alwaysTrueCel = { compile: (e: string) => ({ source: e }), evaluate: () => true } as any;
const alwaysFalseCel = { compile: (e: string) => ({ source: e }), evaluate: () => false } as any;

function makeInput(overrides: Partial<PatternMatchInput> = {}): PatternMatchInput {
  return {
    command: makeCommand({ intent: 'creation', targetId: null }),
    boundary: makeBoundary({
      behaviors: [
        { name: 'b1', match: { intent: 'creation', condition: 'true' }, emit: 'Created' },
      ],
      eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
    }),
    shadow: makeNoopShadow(),
    cel: alwaysTrueCel,
    nextEventId: () => 'evt-1',
    nextSequenceVersion: () => 1,
    projectToShadow: jest.fn(),
    now: () => '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── VERIFIED: first-match semantics ───────────────────────────────────────────

it('CONTRACT: returns on first matching behavior and does not continue evaluating', () => {
  // Two behaviors with the same intent; first matches. Confirm second is never evaluated.
  const evalOrder: string[] = [];
  const trackingCel = {
    compile: (e: string) => ({ source: e }),
    evaluate: (_expr: string, _ctx: unknown) => {
      // We know only the condition field drives matching; we can track via the expr value
      evalOrder.push(_expr as string);
      return true; // first call returns true → should stop
    },
  } as any;

  const input = makeInput({
    command: makeCommand({ intent: 'creation', targetId: null }),
    boundary: makeBoundary({
      behaviors: [
        { name: 'first', match: { intent: 'creation', condition: 'FIRST' }, emit: 'Created' },
        { name: 'second', match: { intent: 'creation', condition: 'SECOND' }, emit: 'Created' },
      ],
      eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
    }),
    cel: trackingCel,
  });

  runPatternMatch(input);

  // Only the first behavior's condition should have been evaluated
  const conditionEvals = evalOrder.filter(e => e === 'FIRST' || e === 'SECOND');
  expect(conditionEvals).toContain('FIRST');
  expect(conditionEvals).not.toContain('SECOND');
});

it('CONTRACT: throws InternalExecutionError when emit references unknown event catalog type', () => {
  // The runtime double-checks emit against eventCatalog, not just the static checker.
  expect(() =>
    runPatternMatch(makeInput({
      boundary: makeBoundary({
        behaviors: [
          { name: 'b1', match: { intent: 'creation', condition: 'true' }, emit: 'NonExistentType' },
        ],
        eventCatalog: [{ type: 'OtherType', payloadTemplate: {} }],
      }),
      cel: alwaysTrueCel,
    })),
  ).toThrow(InternalExecutionError);
});

it('CONTRACT: InternalExecutionError message names the bad emit reference', () => {
  try {
    runPatternMatch(makeInput({
      boundary: makeBoundary({
        behaviors: [
          { name: 'b1', match: { intent: 'creation', condition: 'true' }, emit: 'GhostEvent' },
        ],
        eventCatalog: [],
      }),
      cel: alwaysTrueCel,
    }));
    fail('Expected InternalExecutionError');
  } catch (e) {
    expect((e as Error).message).toContain('GhostEvent');
  }
});

// ── AUDIT GAP: fallback_override + intent=query + targetId=null ───────────────

it('CONTRACT: fallback_override query with null targetId returns empty (not throws EntityAbsenceError)', () => {
  // Design §3 req 33: collection-level query with no behavior match → return empty, not throw.
  // Observed: lines 241-247 in patternMatcher.ts — returns { events:[], state:null } for null targetId
  const result = runPatternMatch(makeInput({
    command: makeCommand({ intent: 'query', targetId: null }),
    boundary: makeBoundary({
      fallbackOverride: true,
      behaviors: [],
      eventCatalog: [],
    }),
    shadow: makeNoopShadow(),
    cel: alwaysFalseCel,
  }));

  expect(result.events).toHaveLength(0);
  expect(result.state).toBeNull();
});

it('CONTRACT: fallback_override query with present targetId returns current state (no throw)', () => {
  const existingState = { id: 'e1', status: 'active' };
  const result = runPatternMatch(makeInput({
    command: makeCommand({ intent: 'query', targetId: 'e1' }),
    boundary: makeBoundary({
      fallbackOverride: true,
      behaviors: [],
      eventCatalog: [],
    }),
    shadow: makeNoopShadow({ 'e1': existingState }),
    cel: alwaysFalseCel,
  }));

  expect(result.state).toMatchObject({ id: 'e1' });
});

// ── AUDIT GAP: fallback_override + intent=query + targetId set but entity absent ─

it('CONTRACT: fallback_override query with absent non-null targetId throws EntityAbsenceError (no gap here)', () => {
  // patternMatcher.ts: querying a specific absent entity with fallback_override still throws
  // EntityAbsenceError — the fallback_override only suppresses UnhandledOperationError on
  // non-query intents, not the 404 entity-not-found check.
  expect(() =>
    runPatternMatch(makeInput({
      command: makeCommand({ intent: 'query', targetId: 'missing' }),
      boundary: makeBoundary({
        fallbackOverride: true,
        behaviors: [],
        eventCatalog: [],
      }),
      shadow: makeNoopShadow(), // 'missing' not in shadow → returns null
      cel: alwaysFalseCel,
    })),
  ).toThrow();
});

// ── AUDIT GAP: CEL condition throws → treated as no-match (silent skip) ───────

it('CONTRACT: CEL condition evaluation error is silently treated as no-match (continues to next behavior)', () => {
  // patternMatcher.ts lines 110-113: catch block treats CEL error as false/no-match.
  // Verify: if first behavior throws, second behavior is tried.
  let callCount = 0;
  const errorThenTrueCel = {
    compile: (e: string) => ({ source: e }),
    evaluate: (_expr: string) => {
      callCount++;
      if (callCount === 1) throw new Error('CEL error on first call');
      return true;
    },
  } as any;

  const result = runPatternMatch(makeInput({
    command: makeCommand({ intent: 'creation', targetId: null }),
    boundary: makeBoundary({
      behaviors: [
        { name: 'throws', match: { intent: 'creation', condition: 'c1' }, emit: 'Created' },
        { name: 'succeeds', match: { intent: 'creation', condition: 'c2' }, emit: 'Created' },
      ],
      eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
    }),
    cel: errorThenTrueCel,
  }));

  expect(result.events).toHaveLength(1);
});

// ── AUDIT GAP: no match + no fallback → UnhandledOperationError ───────────────

it('CONTRACT: no match + no fallback_override throws UnhandledOperationError', () => {
  expect(() =>
    runPatternMatch(makeInput({
      command: makeCommand({ intent: 'mutation', targetId: 'x' }),
      boundary: makeBoundary({
        fallbackOverride: false,
        behaviors: [],
        eventCatalog: [],
      }),
      shadow: makeNoopShadow({ 'x': { id: 'x' } }),
      cel: alwaysFalseCel,
    })),
  ).toThrow(UnhandledOperationError);
});

// ── AUDIT GAP: projectToShadow called immediately after first-match ────────────

it('CONTRACT: projectToShadow is called once per matched behavior (causal consistency)', () => {
  const projectToShadow = jest.fn();
  runPatternMatch(makeInput({ projectToShadow }));
  expect(projectToShadow).toHaveBeenCalledTimes(1);
});

// ── AUDIT GAP: query fallback_override with absent non-null targetId (confirmed gap) ─

it('CONTRACT: fallback_override + query + absent targetId throws EntityAbsenceError (verified in code)', () => {
  // This confirms the code at line 249-254 IS correct — no gap here.
  expect(() =>
    runPatternMatch(makeInput({
      command: makeCommand({ intent: 'query', targetId: 'absent-id' }),
      boundary: makeBoundary({
        fallbackOverride: true,
        behaviors: [],
        eventCatalog: [],
      }),
      shadow: makeNoopShadow(),
      cel: alwaysFalseCel,
    })),
  ).toThrow(EntityAbsenceError);
});
