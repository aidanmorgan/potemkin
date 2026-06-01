/**
 * behaviors[].emit_when[] — conditional multi-event emission
 */
import { validateBoundaryConfig } from '../../../src/dsl/schema';
import { runPatternMatch } from '../../../src/engine/patternMatcher';
import type { PatternMatchInput } from '../../../src/engine/patternMatcher';
import { BootError } from '../../../src/errors';
import { makeBoundary, makeCommand, makeOpenApi } from '../_helpers';
import type { ShadowGraph } from '../../../src/stategraph/shadow';
import { createCelEvaluator } from '../../../src/cel/evaluator';

function makeNoopShadow(initial: Record<string, unknown> | null = null): ShadowGraph {
  const staged = new Map<string, Record<string, unknown>>();
  return {
    get: (id: string) => staged.has(id) ? staged.get(id) as Record<string, unknown> : initial,
    stage: (id: string, val: Record<string, unknown>) => { staged.set(id, val); },
    has: (id: string) => staged.has(id) || initial !== null,
    shadowed: () => staged as Map<string, Record<string, unknown>>,
    commitInto: jest.fn(),
  } as unknown as ShadowGraph;
}

const cel = createCelEvaluator();

function makeInput(overrides: Partial<PatternMatchInput> = {}): PatternMatchInput {
  return {
    command: makeCommand({ intent: 'mutation', targetId: 'agg-1', payload: { amount: 100, cancel: false } }),
    boundary: makeBoundary(),
    shadow: makeNoopShadow({ balance: 150 }),
    cel,
    nextEventId: (() => { let i = 0; return () => `evt-${++i}`; })(),
    nextSequenceVersion: (() => { let n = 0; return () => ++n; })(),
    projectToShadow: jest.fn(),
    now: () => '2024-01-01T00:00:00.000Z',
    openapi: makeOpenApi(),
    ...overrides,
  };
}

// ── Schema parsing ─────────────────────────────────────────────────────────────

describe('emit_when DSL parsing', () => {
  it('parses emit_when array correctly', () => {
    const config = validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [
        {
          name: 'repay',
          match: { operationId: 'updateTest', condition: 'true' },
          emit_when: [
            { when: 'command.payload.amount < state.balance', emit: 'LoanRepaid' },
            { when: 'command.payload.amount >= state.balance', emit: 'LoanSettled' },
          ],
        },
      ],
      reducers: [],
      event_catalog: [
        { type: 'LoanRepaid', payload_template: {} },
        { type: 'LoanSettled', payload_template: {} },
      ],
    });
    expect(config.behaviors[0].emitWhen).toHaveLength(2);
    expect(config.behaviors[0].emitWhen![0].when).toBe('command.payload.amount < state.balance');
    expect(config.behaviors[0].emitWhen![0].emit).toBe('LoanRepaid');
  });

  it('throws BootError when emit and emit_when are both present (mutual exclusion)', () => {
    expect(() => validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [
        {
          name: 'repay',
          match: { operationId: 'updateTest', condition: 'true' },
          emit: 'LoanRepaid',
          emit_when: [{ when: 'true', emit: 'LoanRepaid' }],
        },
      ],
      reducers: [],
      event_catalog: [{ type: 'LoanRepaid', payload_template: {} }],
    })).toThrow(BootError);
  });

  it('throws BootError when neither emit nor emit_when is present', () => {
    expect(() => validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [
        {
          name: 'repay',
          match: { operationId: 'updateTest', condition: 'true' },
        },
      ],
      reducers: [],
      event_catalog: [{ type: 'LoanRepaid', payload_template: {} }],
    })).toThrow(BootError);
  });

  it('throws BootError when emit_when references unknown event type', () => {
    expect(() => validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [
        {
          name: 'repay',
          match: { operationId: 'updateTest', condition: 'true' },
          emit_when: [{ when: 'true', emit: 'NonExistentEvent' }],
        },
      ],
      reducers: [],
      event_catalog: [{ type: 'LoanRepaid', payload_template: {} }],
    })).toThrow(BootError);
  });

  it('throws BootError when emit_when array is empty', () => {
    expect(() => validateBoundaryConfig({
      boundary: 'Loan',
      contract_path: '/loans',
      behaviors: [
        {
          name: 'repay',
          match: { operationId: 'updateTest', condition: 'true' },
          emit_when: [],
        },
      ],
      reducers: [],
      event_catalog: [{ type: 'LoanRepaid', payload_template: {} }],
    })).toThrow(BootError);
  });
});

// ── Runtime tests ──────────────────────────────────────────────────────────────

describe('emit_when runtime multi-emit', () => {
  it('emits partial repayment event when amount < balance', () => {
    const input = makeInput({
      command: makeCommand({ intent: 'mutation', targetId: 'agg-1', payload: { amount: 50 } }),
      shadow: makeNoopShadow({ balance: 150 }),
      boundary: makeBoundary({
        behaviors: [
          {
            name: 'repay',
            match: { operationId: 'updateTest', condition: 'true' },
            emitWhen: [
              { when: 'command.payload.amount < state.balance', emit: 'LoanRepaid' },
              { when: 'command.payload.amount >= state.balance', emit: 'LoanSettled' },
            ],
          },
        ],
        eventCatalog: [
          { type: 'LoanRepaid', payloadTemplate: {} },
          { type: 'LoanSettled', payloadTemplate: {} },
        ],
      }),
    });
    const outcome = runPatternMatch(input);
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0].type).toBe('LoanRepaid');
  });

  it('emits settlement event when amount >= balance', () => {
    const input = makeInput({
      command: makeCommand({ intent: 'mutation', targetId: 'agg-1', payload: { amount: 200 } }),
      shadow: makeNoopShadow({ balance: 150 }),
      boundary: makeBoundary({
        behaviors: [
          {
            name: 'repay',
            match: { operationId: 'updateTest', condition: 'true' },
            emitWhen: [
              { when: 'command.payload.amount < state.balance', emit: 'LoanRepaid' },
              { when: 'command.payload.amount >= state.balance', emit: 'LoanSettled' },
            ],
          },
        ],
        eventCatalog: [
          { type: 'LoanRepaid', payloadTemplate: {} },
          { type: 'LoanSettled', payloadTemplate: {} },
        ],
      }),
    });
    const outcome = runPatternMatch(input);
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0].type).toBe('LoanSettled');
  });

  it('emits multiple events when multiple emit_when conditions match', () => {
    const input = makeInput({
      command: makeCommand({ intent: 'mutation', targetId: 'agg-1', payload: { amount: 100, notify: true } }),
      shadow: makeNoopShadow({ balance: 50 }),
      boundary: makeBoundary({
        behaviors: [
          {
            name: 'repay',
            match: { operationId: 'updateTest', condition: 'true' },
            emitWhen: [
              { when: 'command.payload.amount >= state.balance', emit: 'LoanSettled' },
              { when: 'command.payload.notify == true', emit: 'NotificationSent' },
            ],
          },
        ],
        eventCatalog: [
          { type: 'LoanSettled', payloadTemplate: {} },
          { type: 'NotificationSent', payloadTemplate: {} },
        ],
      }),
    });
    const outcome = runPatternMatch(input);
    expect(outcome.events).toHaveLength(2);
    const types = outcome.events.map(e => e.type);
    expect(types).toContain('LoanSettled');
    expect(types).toContain('NotificationSent');
  });

  it('emits zero events when no emit_when conditions match', () => {
    const input = makeInput({
      command: makeCommand({ intent: 'mutation', targetId: 'agg-1', payload: { amount: 50 } }),
      shadow: makeNoopShadow({ balance: 100 }),
      boundary: makeBoundary({
        behaviors: [
          {
            name: 'settle-only',
            match: { operationId: 'updateTest', condition: 'true' },
            emitWhen: [
              { when: 'command.payload.amount >= state.balance', emit: 'LoanSettled' },
            ],
          },
        ],
        eventCatalog: [
          { type: 'LoanSettled', payloadTemplate: {} },
        ],
      }),
    });
    const outcome = runPatternMatch(input);
    // amount 50 < balance 100 → condition false → no events emitted
    expect(outcome.events).toHaveLength(0);
  });
});
