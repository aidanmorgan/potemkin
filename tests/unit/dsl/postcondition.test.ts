/**
 * behaviors[].postcondition — evaluated after projection
 */
import { validateBoundaryConfig } from '../../../src/dsl/schema';
import { runPatternMatch } from '../../../src/engine/patternMatcher';
import type { PatternMatchInput } from '../../../src/engine/patternMatcher';
import { BootError, InternalExecutionError } from '../../../src/errors';
import { makeBoundary, makeCommand, makeOpenApi } from '../_helpers';
import type { ShadowGraph } from '../../../src/stategraph/shadow';
import { createCelEvaluator } from '../../../src/cel/evaluator';

function makeNoopShadow(initial: Record<string, unknown> | null = null): ShadowGraph {
  let state = initial;
  const staged = new Map<string, Record<string, unknown>>();
  return {
    get: (id: string) => staged.has(id) ? staged.get(id) as Record<string, unknown> : state,
    stage: (id: string, val: Record<string, unknown>) => { staged.set(id, val); state = val; },
    has: (id: string) => staged.has(id) || state !== null,
    shadowed: () => staged as Map<string, Record<string, unknown>>,
    commitInto: jest.fn(),
  } as unknown as ShadowGraph;
}

const cel = createCelEvaluator();

function makeInput(overrides: Partial<PatternMatchInput> = {}): PatternMatchInput {
  return {
    command: makeCommand({ intent: 'mutation', targetId: 'agg-1', payload: { amount: 50 } }),
    boundary: makeBoundary(),
    shadow: makeNoopShadow({ balance: 100 }),
    cel,
    nextEventId: () => 'evt-1',
    nextSequenceVersion: () => 1,
    projectToShadow: jest.fn((_evt) => {
      // Simulate projection: update shadow balance
    }),
    now: () => '2024-01-01T00:00:00.000Z',
    openapi: makeOpenApi(),
    ...overrides,
  };
}

// ── Schema parsing ─────────────────────────────────────────────────────────────

describe('postcondition DSL parsing', () => {
  it('parses postcondition as a plain string', () => {
    const config = validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [
        {
          name: 'repay',
          match: { operationId: 'updateTest', condition: 'true' },
          emit: 'LoanRepaid',
          postcondition: 'state.balance >= 0',
        },
      ],
      reducers: [],
      event_catalog: [{ type: 'LoanRepaid', payload_template: {} }],
    });
    expect(config.behaviors[0].postcondition).toBe('state.balance >= 0');
  });

  it('parses postcondition as an object with expression field (design.md style)', () => {
    const config = validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [
        {
          name: 'repay',
          match: { operationId: 'updateTest', condition: 'true' },
          emit: 'LoanRepaid',
          postcondition: { expression: 'state.balance >= 0', message: 'Balance cannot go negative' },
        },
      ],
      reducers: [],
      event_catalog: [{ type: 'LoanRepaid', payload_template: {} }],
    });
    expect(config.behaviors[0].postcondition).toBe('state.balance >= 0');
  });

  it('throws BootError for invalid postcondition type', () => {
    expect(() => validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [
        {
          name: 'repay',
          match: { operationId: 'updateTest', condition: 'true' },
          emit: 'LoanRepaid',
          postcondition: 123,
        },
      ],
      reducers: [],
      event_catalog: [{ type: 'LoanRepaid', payload_template: {} }],
    })).toThrow(BootError);
  });
});

// ── Runtime tests ──────────────────────────────────────────────────────────────

describe('postcondition runtime behavior', () => {
  it('succeeds when postcondition evaluates to true', () => {
    // Set up shadow so that after projectToShadow is called, get() returns a valid state
    const shadow = makeNoopShadow({ balance: 100 });
    const projectToShadow = jest.fn((_evt) => {
      // Simulate: reduce balance by 50 on LoanRepaid
      shadow.stage('agg-1', { balance: 50 });
    });

    const input = makeInput({
      boundary: makeBoundary({
        behaviors: [
          {
            name: 'repay',
            match: { operationId: 'updateTest', condition: 'true' },
            emit: 'LoanRepaid',
            postcondition: 'state.balance >= 0',
          },
        ],
        eventCatalog: [{ type: 'LoanRepaid', payloadTemplate: {} }],
      }),
      shadow,
      projectToShadow,
    });

    const outcome = runPatternMatch(input);
    expect(outcome.events).toHaveLength(1);
  });

  it('throws InternalExecutionError with POSTCONDITION_VIOLATED when postcondition fails', () => {
    // Set up shadow so balance goes negative after projection
    const shadow = makeNoopShadow({ balance: 100 });
    const projectToShadow = jest.fn(() => {
      shadow.stage('agg-1', { balance: -10 });
    });

    const input = makeInput({
      boundary: makeBoundary({
        behaviors: [
          {
            name: 'repay',
            match: { operationId: 'updateTest', condition: 'true' },
            emit: 'LoanRepaid',
            postcondition: 'state.balance >= 0',
          },
        ],
        eventCatalog: [{ type: 'LoanRepaid', payloadTemplate: {} }],
      }),
      shadow,
      projectToShadow,
    });

    expect(() => runPatternMatch(input)).toThrow(InternalExecutionError);
    try {
      runPatternMatch(input);
    } catch (err) {
      expect(err instanceof InternalExecutionError).toBe(true);
      const details = (err as InternalExecutionError).details as Record<string, unknown>;
      expect(details['code']).toBe('POSTCONDITION_VIOLATED');
      expect(details['behavior']).toBe('repay');
      expect(details['expression']).toBe('state.balance >= 0');
    }
  });
});
