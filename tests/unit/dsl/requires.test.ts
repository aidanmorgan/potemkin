/**
 * REQ-61: match.requires[] — named precondition guards
 * Tests both the DSL schema parsing and the runtime behavior.
 */
import { validateBoundaryConfig } from '../../../src/dsl/schema';
import { runPatternMatch } from '../../../src/engine/patternMatcher';
import type { PatternMatchInput } from '../../../src/engine/patternMatcher';
import { BootError, UnhandledOperationError } from '../../../src/errors';
import { makeBoundary, makeCommand, makeOpenApi } from '../_helpers';
import type { ShadowGraph } from '../../../src/stategraph/shadow';
import { createCelEvaluator } from '../../../src/cel/evaluator';

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

const cel = createCelEvaluator();

function makeInput(overrides: Partial<PatternMatchInput> = {}): PatternMatchInput {
  return {
    command: makeCommand({ intent: 'mutation', targetId: 'agg-1' }),
    boundary: makeBoundary(),
    shadow: makeNoopShadow({ status: 'ACTIVE', balance: 100 }),
    cel,
    nextEventId: () => 'evt-1',
    nextSequenceVersion: () => 1,
    projectToShadow: jest.fn(),
    now: () => '2024-01-01T00:00:00.000Z',
    openapi: makeOpenApi(),
    ...overrides,
  };
}

// ── Schema parsing tests ───────────────────────────────────────────────────────

describe('REQ-61: match.requires[] DSL parsing', () => {
  it('parses a requires array with expression/message style (design.md)', () => {
    const config = validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [
        {
          name: 'disburse',
          match: {
            operationId: 'updateTest',
            condition: 'true',
            requires: [
              { name: 'loan-active', expression: "state.status != 'FROZEN'", message: 'Loan is frozen' },
            ],
          },
          emit: 'LoanDisbursed',
        },
      ],
      reducers: [{ on: 'LoanDisbursed', assign: { status: '"disbursed"' } }],
      event_catalog: [{ type: 'LoanDisbursed', payload_template: {} }],
    });
    const req = config.behaviors[0].match.requires![0];
    expect(req.name).toBe('loan-active');
    expect(req.condition).toBe("state.status != 'FROZEN'");
  });

  it('parses a requires array with condition/error_code/error_message style (task spec)', () => {
    const config = validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [
        {
          name: 'disburse',
          match: {
            operationId: 'updateTest',
            condition: 'true',
            requires: [
              {
                name: 'loan-active',
                condition: "state.status == 'ACTIVE'",
                error_code: 'LOAN_NOT_ACTIVE',
                error_message: 'Operation requires an ACTIVE loan',
              },
            ],
          },
          emit: 'LoanDisbursed',
        },
      ],
      reducers: [{ on: 'LoanDisbursed', assign: { status: '"disbursed"' } }],
      event_catalog: [{ type: 'LoanDisbursed', payload_template: {} }],
    });
    const req = config.behaviors[0].match.requires![0];
    expect(req.errorCode).toBe('LOAN_NOT_ACTIVE');
    expect(req.errorMessage).toBe('Operation requires an ACTIVE loan');
  });

  it('throws BootError when requires entry is missing name', () => {
    expect(() => validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [
        {
          name: 'b1',
          match: {
            operationId: 'updateTest',
            condition: 'true',
            requires: [{ condition: 'true' }],
          },
          emit: 'Evt',
        },
      ],
      reducers: [],
      event_catalog: [{ type: 'Evt', payload_template: {} }],
    })).toThrow(BootError);
  });

  it('throws BootError when requires entry has no condition or expression field', () => {
    expect(() => validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [
        {
          name: 'b1',
          match: {
            operationId: 'updateTest',
            condition: 'true',
            requires: [{ name: 'req1' }],
          },
          emit: 'Evt',
        },
      ],
      reducers: [],
      event_catalog: [{ type: 'Evt', payload_template: {} }],
    })).toThrow(BootError);
  });
});

// ── Runtime tests ──────────────────────────────────────────────────────────────

describe('REQ-61: match.requires[] runtime behavior', () => {
  it('allows behavior to match when all requires pass', () => {
    const input = makeInput({
      boundary: makeBoundary({
        behaviors: [
          {
            name: 'transfer',
            match: {
              operationId: 'updateTest',
              condition: 'true',
              requires: [
                { name: 'is-active', condition: "state.status == 'ACTIVE'", errorCode: 'NOT_ACTIVE', errorMessage: 'Not active' },
              ],
            },
            emit: 'Transferred',
            dispatchCommands: undefined,
          },
        ],
        eventCatalog: [{ type: 'Transferred', payloadTemplate: {} }],
      }),
      shadow: makeNoopShadow({ status: 'ACTIVE', balance: 100 }),
    });
    const outcome = runPatternMatch(input);
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0].type).toBe('Transferred');
  });

  it('throws UnhandledOperationError (422) when a requires condition fails', () => {
    const input = makeInput({
      boundary: makeBoundary({
        behaviors: [
          {
            name: 'transfer',
            match: {
              operationId: 'updateTest',
              condition: 'true',
              requires: [
                { name: 'is-active', condition: "state.status == 'ACTIVE'", errorCode: 'NOT_ACTIVE', errorMessage: 'Loan must be ACTIVE' },
              ],
            },
            emit: 'Transferred',
          },
        ],
        eventCatalog: [{ type: 'Transferred', payloadTemplate: {} }],
      }),
      shadow: makeNoopShadow({ status: 'FROZEN', balance: 100 }),
    });
    expect(() => runPatternMatch(input)).toThrow(UnhandledOperationError);
    try {
      runPatternMatch(input);
    } catch (err) {
      expect(err instanceof UnhandledOperationError).toBe(true);
      const details = (err as UnhandledOperationError).details as Record<string, unknown>;
      expect(details['requirement']).toBe('is-active');
      expect(details['message']).toBe('Loan must be ACTIVE');
    }
  });

  it('evaluates requires before match.condition (short-circuit)', () => {
    const conditionCalls: string[] = [];
    const trackingCel = {
      compile: (e: string) => ({ source: e, _ast: {} }),
      evaluate: (expr: string) => {
        conditionCalls.push(expr);
        if (expr === "state.status == 'ACTIVE'") return false;
        return true;
      },
    };

    const input = makeInput({
      cel: trackingCel as unknown as ReturnType<typeof createCelEvaluator>,
      boundary: makeBoundary({
        behaviors: [
          {
            name: 'transfer',
            match: {
              operationId: 'updateTest',
              condition: 'command.payload.amount > 0',
              requires: [
                { name: 'is-active', condition: "state.status == 'ACTIVE'", errorCode: 'E', errorMessage: 'E' },
              ],
            },
            emit: 'Transferred',
          },
        ],
        eventCatalog: [{ type: 'Transferred', payloadTemplate: {} }],
      }),
    });

    expect(() => runPatternMatch(input)).toThrow(UnhandledOperationError);
    // match.condition should NOT have been evaluated
    expect(conditionCalls).not.toContain('command.payload.amount > 0');
    expect(conditionCalls).toContain("state.status == 'ACTIVE'");
  });
});
