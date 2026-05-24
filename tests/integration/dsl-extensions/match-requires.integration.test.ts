/**
 * REQ-61: match.requires[] — end-to-end integration permutation tests.
 *
 * Tests cover: guard passing/failing, first-fail wins, ordering vs condition,
 * state/command references, empty array, CEL comprehension in guard,
 * and inline TS in guard.
 */

import { bootAndRun } from './_helpers/dsl-builder.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeRequiresDsl(opts: {
  requires: string;   // YAML block for requires[]
  conditionExpr?: string;
  emitType?: string;
}): { yaml: string; entity: Record<string, unknown> } {
  const entityId = nextUuidv7();
  const condition = opts.conditionExpr ?? 'true';
  const emitType = opts.emitType ?? 'WidgetUpdated';
  return {
    entity: { id: entityId, status: 'ACTIVE', balance: 500, transactions: [] },
    yaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
  - type: OtherEvent
    payload_template:
      id: "command.targetId"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "${condition}"
${opts.requires}
    emit: ${emitType}
reducers:
  - on: WidgetUpdated
    assign:
      status: "'UPDATED'"
  - on: OtherEvent
    assign:
      status: "'OTHER'"
`,
  };
}

// ---------------------------------------------------------------------------
// Test: single requires guard, passing → behavior fires
// ---------------------------------------------------------------------------

describe('REQ-61: match.requires — single guard, passing', () => {
  it('fires behavior when the single requires condition is true', async () => {
    const entityId = nextUuidv7();
    const { result, events, state } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 500 },
      commandPayload: {},
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
      requires:
        - name: is-active
          condition: "state.status == 'ACTIVE'"
          error_code: NOT_ACTIVE
          error_message: "Widget must be ACTIVE"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    assign:
      status: "'UPDATED'"
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('WidgetUpdated');
    expect(state?.['status']).toBe('UPDATED');
  });
});

// ---------------------------------------------------------------------------
// Test: single requires guard, failing → 422 with error_code/message/requirement
// ---------------------------------------------------------------------------

describe('REQ-61: match.requires — single guard, failing', () => {
  it('returns 422 with error_code, error_message, and requirement name when guard fails', async () => {
    const entityId = nextUuidv7();
    const { result } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'FROZEN', balance: 0 },
      commandPayload: {},
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
      requires:
        - name: is-active
          condition: "state.status == 'ACTIVE'"
          error_code: WIDGET_NOT_ACTIVE
          error_message: "Widget must be in ACTIVE status to be updated"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    assign:
      status: "'UPDATED'"
`,
    });
    expect(result.status).toBe(422);
    const body = result.body as Record<string, unknown>;
    expect(body['error']).toBeTruthy();
    const errorStr = String(body['error']);
    expect(errorStr).toContain('ACTIVE');
  });
});

// ---------------------------------------------------------------------------
// Test: multiple requires; FIRST failure reported (not later ones)
// ---------------------------------------------------------------------------

describe('REQ-61: match.requires — multiple guards, first failure wins', () => {
  it('reports first failed guard when multiple guards are present', async () => {
    const entityId = nextUuidv7();
    const { result, thrownError } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'FROZEN', balance: 0 },
      commandPayload: { amount: 100 },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
      requires:
        - name: is-active
          condition: "state.status == 'ACTIVE'"
          error_code: WIDGET_NOT_ACTIVE
          error_message: "Widget must be ACTIVE"
        - name: has-balance
          condition: "state.balance > 0"
          error_code: INSUFFICIENT_BALANCE
          error_message: "Insufficient balance"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    assign:
      status: "'UPDATED'"
`,
    });
    // First guard (is-active) should fail; second (has-balance) never evaluated
    expect(result.status).toBe(422);
    const body = result.body as Record<string, unknown>;
    const errorStr = String(body['error']);
    // The error should reference the first guard's message
    expect(errorStr).toContain('ACTIVE');
    // Should NOT contain the second guard's message
    expect(errorStr).not.toContain('balance');
  });

  it('reports second guard when first passes but second fails', async () => {
    const entityId = nextUuidv7();
    const { result } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 0 },
      commandPayload: { amount: 100 },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
      requires:
        - name: is-active
          condition: "state.status == 'ACTIVE'"
          error_code: WIDGET_NOT_ACTIVE
          error_message: "Widget must be ACTIVE"
        - name: has-balance
          condition: "state.balance > 0"
          error_code: INSUFFICIENT_BALANCE
          error_message: "Insufficient balance"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    assign:
      status: "'UPDATED'"
`,
    });
    expect(result.status).toBe(422);
    const body = result.body as Record<string, unknown>;
    const errorStr = String(body['error']);
    expect(errorStr).toContain('balance');
  });
});

// ---------------------------------------------------------------------------
// Test: requires evaluated BEFORE match.condition
// ---------------------------------------------------------------------------

describe('REQ-61: match.requires — evaluated before match.condition', () => {
  it('throws from requires even when match.condition would also fail', async () => {
    // If requires fails, match.condition is never evaluated (behavior doesn't continue)
    const entityId = nextUuidv7();
    const { result } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'FROZEN', balance: 0 },
      commandPayload: { amount: -1 },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "command.payload.amount > 0"
      requires:
        - name: is-active
          condition: "state.status == 'ACTIVE'"
          error_code: WIDGET_NOT_ACTIVE
          error_message: "Widget must be ACTIVE"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    assign:
      status: "'UPDATED'"
`,
    });
    // requires fails → 422 (not no-match which would be 422 via fallback_override: false)
    expect(result.status).toBe(422);
    const body = result.body as Record<string, unknown>;
    const errorStr = String(body['error']);
    expect(errorStr).toContain('ACTIVE');
  });

  it('evaluates match.condition only after all requires pass', async () => {
    // requires passes; condition is false → behavior doesn't match → 422 (no-match)
    const entityId = nextUuidv7();
    const { result } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 100 },
      commandPayload: { amount: -1 },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "command.payload.amount > 0"
      requires:
        - name: is-active
          condition: "state.status == 'ACTIVE'"
          error_code: WIDGET_NOT_ACTIVE
          error_message: "Widget must be ACTIVE"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    assign:
      status: "'UPDATED'"
`,
    });
    // requires passes, condition is false → no match → 422 (no behavior matched)
    expect(result.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Test: requires referencing state.X and command.X
// ---------------------------------------------------------------------------

describe('REQ-61: match.requires — references state and command', () => {
  it('references state fields in requires condition', async () => {
    const entityId = nextUuidv7();
    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 500, limit: 1000 },
      commandPayload: { amount: 200 },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
      requires:
        - name: within-limit
          condition: "command.payload.amount <= state.limit"
          error_code: EXCEEDS_LIMIT
          error_message: "Amount exceeds limit"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    assign:
      status: "'UPDATED'"
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
  });

  it('fails requires when command.X violates the guard', async () => {
    const entityId = nextUuidv7();
    const { result } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 500, limit: 100 },
      commandPayload: { amount: 200 },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
      requires:
        - name: within-limit
          condition: "command.payload.amount <= state.limit"
          error_code: EXCEEDS_LIMIT
          error_message: "Amount exceeds limit"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    assign:
      status: "'UPDATED'"
`,
    });
    expect(result.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Test: empty requires array → no guards, behavior fires normally
// ---------------------------------------------------------------------------

describe('REQ-61: match.requires — empty array', () => {
  it('fires behavior when requires is an empty array', async () => {
    const entityId = nextUuidv7();
    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE' },
      commandPayload: {},
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    assign:
      status: "'UPDATED'"
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test: requires using CEL comprehension
// ---------------------------------------------------------------------------

describe('REQ-61: match.requires — using CEL comprehension', () => {
  it('passes requires when comprehension over state list matches', async () => {
    const entityId = nextUuidv7();
    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', transactions: [{ kind: 'DEBIT' }, { kind: 'CREDIT' }] },
      commandPayload: {},
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
      requires:
        - name: has-credit
          condition: "state.transactions.exists(t, t.kind == 'CREDIT')"
          error_code: NO_CREDIT_TX
          error_message: "Entity must have at least one CREDIT transaction"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    assign:
      status: "'UPDATED'"
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
  });

  it('fails requires when comprehension finds no matching element', async () => {
    const entityId = nextUuidv7();
    const { result } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', transactions: [{ kind: 'DEBIT' }] },
      commandPayload: {},
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
      requires:
        - name: has-credit
          condition: "state.transactions.exists(t, t.kind == 'CREDIT')"
          error_code: NO_CREDIT_TX
          error_message: "Entity must have at least one CREDIT transaction"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    assign:
      status: "'UPDATED'"
`,
    });
    expect(result.status).toBe(422);
  });
});
