/**
 * Exhaustive permutation tests for engine/patternMatcher.
 * Targets: src/engine/patternMatcher.ts (branches ~87.8% → ≥95%)
 */
import { runPatternMatch } from '../../../src/engine/patternMatcher';
import type { PatternMatchInput } from '../../../src/engine/patternMatcher';
import {
  EntityAbsenceError,
  EntityConflictError,
  UnhandledOperationError,
  InternalExecutionError,
} from '../../../src/errors';
import { makeBoundary, makeCommand as makeCommandBase, makeOpenApi } from '../_helpers';
import type { ShadowGraph } from '../../../src/stategraph/shadow';
import type { CelEvaluator } from '../../../src/cel/evaluator';
import type { Command } from '../../../src/types';

// operationId for the behavior that should handle a given intent under the default
// Local makeCommand that derives a contract-consistent (method, path) from intent,
// so the pattern matcher resolves the matching operationId. Explicit overrides win.
function makeCommand(overrides: Partial<Command> = {}): Command {
  const intent = overrides.intent ?? 'mutation';
  const targetId = overrides.targetId !== undefined
    ? overrides.targetId
    : (intent === 'creation' ? null : 'agg-1');
  const idForPath = typeof targetId === 'string' ? targetId : 'agg-1';
  const method = intent === 'creation' ? 'POST' : intent === 'query' ? 'GET' : 'PATCH';
  const path = intent === 'creation' ? '/test' : `/test/${idForPath}`;
  return makeCommandBase({ httpMethod: method, path, ...overrides, targetId });
}

// ── Shadow helpers ────────────────────────────────────────────────────────────

function makeShadow(
  stateMap: Map<string, Record<string, unknown>> = new Map(),
): ShadowGraph {
  return {
    get: (id: string) => stateMap.get(id) ?? null,
    stage: jest.fn(),
    has: (id: string) => stateMap.has(id),
    shadowed: () => stateMap as any,
    commitInto: jest.fn(),
  } as unknown as ShadowGraph;
}

function shadowWithState(id: string, state: Record<string, unknown>): ShadowGraph {
  return makeShadow(new Map([[id, state]]));
}

function emptyShadow(): ShadowGraph {
  return makeShadow();
}

// ── CEL helpers ───────────────────────────────────────────────────────────────

function makeAlwaysTrueCel(): CelEvaluator {
  return {
    compile: (e: string) => ({ source: e, _ast: {} as any }),
    evaluateDslValue: jest.fn() as any,
    getClockOffset: jest.fn(() => 0),
    setClockOffset: jest.fn(),
    withRequestContext(this: CelEvaluator) { return this; },
    evaluate: jest.fn(() => true),
  };
}

function makeAlwaysFalseCel(): CelEvaluator {
  return {
    compile: (e: string) => ({ source: e, _ast: {} as any }),
    evaluateDslValue: jest.fn() as any,
    getClockOffset: jest.fn(() => 0),
    setClockOffset: jest.fn(),
    withRequestContext(this: CelEvaluator) { return this; },
    evaluate: jest.fn(() => false),
  };
}

function makeThrowingCel(): CelEvaluator {
  return {
    compile: (e: string) => ({ source: e, _ast: {} as any }),
    evaluateDslValue: jest.fn() as any,
    getClockOffset: jest.fn(() => 0),
    setClockOffset: jest.fn(),
    withRequestContext(this: CelEvaluator) { return this; },
    evaluate: jest.fn(() => { throw new Error('CEL evaluation error'); }),
  };
}

function makeValueCel(value: unknown): CelEvaluator {
  return {
    compile: (e: string) => ({ source: e, _ast: {} as any }),
    evaluateDslValue: jest.fn() as any,
    getClockOffset: jest.fn(() => 0),
    setClockOffset: jest.fn(),
    withRequestContext(this: CelEvaluator) { return this; },
    evaluate: jest.fn(() => value),
  };
}

// ── Input factory ─────────────────────────────────────────────────────────────

let eventCounter = 0;
function makeInput(overrides: Partial<PatternMatchInput> = {}): PatternMatchInput {
  return {
    command: makeCommand({ intent: 'creation', targetId: null }),
    boundary: makeBoundary({
      behaviors: [{
        name: 'create',
        match: { operationId: 'createTest', condition: 'true' },
        emit: 'Created',
      }],
      eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
    }),
    shadow: emptyShadow(),
    cel: makeAlwaysTrueCel(),
    nextEventId: () => `evt-${++eventCounter}`,
    nextSequenceVersion: () => 1,
    projectToShadow: jest.fn(),
    now: () => '2024-01-01T00:00:00.000Z',
    openapi: makeOpenApi(),
    ...overrides,
  };
}

describe('engine/patternMatcher — permutations', () => {
  beforeEach(() => { eventCounter = 0; });

  // ── Intent × state present combinations ─────────────────────────────────
  describe('intent × state combinations', () => {
    it('creation with no targetId and no state — succeeds', () => {
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'creation', targetId: null }),
        shadow: emptyShadow(),
      }));
      expect(result.events).toHaveLength(1);
      expect(result.events[0]?.type).toBe('Created');
    });

    it('creation with targetId and no existing state — succeeds', () => {
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'creation', targetId: 'new-id' }),
        shadow: emptyShadow(),
      }));
      expect(result.events[0]?.aggregateId).toBe('new-id');
    });

    it('creation with targetId and existing state — throws EntityConflictError', () => {
      expect(() =>
        runPatternMatch(makeInput({
          command: makeCommand({ intent: 'creation', targetId: 'exists' }),
          shadow: shadowWithState('exists', { x: 1 }),
        })),
      ).toThrow(EntityConflictError);
    });

    it('EntityConflictError has correct code', () => {
      try {
        runPatternMatch(makeInput({
          command: makeCommand({ intent: 'creation', targetId: 'exists' }),
          shadow: shadowWithState('exists', { x: 1 }),
        }));
      } catch (e) {
        expect((e as EntityConflictError).code).toBe('ENTITY_CONFLICT');
        expect((e as EntityConflictError).details).toMatchObject({ targetId: 'exists' });
      }
    });

    it('mutation with targetId and existing state — succeeds', () => {
      const boundary = makeBoundary({
        behaviors: [{
          name: 'update',
          match: { operationId: 'updateTest', condition: 'true' },
          emit: 'Updated',
        }],
        eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
      });
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'mutation', targetId: 'agg-1' }),
        boundary,
        shadow: shadowWithState('agg-1', { status: 'active' }),
      }));
      expect(result.events[0]?.type).toBe('Updated');
    });

    it('mutation with targetId and no state — throws EntityAbsenceError', () => {
      const boundary = makeBoundary({
        behaviors: [{
          name: 'update',
          match: { operationId: 'updateTest', condition: 'true' },
          emit: 'Updated',
        }],
        eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
      });
      expect(() =>
        runPatternMatch(makeInput({
          command: makeCommand({ intent: 'mutation', targetId: 'missing' }),
          boundary,
          shadow: emptyShadow(),
        })),
      ).toThrow(EntityAbsenceError);
    });

    it('EntityAbsenceError includes targetId and boundary in details', () => {
      try {
        runPatternMatch(makeInput({
          command: makeCommand({ intent: 'mutation', targetId: 'miss' }),
          boundary: makeBoundary({
            behaviors: [{ name: 'b', match: { operationId: 'updateTest', condition: 'true' }, emit: 'E' }],
            eventCatalog: [{ type: 'E', payloadTemplate: {} }],
          }),
          shadow: emptyShadow(),
        }));
      } catch (e) {
        expect((e as EntityAbsenceError).details).toMatchObject({ targetId: 'miss', boundary: 'TestBoundary' });
      }
    });

    it('query with no targetId and empty shadow — succeeds with empty events', () => {
      const boundary = makeBoundary({
        behaviors: [],
        fallbackOverride: true,
      });
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'query', targetId: null }),
        boundary,
        shadow: emptyShadow(),
      }));
      expect(result.events).toHaveLength(0);
      expect(result.state).toBeNull();
    });

    it('query with targetId and existing state via fallback returns state', () => {
      const boundary = makeBoundary({
        behaviors: [],
        fallbackOverride: true,
      });
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'query', targetId: 'q-1' }),
        boundary,
        shadow: shadowWithState('q-1', { name: 'Test' }),
      }));
      expect(result.state).toMatchObject({ name: 'Test' });
      expect(result.events).toHaveLength(0);
    });

    it('query with targetId and no state + fallback throws EntityAbsenceError', () => {
      const boundary = makeBoundary({ behaviors: [], fallbackOverride: true });
      expect(() =>
        runPatternMatch(makeInput({
          command: makeCommand({ intent: 'query', targetId: 'absent' }),
          boundary,
          shadow: emptyShadow(),
        })),
      ).toThrow(EntityAbsenceError);
    });
  });

  // ── Zero/one/two behaviors in priority order ──────────────────────────────
  describe('behavior count and priority', () => {
    it('0 behaviors + no fallback → UnhandledOperationError', () => {
      expect(() =>
        runPatternMatch(makeInput({
          boundary: makeBoundary({ behaviors: [], fallbackOverride: false }),
        })),
      ).toThrow(UnhandledOperationError);
    });

    it('0 behaviors + fallback → GenericUpdateEvent', () => {
      const result = runPatternMatch(makeInput({
        boundary: makeBoundary({ behaviors: [], fallbackOverride: true }),
        command: makeCommand({ intent: 'mutation', targetId: 'a' }),
        shadow: shadowWithState('a', {}),
      }));
      expect(result.events[0]?.type).toBe('System.GenericUpdateEvent');
    });

    it('1 behavior matches → returns that event', () => {
      const result = runPatternMatch(makeInput());
      expect(result.events[0]?.type).toBe('Created');
    });

    it('2 behaviors: first matches → only first behavior fires', () => {
      const callOrder: string[] = [];
      const cel: CelEvaluator = {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
    evaluateDslValue: jest.fn() as any,
    getClockOffset: jest.fn(() => 0),
    setClockOffset: jest.fn(),
    withRequestContext(this: CelEvaluator) { return this; },
        evaluate: jest.fn((e: any) => {
          const src = typeof e === 'string' ? e : e.source;
          callOrder.push(src);
          return true;
        }),
      };
      const boundary = makeBoundary({
        behaviors: [
          { name: 'first', match: { operationId: 'createTest', condition: 'cond1' }, emit: 'Ev1' },
          { name: 'second', match: { operationId: 'createTest', condition: 'cond2' }, emit: 'Ev2' },
        ],
        eventCatalog: [
          { type: 'Ev1', payloadTemplate: {} },
          { type: 'Ev2', payloadTemplate: {} },
        ],
      });
      const result = runPatternMatch(makeInput({ boundary, cel }));
      expect(result.events[0]?.type).toBe('Ev1');
    });

    it('2 behaviors: first false, second true → second fires', () => {
      let callCount = 0;
      const cel: CelEvaluator = {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
    evaluateDslValue: jest.fn() as any,
    getClockOffset: jest.fn(() => 0),
    setClockOffset: jest.fn(),
    withRequestContext(this: CelEvaluator) { return this; },
        evaluate: jest.fn(() => { return ++callCount > 1; }),
      };
      const boundary = makeBoundary({
        behaviors: [
          { name: 'first', match: { operationId: 'createTest', condition: 'cond1' }, emit: 'Ev1' },
          { name: 'second', match: { operationId: 'createTest', condition: 'cond2' }, emit: 'Ev2' },
        ],
        eventCatalog: [
          { type: 'Ev1', payloadTemplate: {} },
          { type: 'Ev2', payloadTemplate: {} },
        ],
      });
      const result = runPatternMatch(makeInput({ boundary, cel }));
      expect(result.events[0]?.type).toBe('Ev2');
    });
  });

  // ── Condition outcomes ────────────────────────────────────────────────────
  describe('condition outcomes', () => {
    it('always-true condition matches', () => {
      const result = runPatternMatch(makeInput({ cel: makeAlwaysTrueCel() }));
      expect(result.events).toHaveLength(1);
    });

    it('always-false condition: no match', () => {
      expect(() =>
        runPatternMatch(makeInput({ cel: makeAlwaysFalseCel() })),
      ).toThrow(UnhandledOperationError);
    });

    it('condition returning non-true (truthy) is treated as false (strict === true check)', () => {
      // Returns a truthy string, not === true
      const cel = makeValueCel('truthy-string');
      expect(() =>
        runPatternMatch(makeInput({ cel })),
      ).toThrow(UnhandledOperationError);
    });

    it('condition error treated as no-match', () => {
      expect(() =>
        runPatternMatch(makeInput({ cel: makeThrowingCel() })),
      ).toThrow(UnhandledOperationError);
    });

    it('condition depends on payload — passes payload through CEL context', () => {
      const cel: CelEvaluator = {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
    evaluateDslValue: jest.fn() as any,
    getClockOffset: jest.fn(() => 0),
    setClockOffset: jest.fn(),
    withRequestContext(this: CelEvaluator) { return this; },
        evaluate: jest.fn((expr, ctx: any) => {
          // Only match when payload.amount > 100
          return (ctx?.payload?.amount ?? 0) > 100;
        }),
      };
      const command = makeCommand({ intent: 'creation', targetId: null, payload: { amount: 150 } });
      const result = runPatternMatch(makeInput({ command, cel }));
      expect(result.events).toHaveLength(1);
    });

    it('condition depends on state — state is present in CEL context', () => {
      const cel: CelEvaluator = {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
    evaluateDslValue: jest.fn() as any,
    getClockOffset: jest.fn(() => 0),
    setClockOffset: jest.fn(),
    withRequestContext(this: CelEvaluator) { return this; },
        evaluate: jest.fn((expr, ctx: any) => {
          return ctx?.state?.status === 'active';
        }),
      };
      const boundary = makeBoundary({
        behaviors: [{
          name: 'update-active',
          match: { operationId: 'updateTest', condition: 'state.status == "active"' },
          emit: 'Updated',
        }],
        eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
      });
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'mutation', targetId: 'agg-1' }),
        boundary,
        shadow: shadowWithState('agg-1', { status: 'active' }),
        cel,
      }));
      expect(result.events[0]?.type).toBe('Updated');
    });
  });

  // ── Emit references ─────────────────────────────────────────────────────────
  describe('emit references', () => {
    it('throws InternalExecutionError when emit references unknown event', () => {
      const boundary = makeBoundary({
        behaviors: [{
          name: 'b',
          match: { operationId: 'createTest', condition: 'true' },
          emit: 'NonExistentEvent',
        }],
        eventCatalog: [{ type: 'SomeOtherEvent', payloadTemplate: {} }],
      });
      expect(() => runPatternMatch(makeInput({ boundary }))).toThrow(InternalExecutionError);
    });

    it('InternalExecutionError message includes emit type', () => {
      const boundary = makeBoundary({
        behaviors: [{
          name: 'b',
          match: { operationId: 'createTest', condition: 'true' },
          emit: 'MissingEvent',
        }],
        eventCatalog: [],
      });
      try {
        runPatternMatch(makeInput({ boundary }));
      } catch (e) {
        expect((e as Error).message).toContain('MissingEvent');
      }
    });
  });

  // ── dispatch_commands ────────────────────────────────────────────────────────
  describe('dispatch_commands (secondary commands)', () => {
    it('no dispatch_commands → empty secondaryCommands', () => {
      const result = runPatternMatch(makeInput());
      expect(result.secondaryCommands).toHaveLength(0);
    });

    it('one dispatch_commands spec → one secondary command', () => {
      const boundary = makeBoundary({
        behaviors: [{
          name: 'create',
          match: { operationId: 'createTest', condition: 'true' },
          emit: 'Created',
          dispatchCommands: [{
            boundary: 'AuditBoundary',
            intent: 'creation',
            operationId: 'op',
            targetId: '"audit-1"',
          }],
        }],
        eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
      });
      const result = runPatternMatch(makeInput({ boundary }));
      expect(result.secondaryCommands).toHaveLength(1);
      expect(result.secondaryCommands[0]?.boundary).toBe('AuditBoundary');
    });

    it('two dispatch_commands specs → two secondary commands', () => {
      const cel: CelEvaluator = {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
        evaluateDslValue: jest.fn() as any,
        getClockOffset: jest.fn(() => 0),
        setClockOffset: jest.fn(),
        withRequestContext(this: CelEvaluator) { return this; },
        evaluate: jest.fn((expr) => {
          const src = typeof expr === 'string' ? expr : (expr as any).source;
          if (src === '"t1"') return 't1';
          if (src === '"t2"') return 't2';
          return true;
        }),
      };
      const boundary = makeBoundary({
        behaviors: [{
          name: 'create',
          match: { operationId: 'createTest', condition: 'true' },
          emit: 'Created',
          dispatchCommands: [
            { boundary: 'B1', intent: 'creation', operationId: 'op', targetId: '"t1"' },
            { boundary: 'B2', intent: 'mutation', operationId: 'op', targetId: '"t2"' },
          ],
        }],
        eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
      });
      const result = runPatternMatch(makeInput({ boundary, cel }));
      expect(result.secondaryCommands).toHaveLength(2);
      expect(result.secondaryCommands[0]?.boundary).toBe('B1');
      expect(result.secondaryCommands[1]?.boundary).toBe('B2');
    });

    it('secondary command targetId resolves from CEL expression', () => {
      const cel: CelEvaluator = {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
    evaluateDslValue: jest.fn() as any,
    getClockOffset: jest.fn(() => 0),
    setClockOffset: jest.fn(),
    withRequestContext(this: CelEvaluator) { return this; },
        evaluate: jest.fn((expr) => {
          const src = typeof expr === 'string' ? expr : (expr as any).source;
          if (src === 'target-id-expr') return 'resolved-target-id';
          return true;
        }),
      };
      const boundary = makeBoundary({
        behaviors: [{
          name: 'create',
          match: { operationId: 'createTest', condition: 'true' },
          emit: 'Created',
          dispatchCommands: [{
            boundary: 'OtherBoundary',
            intent: 'mutation',
            operationId: 'op',
            targetId: 'target-id-expr',
          }],
        }],
        eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
      });
      const result = runPatternMatch(makeInput({ boundary, cel }));
      expect(result.secondaryCommands[0]?.targetId).toBe('resolved-target-id');
    });

    it('secondary command targetId is null when CEL returns non-string', () => {
      const cel: CelEvaluator = {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
    evaluateDslValue: jest.fn() as any,
    getClockOffset: jest.fn(() => 0),
    setClockOffset: jest.fn(),
    withRequestContext(this: CelEvaluator) { return this; },
        evaluate: jest.fn((expr) => {
          const src = typeof expr === 'string' ? expr : (expr as any).source;
          // Condition evaluation must return true to match behavior
          if (src === 'true') return true;
          // targetId expression returns a number, not string
          if (src === 'num-expr') return 42;
          return true;
        }),
      };
      const boundary = makeBoundary({
        behaviors: [{
          name: 'create',
          match: { operationId: 'createTest', condition: 'true' },
          emit: 'Created',
          dispatchCommands: [{ boundary: 'B', intent: 'creation', operationId: 'op', targetId: 'num-expr' }],
        }],
        eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
      });
      const result = runPatternMatch(makeInput({ boundary, cel }));
      expect(result.secondaryCommands[0]?.targetId).toBeNull();
    });

    it('secondary command with payload resolves CEL expressions', () => {
      const cel: CelEvaluator = {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
    evaluateDslValue: jest.fn() as any,
    getClockOffset: jest.fn(() => 0),
    setClockOffset: jest.fn(),
    withRequestContext(this: CelEvaluator) { return this; },
        evaluate: jest.fn((expr) => {
          const src = typeof expr === 'string' ? expr : (expr as any).source;
          if (src === '"resolved-id"') return 'resolved-id';
          if (src === 'event.payload.name') return 'Alice';
          return true;
        }),
      };
      const boundary = makeBoundary({
        behaviors: [{
          name: 'create',
          match: { operationId: 'createTest', condition: 'true' },
          emit: 'Created',
          dispatchCommands: [{
            boundary: 'OtherBoundary',
            intent: 'creation',
            operationId: 'op',
            targetId: '"resolved-id"',
            payload: { name: 'event.payload.name' },
          }],
        }],
        eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
      });
      const result = runPatternMatch(makeInput({ boundary, cel }));
      expect(result.secondaryCommands[0]?.payload?.['name']).toBe('Alice');
    });

    it('secondary command httpMethod is POST for creation intent', () => {
      const boundary = makeBoundary({
        behaviors: [{
          name: 'create',
          match: { operationId: 'createTest', condition: 'true' },
          emit: 'Created',
          dispatchCommands: [{ boundary: 'B', intent: 'creation', operationId: 'op', targetId: '"x"' }],
        }],
        eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
      });
      const result = runPatternMatch(makeInput({ boundary }));
      expect(result.secondaryCommands[0]?.httpMethod).toBe('POST');
    });

    it('secondary command httpMethod is PUT for mutation intent', () => {
      const cel: CelEvaluator = {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
        evaluateDslValue: jest.fn() as any,
        getClockOffset: jest.fn(() => 0),
        setClockOffset: jest.fn(),
        withRequestContext(this: CelEvaluator) { return this; },
        evaluate: jest.fn((expr) => {
          const src = typeof expr === 'string' ? expr : (expr as any).source;
          if (src === '"x"') return 'x';
          return true;
        }),
      };
      const boundary = makeBoundary({
        behaviors: [{
          name: 'create',
          match: { operationId: 'createTest', condition: 'true' },
          emit: 'Created',
          dispatchCommands: [{ boundary: 'B', intent: 'mutation', operationId: 'op', targetId: '"x"' }],
        }],
        eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
      });
      const result = runPatternMatch(makeInput({ boundary, cel }));
      expect(result.secondaryCommands[0]?.httpMethod).toBe('PUT');
    });

    it('secondary command depth is parent depth + 1', () => {
      const boundary = makeBoundary({
        behaviors: [{
          name: 'create',
          match: { operationId: 'createTest', condition: 'true' },
          emit: 'Created',
          dispatchCommands: [{ boundary: 'B', intent: 'creation', operationId: 'op', targetId: '"t"' }],
        }],
        eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
      });
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'creation', targetId: null, depth: 2 }),
        boundary,
      }));
      expect(result.secondaryCommands[0]?.depth).toBe(3);
    });
  });

  // ── fallback_override permutations ────────────────────────────────────────
  describe('fallback_override permutations', () => {
    it('fallback_override:true + creation intent + no match → GenericUpdateEvent with commandId as aggregateId', () => {
      const boundary = makeBoundary({ behaviors: [], fallbackOverride: true });
      const cmd = makeCommand({ intent: 'creation', targetId: null, commandId: 'cmd-fallback' });
      const result = runPatternMatch(makeInput({ command: cmd, boundary }));
      expect(result.events[0]?.type).toBe('System.GenericUpdateEvent');
      expect(result.events[0]?.aggregateId).toBe('cmd-fallback');
    });

    it('fallback_override:true + mutation + targetId → GenericUpdateEvent with targetId as aggregateId', () => {
      const boundary = makeBoundary({ behaviors: [], fallbackOverride: true });
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'mutation', targetId: 'tgt' }),
        boundary,
        shadow: shadowWithState('tgt', {}),
      }));
      expect(result.events[0]?.aggregateId).toBe('tgt');
      expect(result.events[0]?.type).toBe('System.GenericUpdateEvent');
    });

    it('fallback_override:false + no match → UnhandledOperationError', () => {
      const boundary = makeBoundary({ behaviors: [], fallbackOverride: false });
      expect(() =>
        runPatternMatch(makeInput({ boundary })),
      ).toThrow(UnhandledOperationError);
    });

    it('fallback GenericUpdateEvent uses command.payload', () => {
      const boundary = makeBoundary({ behaviors: [], fallbackOverride: true });
      const cmd = makeCommand({ intent: 'creation', targetId: null, payload: { key: 'value' } });
      const result = runPatternMatch(makeInput({ command: cmd, boundary }));
      expect(result.events[0]?.payload).toMatchObject({ key: 'value' });
    });

    it('fallback uses now() for timestamp', () => {
      const boundary = makeBoundary({ behaviors: [], fallbackOverride: true });
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'creation', targetId: null }),
        boundary,
        now: () => 'FIXED-TIME',
      }));
      expect(result.events[0]?.timestamp).toBe('FIXED-TIME');
    });

    it('fallback calls projectToShadow', () => {
      const projectToShadow = jest.fn();
      const boundary = makeBoundary({ behaviors: [], fallbackOverride: true });
      runPatternMatch(makeInput({
        command: makeCommand({ intent: 'creation', targetId: null }),
        boundary,
        projectToShadow,
      }));
      expect(projectToShadow).toHaveBeenCalledTimes(1);
    });
  });

  // ── identity.creation.generate ──────────────────────────────────────────────
  describe('identity.creation.generate', () => {
    it('uses identity.creation.generate to produce aggregateId', () => {
      const cel: CelEvaluator = {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
    evaluateDslValue: jest.fn() as any,
    getClockOffset: jest.fn(() => 0),
    setClockOffset: jest.fn(),
    withRequestContext(this: CelEvaluator) { return this; },
        evaluate: jest.fn((expr) => {
          const src = typeof expr === 'string' ? expr : (expr as any).source;
          if (src === '$uuidv7()') return 'generated-uuid';
          return true;
        }),
      };
      const boundary = makeBoundary({
        identity: { creation: { generate: '$uuidv7()' } },
        behaviors: [{
          name: 'create',
          match: { operationId: 'createTest', condition: 'true' },
          emit: 'Created',
        }],
        eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
      });
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'creation', targetId: null }),
        boundary,
        cel,
      }));
      expect(result.events[0]?.aggregateId).toBe('generated-uuid');
    });

    it('throws InternalExecutionError when generate expression returns empty string', () => {
      const cel: CelEvaluator = {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
    evaluateDslValue: jest.fn() as any,
    getClockOffset: jest.fn(() => 0),
    setClockOffset: jest.fn(),
    withRequestContext(this: CelEvaluator) { return this; },
        evaluate: jest.fn((expr) => {
          const src = typeof expr === 'string' ? expr : (expr as any).source;
          if (src === 'gen-expr') return '';
          return true;
        }),
      };
      const boundary = makeBoundary({
        identity: { creation: { generate: 'gen-expr' } },
        behaviors: [{
          name: 'create',
          match: { operationId: 'createTest', condition: 'true' },
          emit: 'Created',
        }],
        eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
      });
      expect(() =>
        runPatternMatch(makeInput({
          command: makeCommand({ intent: 'creation', targetId: null }),
          boundary,
          cel,
        })),
      ).toThrow(InternalExecutionError);
    });

    it('throws InternalExecutionError when generate expression returns non-string', () => {
      const cel: CelEvaluator = {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
    evaluateDslValue: jest.fn() as any,
    getClockOffset: jest.fn(() => 0),
    setClockOffset: jest.fn(),
    withRequestContext(this: CelEvaluator) { return this; },
        evaluate: jest.fn((expr) => {
          const src = typeof expr === 'string' ? expr : (expr as any).source;
          if (src === 'gen-expr') return 42; // non-string
          return true;
        }),
      };
      const boundary = makeBoundary({
        identity: { creation: { generate: 'gen-expr' } },
        behaviors: [{
          name: 'create',
          match: { operationId: 'createTest', condition: 'true' },
          emit: 'Created',
        }],
        eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
      });
      expect(() =>
        runPatternMatch(makeInput({
          command: makeCommand({ intent: 'creation', targetId: null }),
          boundary,
          cel,
        })),
      ).toThrow(InternalExecutionError);
    });

    it('without identity config uses nextEventId as aggregateId for collection creation', () => {
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'creation', targetId: null }),
        nextEventId: () => 'next-evt-id',
      }));
      expect(result.events[0]?.aggregateId).toBe('next-evt-id');
    });
  });

  // ── collection-level non-creation ─────────────────────────────────────────
  describe('collection-level non-creation (no targetId, not creation intent)', () => {
    it('query with no targetId uses commandId as aggregateId (when behavior matches)', () => {
      const boundary = makeBoundary({
        behaviors: [{
          name: 'q',
          match: { operationId: 'getTest', condition: 'true' },
          emit: 'Queried',
        }],
        eventCatalog: [{ type: 'Queried', payloadTemplate: {} }],
      });
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'query', targetId: null, commandId: 'query-cmd' }),
        boundary,
      }));
      expect(result.events[0]?.aggregateId).toBe('query-cmd');
    });
  });

  // ── payload template evaluation ────────────────────────────────────────────
  describe('payload template evaluation', () => {
    it('event payload includes fields from payloadTemplate', () => {
      const cel: CelEvaluator = {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
    evaluateDslValue: jest.fn() as any,
    getClockOffset: jest.fn(() => 0),
    setClockOffset: jest.fn(),
    withRequestContext(this: CelEvaluator) { return this; },
        evaluate: jest.fn((expr) => {
          const src = typeof expr === 'string' ? expr : (expr as any).source;
          if (src === 'command.payload.name') return 'Alice';
          return true;
        }),
      };
      const boundary = makeBoundary({
        behaviors: [{
          name: 'create',
          match: { operationId: 'createTest', condition: 'true' },
          emit: 'Created',
        }],
        eventCatalog: [{
          type: 'Created',
          payloadTemplate: { name: 'command.payload.name' },
        }],
      });
      const result = runPatternMatch(makeInput({ boundary, cel }));
      expect(result.events[0]?.payload?.['name']).toBe('Alice');
    });
  });

  // ── Intent mismatch ────────────────────────────────────────────────────────
  describe('intent mismatch skips behavior', () => {
    it('command.intent=creation skips mutation behavior', () => {
      const boundary = makeBoundary({
        behaviors: [
          { name: 'mutation-only', match: { operationId: 'updateTest', condition: 'true' }, emit: 'Updated' },
          { name: 'creation-match', match: { operationId: 'createTest', condition: 'true' }, emit: 'Created' },
        ],
        eventCatalog: [
          { type: 'Updated', payloadTemplate: {} },
          { type: 'Created', payloadTemplate: {} },
        ],
      });
      const result = runPatternMatch(makeInput({ boundary }));
      expect(result.events[0]?.type).toBe('Created');
    });

    it('skips all behaviors with wrong intent → UnhandledOperationError', () => {
      const boundary = makeBoundary({
        behaviors: [
          { name: 'mutation-only', match: { operationId: 'updateTest', condition: 'true' }, emit: 'Updated' },
        ],
        eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
      });
      expect(() =>
        runPatternMatch(makeInput({ boundary })),
      ).toThrow(UnhandledOperationError);
    });
  });

  // ── UnhandledOperationError code and structure ─────────────────────────────
  describe('UnhandledOperationError structure', () => {
    it('code is UNHANDLED_OPERATION', () => {
      try {
        runPatternMatch(makeInput({ boundary: makeBoundary({ behaviors: [] }) }));
      } catch (e) {
        expect((e as UnhandledOperationError).code).toBe('UNHANDLED_OPERATION');
      }
    });

    it('details includes intent and boundary', () => {
      try {
        runPatternMatch(makeInput({ boundary: makeBoundary({ behaviors: [] }) }));
      } catch (e) {
        expect((e as UnhandledOperationError).details).toMatchObject({
          intent: 'creation',
          boundary: 'TestBoundary',
        });
      }
    });
  });

  // ── projectToShadow + sequenceVersion ─────────────────────────────────────
  describe('projectToShadow and sequenceVersion', () => {
    it('projectToShadow called with the domain event', () => {
      const projectToShadow = jest.fn();
      runPatternMatch(makeInput({ projectToShadow }));
      expect(projectToShadow).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'Created' }),
      );
    });

    it('event sequenceVersion comes from nextSequenceVersion callback', () => {
      const result = runPatternMatch(makeInput({ nextSequenceVersion: () => 7 }));
      expect(result.events[0]?.sequenceVersion).toBe(7);
    });

    it('event causedBy is set to commandId', () => {
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'creation', targetId: null, commandId: 'cause-cmd' }),
      }));
      expect(result.events[0]?.causedBy).toBe('cause-cmd');
    });
  });
});
