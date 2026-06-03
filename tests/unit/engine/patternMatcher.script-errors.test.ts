/**
 * potemkin-j1iw — Script runtime errors in match.condition / requires[] / emit_when
 *
 * A scanned @Script that throws a genuine runtime error must surface as
 * InternalExecutionError (HTTP 500), not be silently swallowed as no-match
 * or treated as a 422 UNHANDLED_OPERATION.
 *
 * The postcondition path (~lines 445-449) already re-throws InternalExecutionError
 * correctly; these tests verify the three other catch blocks now behave the same.
 *
 * AC4 regression: genuine CEL false / type-mismatch remains a no-match/skip.
 */

import { runPatternMatch } from '../../../src/engine/patternMatcher';
import type { PatternMatchInput } from '../../../src/engine/patternMatcher';
import {
  InternalExecutionError,
  UnhandledOperationError,
} from '../../../src/errors';
import { makeBoundary, makeCommand, makeOpenApi } from '../_helpers';
import type { ShadowGraph } from '../../../src/stategraph/shadow';
import type { ScriptRegistry, ScriptHandle } from '../../../src/scripts/types';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeNoopShadow(state: Record<string, unknown> | null = null): ShadowGraph {
  const staged = new Map<string, Record<string, unknown>>();
  return {
    get: (id: string) => staged.has(id) ? staged.get(id) as Record<string, unknown> : state,
    stage: (id: string, val: Record<string, unknown>) => { staged.set(id, val); },
    has: (id: string) => staged.has(id) || state !== null,
    shadowed: () => staged as Map<string, Record<string, unknown>>,
    commitInto: jest.fn(),
  } as unknown as ShadowGraph;
}

/**
 * Build a ScriptRegistry that returns a single ScriptHandle whose fn throws
 * the supplied error. Mirrors how buildCompositeScriptRegistry wraps a scanned
 * @Script: handle.fn is the raw host function, no sandbox wrapping.
 */
function makeThrowingRegistry(name: string, err: unknown): ScriptRegistry {
  const handle: ScriptHandle = {
    name,
    boundary: 'TestBoundary',
    source: `class:Throwing${name}`,
    fn: () => { throw err; },
  };
  return {
    get(boundary: string, scriptName: string): ScriptHandle | undefined {
      return scriptName === name ? handle : undefined;
    },
    has(boundary: string, scriptName: string): boolean {
      return scriptName === name;
    },
    size(): number { return 1; },
  };
}

/** Cel stub that always returns true (used when we want CEL condition to pass). */
const fakeCelTrue = {
  compile: (e: string) => ({ source: e, _ast: {} as any }),
  evaluate: () => true,
};

/** Cel stub that always returns false (used for AC4 genuine-CEL-false regression). */
const fakeCelFalse = {
  compile: (e: string) => ({ source: e, _ast: {} as any }),
  evaluate: () => false,
};

/** Cel stub that throws (used for AC4 genuine-CEL-throw regression). */
const fakeCelThrows = {
  compile: (e: string) => ({ source: e, _ast: {} as any }),
  evaluate: () => { throw new Error('CEL type error'); },
};

function makeInput(overrides: Partial<PatternMatchInput> = {}): PatternMatchInput {
  return {
    command: makeCommand({ intent: 'mutation', targetId: 'agg-1', httpMethod: 'PATCH', path: '/test/agg-1' }),
    boundary: makeBoundary(),
    shadow: makeNoopShadow({ status: 'ACTIVE' }),
    cel: fakeCelTrue as any,
    nextEventId: () => 'evt-1',
    nextSequenceVersion: () => 1,
    projectToShadow: jest.fn(),
    now: () => '2024-01-01T00:00:00.000Z',
    openapi: makeOpenApi(),
    ...overrides,
  };
}

// ── AC1: match.condition @Script throws → InternalExecutionError (500) ─────────

describe('AC1: throwing @Script in match.condition surfaces as InternalExecutionError', () => {
  it('re-throws as InternalExecutionError when the condition script throws TypeError', () => {
    const scriptErr = new TypeError('cannot read property of null');
    const registry = makeThrowingRegistry('checkCondition', scriptErr);

    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'guarded',
          match: { operationId: 'updateTest', condition: 'ts:checkCondition' },
          emit: 'Updated',
        },
      ],
      eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
    });

    expect(() =>
      runPatternMatch(makeInput({ boundary, scriptRegistry: registry })),
    ).toThrow(InternalExecutionError);
  });

  it('re-throws as InternalExecutionError when the condition script throws InternalExecutionError', () => {
    const scriptErr = new InternalExecutionError('script boom', { code: 'SCRIPT_EXECUTION_FAILED' });
    const registry = makeThrowingRegistry('checkCondition', scriptErr);

    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'guarded',
          match: { operationId: 'updateTest', condition: 'ts:checkCondition' },
          emit: 'Updated',
        },
      ],
      eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
    });

    expect(() =>
      runPatternMatch(makeInput({ boundary, scriptRegistry: registry })),
    ).toThrow(InternalExecutionError);
  });

  it('does NOT return a silent no-match (never reaches UnhandledOperationError)', () => {
    const scriptErr = new TypeError('runtime error');
    const registry = makeThrowingRegistry('checkCondition', scriptErr);

    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'guarded',
          match: { operationId: 'updateTest', condition: 'ts:checkCondition' },
          emit: 'Updated',
        },
      ],
      eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
    });

    let thrown: unknown;
    try {
      runPatternMatch(makeInput({ boundary, scriptRegistry: registry }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InternalExecutionError);
    expect(thrown).not.toBeInstanceOf(UnhandledOperationError);
  });
});

// ── AC2: requires[] @Script throws → InternalExecutionError (500), not 422 ────

describe('AC2: throwing @Script in requires[] condition surfaces as InternalExecutionError', () => {
  it('re-throws as InternalExecutionError when a requires condition script throws TypeError', () => {
    const scriptErr = new TypeError('cannot compute balance');
    const registry = makeThrowingRegistry('checkBalance', scriptErr);

    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'transfer',
          match: {
            operationId: 'updateTest',
            condition: 'true',
            requires: [
              {
                name: 'balance-check',
                condition: 'ts:checkBalance',
                errorCode: 'INSUFFICIENT',
                errorMessage: 'Balance too low',
              },
            ],
          },
          emit: 'Transferred',
        },
      ],
      eventCatalog: [{ type: 'Transferred', payloadTemplate: {} }],
    });

    expect(() =>
      runPatternMatch(makeInput({ boundary, scriptRegistry: registry })),
    ).toThrow(InternalExecutionError);
  });

  it('does NOT produce a 422 UnhandledOperationError when a requires script throws', () => {
    const scriptErr = new Error('runtime failure');
    const registry = makeThrowingRegistry('checkBalance', scriptErr);

    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'transfer',
          match: {
            operationId: 'updateTest',
            condition: 'true',
            requires: [
              {
                name: 'balance-check',
                condition: 'ts:checkBalance',
                errorCode: 'INSUFFICIENT',
                errorMessage: 'Balance too low',
              },
            ],
          },
          emit: 'Transferred',
        },
      ],
      eventCatalog: [{ type: 'Transferred', payloadTemplate: {} }],
    });

    let thrown: unknown;
    try {
      runPatternMatch(makeInput({ boundary, scriptRegistry: registry }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InternalExecutionError);
    expect(thrown).not.toBeInstanceOf(UnhandledOperationError);
  });

  it('re-throws as InternalExecutionError when a requires script throws InternalExecutionError', () => {
    const scriptErr = new InternalExecutionError('sandbox timeout', { code: 'SCRIPT_TIMEOUT' });
    const registry = makeThrowingRegistry('checkBalance', scriptErr);

    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'transfer',
          match: {
            operationId: 'updateTest',
            condition: 'true',
            requires: [
              {
                name: 'balance-check',
                condition: 'ts:checkBalance',
                errorCode: 'INSUFFICIENT',
                errorMessage: 'Balance too low',
              },
            ],
          },
          emit: 'Transferred',
        },
      ],
      eventCatalog: [{ type: 'Transferred', payloadTemplate: {} }],
    });

    expect(() =>
      runPatternMatch(makeInput({ boundary, scriptRegistry: registry })),
    ).toThrow(InternalExecutionError);
  });
});

// ── AC3: emit_when.when @Script throws → InternalExecutionError (500) ──────────

describe('AC3: throwing @Script in emit_when.when surfaces as InternalExecutionError', () => {
  it('re-throws as InternalExecutionError when the emit_when condition script throws TypeError', () => {
    const scriptErr = new TypeError('cannot access state property');
    const registry = makeThrowingRegistry('checkEmit', scriptErr);

    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'settle',
          match: { operationId: 'updateTest', condition: 'true' },
          emitWhen: [
            { when: 'ts:checkEmit', emit: 'Settled' },
          ],
        },
      ],
      eventCatalog: [{ type: 'Settled', payloadTemplate: {} }],
    });

    expect(() =>
      runPatternMatch(makeInput({ boundary, scriptRegistry: registry })),
    ).toThrow(InternalExecutionError);
  });

  it('does NOT silently skip the emit_when entry when the condition script throws', () => {
    const scriptErr = new Error('script runtime error');
    const registry = makeThrowingRegistry('checkEmit', scriptErr);

    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'settle',
          match: { operationId: 'updateTest', condition: 'true' },
          emitWhen: [
            { when: 'ts:checkEmit', emit: 'Settled' },
          ],
        },
      ],
      eventCatalog: [{ type: 'Settled', payloadTemplate: {} }],
    });

    let thrown: unknown;
    try {
      runPatternMatch(makeInput({ boundary, scriptRegistry: registry }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InternalExecutionError);
    expect(thrown).not.toBeInstanceOf(UnhandledOperationError);
  });

  it('re-throws as InternalExecutionError when emit_when script throws InternalExecutionError', () => {
    const scriptErr = new InternalExecutionError('script in reducer phase', { code: 'SCRIPT_IN_REDUCER_PHASE' });
    const registry = makeThrowingRegistry('checkEmit', scriptErr);

    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'settle',
          match: { operationId: 'updateTest', condition: 'true' },
          emitWhen: [
            { when: 'ts:checkEmit', emit: 'Settled' },
          ],
        },
      ],
      eventCatalog: [{ type: 'Settled', payloadTemplate: {} }],
    });

    expect(() =>
      runPatternMatch(makeInput({ boundary, scriptRegistry: registry })),
    ).toThrow(InternalExecutionError);
  });
});

// ── AC4: genuine CEL no-match / type-mismatch remains unchanged ────────────────

describe('AC4: genuine CEL false / type-mismatch is still treated as no-match (unchanged)', () => {
  it('CEL match.condition returning false produces UnhandledOperationError (not 500)', () => {
    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'cel-false',
          match: { operationId: 'updateTest', condition: 'false' },
          emit: 'Updated',
        },
      ],
      eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
    });

    expect(() =>
      runPatternMatch(makeInput({ boundary, cel: fakeCelFalse as any })),
    ).toThrow(UnhandledOperationError);
  });

  it('CEL match.condition that throws (type-mismatch) is treated as no-match → UnhandledOperationError', () => {
    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'cel-throws',
          match: { operationId: 'updateTest', condition: 'state.nonexistent.field' },
          emit: 'Updated',
        },
      ],
      eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
    });

    expect(() =>
      runPatternMatch(makeInput({ boundary, cel: fakeCelThrows as any })),
    ).toThrow(UnhandledOperationError);
  });

  it('CEL requires condition that throws is treated as failed requirement → UnhandledOperationError', () => {
    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'cel-req-throws',
          match: {
            operationId: 'updateTest',
            condition: 'true',
            requires: [
              {
                name: 'check',
                condition: 'state.bad.path',
                errorCode: 'FAIL',
                errorMessage: 'CEL error',
              },
            ],
          },
          emit: 'Updated',
        },
      ],
      eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
    });

    expect(() =>
      runPatternMatch(makeInput({ boundary, cel: fakeCelThrows as any })),
    ).toThrow(UnhandledOperationError);
  });

  it('CEL emit_when.when that throws is treated as skip (no error, no event emitted)', () => {
    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'cel-emit-when-throws',
          match: { operationId: 'updateTest', condition: 'true' },
          emitWhen: [
            { when: 'state.bad.path', emit: 'Settled' },
          ],
        },
      ],
      eventCatalog: [{ type: 'Settled', payloadTemplate: {} }],
    });

    // CEL throws → skip entry → zero events emitted, no error
    const outcome = runPatternMatch(makeInput({
      boundary,
      cel: {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
        evaluate: (expr: string) => {
          if (expr === 'true') return true;
          throw new Error('CEL type error');
        },
      } as any,
    }));
    expect(outcome.events).toHaveLength(0);
  });
});

// ── AC5: dispatch_commands condition @Script throws → InternalExecutionError ──────

describe('AC5: throwing @Script in dispatch_commands condition surfaces as InternalExecutionError', () => {
  it('re-throws as InternalExecutionError when a ts: dispatch condition script throws (not silently skipped)', () => {
    const scriptErr = new TypeError('dispatch condition runtime failure');
    const registry = makeThrowingRegistry('checkDispatch', scriptErr);

    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'cascade',
          match: { operationId: 'updateTest', condition: 'true' },
          emit: 'Updated',
          dispatchCommands: [
            {
              boundary: 'TestBoundary',
              intent: 'query',
              operationId: 'getTest',
              targetId: '"agg-1"',
              condition: 'ts:checkDispatch',
            },
          ],
        },
      ],
      eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
    });

    expect(() =>
      runPatternMatch(makeInput({ boundary, scriptRegistry: registry })),
    ).toThrow(InternalExecutionError);
  });

  it('does NOT silently skip the secondary command when the dispatch condition script throws', () => {
    const scriptErr = new Error('script boom in dispatch');
    const registry = makeThrowingRegistry('checkDispatch', scriptErr);

    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'cascade',
          match: { operationId: 'updateTest', condition: 'true' },
          emit: 'Updated',
          dispatchCommands: [
            {
              boundary: 'TestBoundary',
              intent: 'query',
              operationId: 'getTest',
              targetId: '"agg-1"',
              condition: 'ts:checkDispatch',
            },
          ],
        },
      ],
      eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
    });

    let thrown: unknown;
    try {
      runPatternMatch(makeInput({ boundary, scriptRegistry: registry }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InternalExecutionError);
    expect(thrown).not.toBeInstanceOf(UnhandledOperationError);
  });

  it('CEL dispatch condition legitimately evaluating false still skips the secondary command', () => {
    // No script registry — plain CEL condition
    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'cascade',
          match: { operationId: 'updateTest', condition: 'true' },
          emit: 'Updated',
          dispatchCommands: [
            {
              boundary: 'TestBoundary',
              intent: 'query',
              operationId: 'getTest',
              targetId: '"agg-1"',
              condition: 'false',
            },
          ],
        },
      ],
      eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
    });

    // fakeCelFalse returns false for all CEL — condition false → skip secondary
    const outcome = runPatternMatch(makeInput({
      boundary,
      cel: {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
        evaluate: (expr: string) => {
          // match.condition 'true' must pass; dispatch condition 'false' must not dispatch
          if (expr === 'true') return true;
          return false;
        },
      } as any,
    }));
    // Primary emit still produces one event; no secondary commands
    expect(outcome.events).toHaveLength(1);
    expect(outcome.secondaryCommands).toHaveLength(0);
  });

  it('ts: dispatch condition returning true still dispatches the secondary command', () => {
    const handle = {
      name: 'alwaysTrue',
      boundary: 'TestBoundary',
      source: 'class:AlwaysTrue',
      fn: () => true,
    };
    const trueRegistry = {
      get: (_b: string, name: string) => name === 'alwaysTrue' ? handle : undefined,
      has: (_b: string, name: string) => name === 'alwaysTrue',
      size: () => 1,
    };

    const boundary = makeBoundary({
      behaviors: [
        {
          name: 'cascade',
          match: { operationId: 'updateTest', condition: 'true' },
          emit: 'Updated',
          dispatchCommands: [
            {
              boundary: 'TestBoundary',
              intent: 'query',
              operationId: 'getTest',
              targetId: '"agg-1"',
              condition: 'ts:alwaysTrue',
            },
          ],
        },
      ],
      eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
    });

    // CEL stub returns 'agg-1' for targetId and true for match.condition
    const outcome = runPatternMatch(makeInput({
      boundary,
      scriptRegistry: trueRegistry as any,
      cel: {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
        evaluate: (expr: string) => {
          if (expr === '"agg-1"') return 'agg-1';
          return true;
        },
      } as any,
    }));
    expect(outcome.secondaryCommands).toHaveLength(1);
    expect(outcome.secondaryCommands[0].operationId).toBe('getTest');
  });
});
