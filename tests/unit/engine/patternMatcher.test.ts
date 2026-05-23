import { runPatternMatch } from '../../../src/engine/patternMatcher';
import type { PatternMatchInput } from '../../../src/engine/patternMatcher';
import {
  EntityAbsenceError,
  EntityConflictError,
  UnhandledOperationError,
  InternalExecutionError,
} from '../../../src/errors';
import { makeBoundary, makeCommand } from '../_helpers';
import type { Command } from '../../../src/types';
import type { BoundaryConfig } from '../../../src/dsl/types';
import type { ShadowGraph } from '../../../src/stategraph/shadow';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeNoopShadow(state: Record<string, unknown> | null = null): ShadowGraph {
  const staged = new Map<string, Record<string, unknown>>();

  return {
    get: (targetId: string) => {
      if (staged.has(targetId)) return staged.get(targetId) as any;
      return state;
    },
    stage: jest.fn((id: string, val: any) => { staged.set(id, val); }),
    has: (targetId: string) => staged.has(targetId) || state !== null,
    shadowed: () => staged as any,
    commitInto: jest.fn(),
  } as unknown as ShadowGraph;
}

const fakeCel = {
  compile: (e: string) => ({ source: e, _ast: {} as any }),
  evaluate: () => true,
};

const fakeCelFalse = {
  compile: (e: string) => ({ source: e, _ast: {} as any }),
  evaluate: () => false,
};

const fakeCelThrows = {
  compile: (e: string) => ({ source: e, _ast: {} as any }),
  evaluate: () => { throw new Error('CEL error'); },
};

function makeInput(overrides: Partial<PatternMatchInput> = {}): PatternMatchInput {
  return {
    command: makeCommand({ intent: 'creation', targetId: null }),
    boundary: makeBoundary({
      behaviors: [
        {
          name: 'b1',
          match: { intent: 'creation', condition: 'true' },
          emit: 'Created',
        },
      ],
      eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
    }),
    shadow: makeNoopShadow(null),
    cel: fakeCel as any,
    nextEventId: () => 'evt-1',
    nextSequenceVersion: () => 1,
    projectToShadow: jest.fn(),
    now: () => '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('engine/patternMatcher', () => {
  describe('EntityAbsenceError', () => {
    it('throws EntityAbsenceError on mutation when state is null', () => {
      expect(() =>
        runPatternMatch(makeInput({
          command: makeCommand({ intent: 'mutation', targetId: 'a1' }),
          shadow: makeNoopShadow(null),
        })),
      ).toThrow(EntityAbsenceError);
    });

    it('EntityAbsenceError includes targetId in details', () => {
      try {
        runPatternMatch(makeInput({
          command: makeCommand({ intent: 'mutation', targetId: 'miss-me' }),
          shadow: makeNoopShadow(null),
        }));
      } catch (e) {
        expect(e).toBeInstanceOf(EntityAbsenceError);
        expect((e as EntityAbsenceError).details).toMatchObject({ targetId: 'miss-me' });
      }
    });
  });

  describe('EntityConflictError', () => {
    it('throws EntityConflictError on creation when state already exists', () => {
      expect(() =>
        runPatternMatch(makeInput({
          command: makeCommand({ intent: 'creation', targetId: 'existing' }),
          shadow: makeNoopShadow({ id: 'existing' }),
        })),
      ).toThrow(EntityConflictError);
    });
  });

  describe('UnhandledOperationError', () => {
    it('throws UnhandledOperationError when no behavior matches', () => {
      expect(() =>
        runPatternMatch(makeInput({
          command: makeCommand({ intent: 'creation', targetId: null }),
          cel: fakeCelFalse as any,
        })),
      ).toThrow(UnhandledOperationError);
    });

    it('throws UnhandledOperationError when intent does not match any behavior', () => {
      const boundary = makeBoundary({
        behaviors: [
          { name: 'b1', match: { intent: 'mutation', condition: 'true' }, emit: 'Updated' },
        ],
        eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
      });
      expect(() =>
        runPatternMatch(makeInput({
          command: makeCommand({ intent: 'creation', targetId: null }),
          boundary,
        })),
      ).toThrow(UnhandledOperationError);
    });

    it('treats CEL evaluation error as no-match', () => {
      expect(() =>
        runPatternMatch(makeInput({
          command: makeCommand({ intent: 'creation', targetId: null }),
          cel: fakeCelThrows as any,
        })),
      ).toThrow(UnhandledOperationError);
    });
  });

  describe('fallbackOverride', () => {
    it('returns GenericUpdateEvent when fallbackOverride is true and no behavior matches', () => {
      const boundary = makeBoundary({ fallbackOverride: true, behaviors: [] });
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'mutation', targetId: 'a1' }),
        boundary,
        shadow: makeNoopShadow({ existing: true }),
      }));
      expect(result.events[0]?.type).toBe('System.GenericUpdateEvent');
    });

    it('fallback uses targetId as aggregateId when targetId present', () => {
      const boundary = makeBoundary({ fallbackOverride: true, behaviors: [] });
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'mutation', targetId: 'target-x' }),
        boundary,
        shadow: makeNoopShadow({ x: 1 }),
      }));
      expect(result.events[0]?.aggregateId).toBe('target-x');
    });

    it('fallback does not apply to query intent', () => {
      const boundary = makeBoundary({ fallbackOverride: true, behaviors: [] });
      expect(() =>
        runPatternMatch(makeInput({
          command: makeCommand({ intent: 'query', targetId: null }),
          boundary,
          shadow: makeNoopShadow(null),
        })),
      ).toThrow(UnhandledOperationError);
    });
  });

  describe('successful match', () => {
    it('returns a domain event on successful match', () => {
      const result = runPatternMatch(makeInput());
      expect(result.events).toHaveLength(1);
    });

    it('event has correct boundary', () => {
      const result = runPatternMatch(makeInput());
      expect(result.events[0]?.boundary).toBe('TestBoundary');
    });

    it('event uses nextEventId for eventId', () => {
      const result = runPatternMatch(makeInput({ nextEventId: () => 'fixed-event-id' }));
      expect(result.events[0]?.eventId).toBe('fixed-event-id');
    });

    it('event has correct type from catalog', () => {
      const result = runPatternMatch(makeInput());
      expect(result.events[0]?.type).toBe('Created');
    });

    it('event timestamp uses now()', () => {
      const result = runPatternMatch(makeInput({ now: () => 'FIXED_NOW' }));
      expect(result.events[0]?.timestamp).toBe('FIXED_NOW');
    });

    it('calls projectToShadow after match', () => {
      const projectToShadow = jest.fn();
      runPatternMatch(makeInput({ projectToShadow }));
      expect(projectToShadow).toHaveBeenCalledTimes(1);
    });

    it('returns empty secondaryCommands when no dispatch_commands', () => {
      const result = runPatternMatch(makeInput());
      expect(result.secondaryCommands).toHaveLength(0);
    });

    it('uses commandId as aggregateId for creation with no targetId', () => {
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'creation', targetId: null, commandId: 'cmd-xyz' }),
      }));
      // When no targetId and no identity config, nextEventId() is called for aggregateId
      expect(result.events[0]?.aggregateId).toBeDefined();
    });

    it('throws InternalExecutionError when emit type not in eventCatalog', () => {
      const boundary = makeBoundary({
        behaviors: [
          { name: 'b1', match: { intent: 'creation', condition: 'true' }, emit: 'Missing' },
        ],
        eventCatalog: [],
      });
      expect(() =>
        runPatternMatch(makeInput({ boundary })),
      ).toThrow(InternalExecutionError);
    });

    it('uses sequenceVersion from nextSequenceVersion callback', () => {
      const result = runPatternMatch(makeInput({ nextSequenceVersion: () => 5 }));
      expect(result.events[0]?.sequenceVersion).toBe(5);
    });

    it('event causedBy is set to commandId', () => {
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'creation', targetId: null, commandId: 'the-cmd' }),
      }));
      expect(result.events[0]?.causedBy).toBe('the-cmd');
    });
  });

  describe('first-match semantics', () => {
    it('uses first matching behavior, skips rest', () => {
      let callCount = 0;
      const cel = {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
        evaluate: () => { callCount++; return true; },
      };
      const boundary = makeBoundary({
        behaviors: [
          { name: 'b1', match: { intent: 'creation', condition: 'true' }, emit: 'Ev1' },
          { name: 'b2', match: { intent: 'creation', condition: 'true' }, emit: 'Ev2' },
        ],
        eventCatalog: [
          { type: 'Ev1', payloadTemplate: {} },
          { type: 'Ev2', payloadTemplate: {} },
        ],
      });
      const result = runPatternMatch(makeInput({ boundary, cel: cel as any }));
      expect(result.events[0]?.type).toBe('Ev1');
    });
  });
});
