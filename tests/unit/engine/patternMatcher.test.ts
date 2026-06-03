import { runPatternMatch } from '../../../src/engine/patternMatcher';
import type { PatternMatchInput } from '../../../src/engine/patternMatcher';
import {
  EntityAbsenceError,
  EntityConflictError,
  UnhandledOperationError,
  InternalExecutionError,
} from '../../../src/errors';
import { makeBoundary, makeCommand, makeOpenApi } from '../_helpers';
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

// The default command is a creation: POST /test → operationId 'createTest'.
function makeCreateCommand(overrides: Partial<Parameters<typeof makeCommand>[0]> = {}) {
  return makeCommand({
    intent: 'creation',
    targetId: null,
    httpMethod: 'POST',
    path: '/test',
    ...overrides,
  });
}

// A mutation command: PATCH /test/{id} → operationId 'updateTest'.
function makeUpdateCommand(overrides: Partial<Parameters<typeof makeCommand>[0]> = {}) {
  return makeCommand({
    intent: 'mutation',
    targetId: 'agg-1',
    httpMethod: 'PATCH',
    path: '/test/agg-1',
    ...overrides,
  });
}

function makeInput(overrides: Partial<PatternMatchInput> = {}): PatternMatchInput {
  return {
    command: makeCreateCommand(),
    boundary: makeBoundary({
      behaviors: [
        {
          name: 'b1',
          match: { operationId: 'createTest', condition: 'true' },
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
    openapi: makeOpenApi(),
    ...overrides,
  };
}

describe('engine/patternMatcher', () => {
  describe('operationId resolution', () => {
    it('throws EntityAbsenceError (404) when no operationId resolves for the route', () => {
      expect(() =>
        runPatternMatch(makeInput({
          command: makeCommand({ intent: 'query', targetId: null, httpMethod: 'GET', path: '/unknown' }),
        })),
      ).toThrow(EntityAbsenceError);
    });
  });

  describe('EntityAbsenceError', () => {
    it('throws EntityAbsenceError on mutation when state is null', () => {
      expect(() =>
        runPatternMatch(makeInput({
          command: makeUpdateCommand({ targetId: 'a1', path: '/test/a1' }),
          shadow: makeNoopShadow(null),
        })),
      ).toThrow(EntityAbsenceError);
    });

    it('EntityAbsenceError includes targetId in details', () => {
      try {
        runPatternMatch(makeInput({
          command: makeUpdateCommand({ targetId: 'miss-me', path: '/test/miss-me' }),
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
          command: makeCreateCommand({ targetId: 'existing' }),
          shadow: makeNoopShadow({ id: 'existing' }),
        })),
      ).toThrow(EntityConflictError);
    });
  });

  describe('UnhandledOperationError', () => {
    it('throws UnhandledOperationError when behavior condition is false', () => {
      expect(() =>
        runPatternMatch(makeInput({
          cel: fakeCelFalse as any,
        })),
      ).toThrow(UnhandledOperationError);
    });

    it('throws UnhandledOperationError when operationId does not match any behavior', () => {
      const boundary = makeBoundary({
        behaviors: [
          { name: 'b1', match: { operationId: 'updateTest', condition: 'true' }, emit: 'Updated' },
        ],
        eventCatalog: [{ type: 'Updated', payloadTemplate: {} }],
      });
      expect(() =>
        runPatternMatch(makeInput({
          command: makeCreateCommand(),
          boundary,
        })),
      ).toThrow(UnhandledOperationError);
    });

    it('treats CEL evaluation error as no-match', () => {
      expect(() =>
        runPatternMatch(makeInput({
          cel: fakeCelThrows as any,
        })),
      ).toThrow(UnhandledOperationError);
    });
  });

  describe('fallbackOverride', () => {
    it('returns GenericUpdateEvent when fallbackOverride is true and no behavior matches', () => {
      const boundary = makeBoundary({ fallbackOverride: true, behaviors: [] });
      const result = runPatternMatch(makeInput({
        command: makeUpdateCommand({ targetId: 'a1', path: '/test/a1' }),
        boundary,
        shadow: makeNoopShadow({ existing: true }),
      }));
      expect(result.events[0]?.type).toBe('System.GenericUpdateEvent');
    });

    it('fallback uses targetId as aggregateId when targetId present', () => {
      const boundary = makeBoundary({ fallbackOverride: true, behaviors: [] });
      const result = runPatternMatch(makeInput({
        command: makeUpdateCommand({ targetId: 'target-x', path: '/test/target-x' }),
        boundary,
        shadow: makeNoopShadow({ x: 1 }),
      }));
      expect(result.events[0]?.aggregateId).toBe('target-x');
    });

    it('query with fallback_override returns empty events and null state for collection-level query', () => {
      const boundary = makeBoundary({ fallbackOverride: true, behaviors: [] });
      const result = runPatternMatch(makeInput({
        command: makeCommand({ intent: 'query', targetId: null, httpMethod: 'GET', path: '/test' }),
        boundary,
        shadow: makeNoopShadow(null),
      }));
      expect(result.events).toHaveLength(0);
      expect(result.secondaryCommands).toHaveLength(0);
      expect(result.state).toBeNull();
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

    it('uses an aggregateId for creation with no targetId', () => {
      const result = runPatternMatch(makeInput({
        command: makeCreateCommand({ commandId: 'cmd-xyz' }),
      }));
      expect(result.events[0]?.aggregateId).toBeDefined();
    });

    it('throws InternalExecutionError when emit type not in eventCatalog', () => {
      const boundary = makeBoundary({
        behaviors: [
          { name: 'b1', match: { operationId: 'createTest', condition: 'true' }, emit: 'Missing' },
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
        command: makeCreateCommand({ commandId: 'the-cmd' }),
      }));
      expect(result.events[0]?.causedBy).toBe('the-cmd');
    });
  });

  describe('operationId dispatch', () => {
    it('dispatches to the behavior whose operationId equals the resolved id', () => {
      // Two behaviors keyed to different operationIds in one boundary (qualify vs disqualify
      // analogue). The PATCH /test/{id} → updateTest behavior must win over the createTest one.
      const boundary = makeBoundary({
        behaviors: [
          { name: 'create', match: { operationId: 'createTest', condition: 'true' }, emit: 'CreatedEv' },
          { name: 'update', match: { operationId: 'updateTest', condition: 'true' }, emit: 'UpdatedEv' },
        ],
        eventCatalog: [
          { type: 'CreatedEv', payloadTemplate: {} },
          { type: 'UpdatedEv', payloadTemplate: {} },
        ],
      });
      const result = runPatternMatch(makeInput({
        command: makeUpdateCommand({ targetId: 'a1', path: '/test/a1' }),
        boundary,
        shadow: makeNoopShadow({ id: 'a1' }),
      }));
      expect(result.events[0]?.type).toBe('UpdatedEv');
    });

    it('honours a command-carried operationId for secondary commands', () => {
      const boundary = makeBoundary({
        behaviors: [
          { name: 'cascadeTarget', match: { operationId: 'updateTest', condition: 'true' }, emit: 'CascadeEv' },
        ],
        eventCatalog: [{ type: 'CascadeEv', payloadTemplate: {} }],
      });
      const result = runPatternMatch(makeInput({
        command: makeCommand({
          intent: 'mutation',
          targetId: 'a1',
          httpMethod: 'PUT',
          path: '',
          operationId: 'updateTest',
          origin: 'secondary',
          depth: 1,
        }),
        boundary,
        shadow: makeNoopShadow({ id: 'a1' }),
      }));
      expect(result.events[0]?.type).toBe('CascadeEv');
    });
  });

  describe('first-match semantics', () => {
    it('uses first matching behavior, skips rest', () => {
      const cel = {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
        evaluate: () => true,
      };
      const boundary = makeBoundary({
        behaviors: [
          { name: 'b1', match: { operationId: 'createTest', condition: 'true' }, emit: 'Ev1' },
          { name: 'b2', match: { operationId: 'createTest', condition: 'true' }, emit: 'Ev2' },
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

  describe('match.headers — behavior header filtering', () => {
    function makeBoundaryWithHeaderBehavior(headers: Record<string, string>) {
      return makeBoundary({
        behaviors: [
          {
            name: 'header-gated',
            match: { operationId: 'createTest', condition: 'true', headers },
            emit: 'HeaderMatched',
          },
        ],
        eventCatalog: [{ type: 'HeaderMatched', payloadTemplate: {} }],
      });
    }

    it('fires when all declared headers are present with matching values', () => {
      const boundary = makeBoundaryWithHeaderBehavior({ 'x-my-header': 'yes' });
      const result = runPatternMatch(makeInput({
        boundary,
        command: makeCreateCommand({ headers: { 'x-my-header': 'yes' } }),
      }));
      expect(result.events[0]?.type).toBe('HeaderMatched');
    });

    it('does not match when a declared header is absent', () => {
      const boundary = makeBoundaryWithHeaderBehavior({ 'x-my-header': 'yes' });
      expect(() =>
        runPatternMatch(makeInput({
          boundary,
          command: makeCreateCommand({ headers: {} }),
        })),
      ).toThrow(UnhandledOperationError);
    });

    it('does not match when a declared header has a different value', () => {
      const boundary = makeBoundaryWithHeaderBehavior({ 'x-my-header': 'yes' });
      expect(() =>
        runPatternMatch(makeInput({
          boundary,
          command: makeCreateCommand({ headers: { 'x-my-header': 'no' } }),
        })),
      ).toThrow(UnhandledOperationError);
    });

    it('"present" sentinel matches any header value', () => {
      const boundary = makeBoundaryWithHeaderBehavior({ 'x-my-header': 'present' });
      const result = runPatternMatch(makeInput({
        boundary,
        command: makeCreateCommand({ headers: { 'x-my-header': 'anything-at-all' } }),
      }));
      expect(result.events[0]?.type).toBe('HeaderMatched');
    });

    it('"present" sentinel does not match when header is absent', () => {
      const boundary = makeBoundaryWithHeaderBehavior({ 'x-my-header': 'present' });
      expect(() =>
        runPatternMatch(makeInput({
          boundary,
          command: makeCreateCommand({ headers: {} }),
        })),
      ).toThrow(UnhandledOperationError);
    });

    it('AND semantics: all headers must match — fails when only first matches', () => {
      const boundary = makeBoundaryWithHeaderBehavior({
        'x-header-a': 'alpha',
        'x-header-b': 'beta',
      });
      expect(() =>
        runPatternMatch(makeInput({
          boundary,
          command: makeCreateCommand({ headers: { 'x-header-a': 'alpha' } }),
        })),
      ).toThrow(UnhandledOperationError);
    });

    it('AND semantics: fires when all headers match', () => {
      const boundary = makeBoundaryWithHeaderBehavior({
        'x-header-a': 'alpha',
        'x-header-b': 'beta',
      });
      const result = runPatternMatch(makeInput({
        boundary,
        command: makeCreateCommand({ headers: { 'x-header-a': 'alpha', 'x-header-b': 'beta' } }),
      }));
      expect(result.events[0]?.type).toBe('HeaderMatched');
    });

    it('header matching is case-insensitive on the name', () => {
      const boundary = makeBoundaryWithHeaderBehavior({ 'x-my-header': 'yes' });
      // command.headers keys are lowercased; match is done with name.toLowerCase()
      const result = runPatternMatch(makeInput({
        boundary,
        command: makeCreateCommand({ headers: { 'x-my-header': 'yes' } }),
      }));
      expect(result.events[0]?.type).toBe('HeaderMatched');
    });

    it('behavior without match.headers fires regardless of request headers', () => {
      const boundary = makeBoundary({
        behaviors: [
          { name: 'unconditional', match: { operationId: 'createTest', condition: 'true' }, emit: 'UnconditionalEv' },
        ],
        eventCatalog: [{ type: 'UnconditionalEv', payloadTemplate: {} }],
      });
      const result = runPatternMatch(makeInput({
        boundary,
        command: makeCreateCommand({ headers: {} }),
      }));
      expect(result.events[0]?.type).toBe('UnconditionalEv');
    });

    it('falls through to second behavior when first fails header match', () => {
      const boundary = makeBoundary({
        behaviors: [
          {
            name: 'header-gated',
            match: { operationId: 'createTest', condition: 'true', headers: { 'x-my-header': 'required' } },
            emit: 'HeaderEv',
          },
          {
            name: 'fallback-behavior',
            match: { operationId: 'createTest', condition: 'true' },
            emit: 'FallbackEv',
          },
        ],
        eventCatalog: [
          { type: 'HeaderEv', payloadTemplate: {} },
          { type: 'FallbackEv', payloadTemplate: {} },
        ],
      });
      const result = runPatternMatch(makeInput({
        boundary,
        command: makeCreateCommand({ headers: {} }),
      }));
      expect(result.events[0]?.type).toBe('FallbackEv');
    });
  });

  describe('dispatch_commands — mutation target_id resolution', () => {
    function makeCelWithTargetResult(targetResult: unknown) {
      return {
        compile: (e: string) => ({ source: e, _ast: {} as any }),
        evaluate: (_expr: string, _ctx: unknown, _phase: unknown) => {
          // Return targetResult only for the target_id expression; return true otherwise
          // so behavior conditions evaluate to true.
          if (_expr === 'null_target') return targetResult;
          return true;
        },
      };
    }

    function makeBoundaryWithDispatch(targetIdExpr: string) {
      return makeBoundary({
        behaviors: [
          {
            name: 'b1',
            match: { operationId: 'createTest', condition: 'true' },
            emit: 'Created',
            dispatchCommands: [
              {
                boundary: 'OtherBoundary',
                intent: 'mutation' as const,
                operationId: 'updateOther',
                targetId: targetIdExpr,
              },
            ],
          },
        ],
        eventCatalog: [{ type: 'Created', payloadTemplate: {} }],
      });
    }

    it('throws InternalExecutionError when dispatch_commands mutation target_id resolves to null', () => {
      const boundary = makeBoundaryWithDispatch('null_target');
      const cel = makeCelWithTargetResult(null);

      expect(() =>
        runPatternMatch(makeInput({
          boundary,
          cel: cel as any,
          projectToShadow: jest.fn(),
        })),
      ).toThrow(InternalExecutionError);
    });

    it('throws InternalExecutionError when dispatch_commands mutation target_id resolves to a non-string (number)', () => {
      const boundary = makeBoundaryWithDispatch('null_target');
      const cel = makeCelWithTargetResult(42);

      expect(() =>
        runPatternMatch(makeInput({
          boundary,
          cel: cel as any,
          projectToShadow: jest.fn(),
        })),
      ).toThrow(InternalExecutionError);
    });

    it('does not create a phantom aggregate when target_id resolves to null — error is thrown before queueing', () => {
      const boundary = makeBoundaryWithDispatch('null_target');
      const cel = makeCelWithTargetResult(null);

      let result: ReturnType<typeof runPatternMatch> | undefined;
      try {
        result = runPatternMatch(makeInput({
          boundary,
          cel: cel as any,
          projectToShadow: jest.fn(),
        }));
      } catch {
        // expected
      }
      expect(result).toBeUndefined();
    });

    it('queues a secondary command when target_id resolves to a valid string', () => {
      const boundary = makeBoundaryWithDispatch('null_target');
      const cel = makeCelWithTargetResult('valid-agg-id');

      const result = runPatternMatch(makeInput({
        boundary,
        cel: cel as any,
        projectToShadow: jest.fn(),
      }));

      expect(result.secondaryCommands).toHaveLength(1);
      expect(result.secondaryCommands[0]?.targetId).toBe('valid-agg-id');
      expect(result.secondaryCommands[0]?.intent).toBe('mutation');
    });
  });
});
