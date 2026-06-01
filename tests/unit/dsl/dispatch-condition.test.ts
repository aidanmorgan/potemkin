/**
 * REQ-63: dispatch_commands[].condition — per-secondary-command gating
 */
import { validateBoundaryConfig } from '../../../src/dsl/schema';
import { runPatternMatch } from '../../../src/engine/patternMatcher';
import type { PatternMatchInput } from '../../../src/engine/patternMatcher';
import { makeBoundary, makeCommand, makeOpenApi } from '../_helpers';
import type { ShadowGraph } from '../../../src/stategraph/shadow';
import { createCelEvaluator } from '../../../src/cel/evaluator';

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

const cel = createCelEvaluator();

function makeInput(overrides: Partial<PatternMatchInput> = {}): PatternMatchInput {
  return {
    command: makeCommand({ intent: 'mutation', targetId: 'agg-1', payload: { amount: 1000 } }),
    boundary: makeBoundary(),
    shadow: makeNoopShadow({ balance: 100 }),
    cel,
    nextEventId: () => 'evt-1',
    nextSequenceVersion: () => 1,
    projectToShadow: jest.fn(),
    now: () => '2024-01-01T00:00:00.000Z',
    openapi: makeOpenApi(),
    ...overrides,
  };
}

// ── Schema parsing ─────────────────────────────────────────────────────────────

describe('REQ-63: dispatch_commands[].condition DSL parsing', () => {
  it('parses condition on dispatch_commands entry', () => {
    const config = validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [
        {
          name: 'repay',
          match: { operationId: 'updateTest', condition: 'true' },
          emit: 'LoanRepaid',
          dispatch_commands: [
            {
              boundary: 'CreditBureau',
              intent: 'mutation',
              operationId: 'updateTest',
              target_id: 'state.customerId',
              condition: 'command.payload.amount > 50000',
              payload: { loanId: 'command.targetId' },
            },
          ],
        },
      ],
      reducers: [],
      event_catalog: [{ type: 'LoanRepaid', payload_template: {} }],
    });
    const dc = config.behaviors[0].dispatchCommands![0];
    expect(dc.condition).toBe('command.payload.amount > 50000');
  });

  it('parses dispatch_commands without condition (no change to existing behavior)', () => {
    const config = validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [
        {
          name: 'repay',
          match: { operationId: 'updateTest', condition: 'true' },
          emit: 'LoanRepaid',
          dispatch_commands: [
            {
              boundary: 'Audit',
              intent: 'mutation',
              operationId: 'updateTest',
              target_id: '"audit-target"',
              payload: {},
            },
          ],
        },
      ],
      reducers: [],
      event_catalog: [{ type: 'LoanRepaid', payload_template: {} }],
    });
    const dc = config.behaviors[0].dispatchCommands![0];
    expect(dc.condition).toBeUndefined();
  });
});

// ── Runtime tests ──────────────────────────────────────────────────────────────

describe('REQ-63: dispatch_commands[].condition runtime gating', () => {
  it('queues secondary command when condition is true', () => {
    const input = makeInput({
      command: makeCommand({ intent: 'mutation', targetId: 'agg-1', payload: { amount: 60000 } }),
      boundary: makeBoundary({
        behaviors: [
          {
            name: 'repay',
            match: { operationId: 'updateTest', condition: 'true' },
            emit: 'LoanRepaid',
            dispatchCommands: [
              {
                boundary: 'CreditBureau',
                intent: 'mutation',
                operationId: 'updateTest',
                targetId: '"bureau-target"',
                condition: 'command.payload.amount > 50000',
                payload: {},
              },
            ],
          },
        ],
        eventCatalog: [{ type: 'LoanRepaid', payloadTemplate: {} }],
      }),
    });
    const outcome = runPatternMatch(input);
    expect(outcome.secondaryCommands).toHaveLength(1);
    expect(outcome.secondaryCommands[0].boundary).toBe('CreditBureau');
  });

  it('skips secondary command when condition is false', () => {
    const input = makeInput({
      command: makeCommand({ intent: 'mutation', targetId: 'agg-1', payload: { amount: 100 } }),
      boundary: makeBoundary({
        behaviors: [
          {
            name: 'repay',
            match: { operationId: 'updateTest', condition: 'true' },
            emit: 'LoanRepaid',
            dispatchCommands: [
              {
                boundary: 'CreditBureau',
                intent: 'mutation',
                operationId: 'updateTest',
                targetId: '"bureau-target"',
                condition: 'command.payload.amount > 50000',
                payload: {},
              },
            ],
          },
        ],
        eventCatalog: [{ type: 'LoanRepaid', payloadTemplate: {} }],
      }),
    });
    const outcome = runPatternMatch(input);
    expect(outcome.secondaryCommands).toHaveLength(0);
  });

  it('queues unconditional commands alongside conditional ones', () => {
    const input = makeInput({
      command: makeCommand({ intent: 'mutation', targetId: 'agg-1', payload: { amount: 100 } }),
      boundary: makeBoundary({
        behaviors: [
          {
            name: 'repay',
            match: { operationId: 'updateTest', condition: 'true' },
            emit: 'LoanRepaid',
            dispatchCommands: [
              {
                boundary: 'Audit',
                intent: 'mutation',
                operationId: 'updateTest',
                targetId: '"audit-target"',
                payload: {},
                // No condition — always queued
              },
              {
                boundary: 'CreditBureau',
                intent: 'mutation',
                operationId: 'updateTest',
                targetId: '"bureau-target"',
                condition: 'command.payload.amount > 50000',
                payload: {},
              },
            ],
          },
        ],
        eventCatalog: [{ type: 'LoanRepaid', payloadTemplate: {} }],
      }),
    });
    const outcome = runPatternMatch(input);
    // Only the unconditional Audit command should be queued (amount 100 < 50000)
    expect(outcome.secondaryCommands).toHaveLength(1);
    expect(outcome.secondaryCommands[0].boundary).toBe('Audit');
  });
});
