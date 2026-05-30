/**
 * Cross-feature permutation tests — combining multiple Tier 1 DSL features
 * in the same boundary, behavior, or UoW execution.
 *
 * Tests:
 *  - match.requires using ts: reference
 *  - postcondition using CEL comprehension
 *  - dispatch_commands[].condition using inline TS
 *  - emit_when whose `when` is inline TS
 *  - A behavior with ALL Tier 1 features in one block
 *  - Boundary using both inline TS AND CEL in same UoW
 */

import { bootAndRun } from './_helpers/dsl-builder.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';

// ---------------------------------------------------------------------------
// Test A: match.requires using ts: reference
// ---------------------------------------------------------------------------

describe('Cross-feature: match.requires using ts: reference', () => {
  it('fires behavior when ts: requires condition returns true', async () => {
    const entityId = nextUuidv7();
    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 300, tier: 'GOLD' },
      commandPayload: { amount: 100 },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
scripts:
  - name: checkEligible
    code: |
      export default function(ctx) {
        return ctx.state.tier === 'GOLD' && ctx.state.balance >= ctx.command.payload.amount;
      }
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: update
    match:
      intent: mutation
      condition: "true"
      requires:
        - name: eligibility-check
          condition: "ts:checkEligible"
          error_code: NOT_ELIGIBLE
          error_message: "Eligibility check failed"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    patches:
      - { op: replace, path: /status, value: "\${'UPDATED'}" }
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
  });

  it('returns 422 when ts: requires condition returns false', async () => {
    const entityId = nextUuidv7();
    const { result } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 50, tier: 'STANDARD' },
      commandPayload: { amount: 100 },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
scripts:
  - name: checkEligible
    code: |
      export default function(ctx) {
        return ctx.state.tier === 'GOLD' && ctx.state.balance >= ctx.command.payload.amount;
      }
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: update
    match:
      intent: mutation
      condition: "true"
      requires:
        - name: eligibility-check
          condition: "ts:checkEligible"
          error_code: NOT_ELIGIBLE
          error_message: "Eligibility check failed"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    patches:
      - { op: replace, path: /status, value: "\${'UPDATED'}" }
`,
    });
    expect(result.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Test B: postcondition using CEL comprehension
// ---------------------------------------------------------------------------

describe('Cross-feature: postcondition using CEL comprehension', () => {
  // NOTE: append operations require the target field to be declared as an array in the schema.
  const txSchema = {
    Widget: {
      type: 'object',
      additionalProperties: true,
      properties: {
        id: { type: 'string' },
        transactions: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['id'],
    },
  };

  it('passes postcondition comprehension verifying all amounts are positive', async () => {
    const entityId = nextUuidv7();
    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', transactions: [] },
      commandPayload: { amount: 50 },
      schemas: txSchema,
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: TxAdded
    payload_template:
      id: "command.targetId"
      amount: "command.payload.amount"
behaviors:
  - name: add-tx
    match:
      intent: mutation
      condition: "true"
    emit: TxAdded
    postcondition: "state.transactions.all(t, t.amount > 0)"
reducers:
  - on: TxAdded
    patches:
      - { op: append, path: /transactions, value: "\${{'amount': event.payload.amount}}" }
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
  });

  it('fails postcondition comprehension when a transaction has a non-positive amount', async () => {
    const entityId = nextUuidv7();
    const { result } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', transactions: [] },
      commandPayload: { amount: -10 },
      schemas: txSchema,
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: TxAdded
    payload_template:
      id: "command.targetId"
      amount: "command.payload.amount"
behaviors:
  - name: add-tx
    match:
      intent: mutation
      condition: "true"
    emit: TxAdded
    postcondition: "state.transactions.all(t, t.amount > 0)"
reducers:
  - on: TxAdded
    patches:
      - { op: append, path: /transactions, value: "\${{'amount': event.payload.amount}}" }
`,
    });
    // amount is -10, postcondition fails
    expect(result.status).toBe(500);
    expect(result.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test C: dispatch_commands[].condition using inline TS
// ---------------------------------------------------------------------------

describe('Cross-feature: dispatch_commands condition using inline TS', () => {
  it('fires secondary when ts: condition returns true', async () => {
    const entityId = nextUuidv7();
    const secondaryId = nextUuidv7();

    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', riskScore: 85 },
      commandPayload: { amount: 5000, secondaryId },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
scripts:
  - name: isHighRisk
    code: |
      export default function(ctx) {
        return ctx.state.riskScore > 80;
      }
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: update
    match:
      intent: mutation
      condition: "true"
    emit: WidgetUpdated
    dispatch_commands:
      - boundary: ReviewWidget
        intent: creation
        target_id: "command.payload.secondaryId"
        condition: "ts:isHighRisk"
        payload: {}
reducers:
  - on: WidgetUpdated
    patches:
      - { op: replace, path: /status, value: "\${'UPDATED'}" }
`,
      extraDslModules: [
        {
          name: 'review',
          yaml: `
boundary: ReviewWidget
contract_path: /review-widgets/{id}
fallback_override: false
event_catalog:
  - type: ReviewCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: review-behavior
    match:
      intent: creation
      condition: "true"
    emit: ReviewCreated
reducers:
  - on: ReviewCreated
    patches:
      - { op: replace, path: /reviewed, value: "\${true}" }
`,
        },
      ],
    });

    expect(result.status).toBe(200);
    const types = events.map(e => e.type);
    expect(types).toContain('WidgetUpdated');
    expect(types).toContain('ReviewCreated');
  });

  it('skips secondary when ts: condition returns false', async () => {
    const entityId = nextUuidv7();
    const secondaryId = nextUuidv7();

    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', riskScore: 30 },
      commandPayload: { amount: 100, secondaryId },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
scripts:
  - name: isHighRisk
    code: |
      export default function(ctx) {
        return ctx.state.riskScore > 80;
      }
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: update
    match:
      intent: mutation
      condition: "true"
    emit: WidgetUpdated
    dispatch_commands:
      - boundary: ReviewWidget
        intent: creation
        target_id: "command.payload.secondaryId"
        condition: "ts:isHighRisk"
        payload: {}
reducers:
  - on: WidgetUpdated
    patches:
      - { op: replace, path: /status, value: "\${'UPDATED'}" }
`,
      extraDslModules: [
        {
          name: 'review',
          yaml: `
boundary: ReviewWidget
contract_path: /review-widgets/{id}
fallback_override: false
event_catalog:
  - type: ReviewCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: review-behavior
    match:
      intent: creation
      condition: "true"
    emit: ReviewCreated
reducers:
  - on: ReviewCreated
    patches:
      - { op: replace, path: /reviewed, value: "\${true}" }
`,
        },
      ],
    });

    expect(result.status).toBe(200);
    const types = events.map(e => e.type);
    expect(types).toContain('WidgetUpdated');
    expect(types).not.toContain('ReviewCreated');
  });
});

// ---------------------------------------------------------------------------
// Test D: emit_when whose `when` uses inline TS
// ---------------------------------------------------------------------------

describe('Cross-feature: emit_when with ts: when condition', () => {
  it('emits event when ts: when condition returns true', async () => {
    const entityId = nextUuidv7();
    const { result, events, state } = await bootAndRun({
      boundaryName: 'Loan',
      contractPath: '/loans/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 100, overdraftAllowed: false },
      commandPayload: { amount: 100 },
      boundaryYaml: `
boundary: Loan
contract_path: /loans/{id}
fallback_override: false
scripts:
  - name: isFullSettlement
    code: |
      export default function(ctx) {
        return ctx.command.payload.amount >= ctx.state.balance;
      }
event_catalog:
  - type: LoanRepaid
    payload_template:
      id: "command.targetId"
      amount: "command.payload.amount"
  - type: LoanSettled
    payload_template:
      id: "command.targetId"
behaviors:
  - name: repay
    match:
      intent: mutation
      condition: "true"
    emit_when:
      - when: "ts:isFullSettlement"
        emit: LoanSettled
      - when: "command.payload.amount < state.balance"
        emit: LoanRepaid
reducers:
  - on: LoanRepaid
    patches:
      - { op: replace, path: /balance, value: "\${state.balance - event.payload.amount}" }
  - on: LoanSettled
    patches:
      - { op: replace, path: /status, value: "\${'SETTLED'}" }
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('LoanSettled');
    expect(state?.['status']).toBe('SETTLED');
  });
});

// ---------------------------------------------------------------------------
// Test E: behavior with ALL Tier 1 features in one block
// ---------------------------------------------------------------------------

describe('Cross-feature: ALL Tier 1 features in one behavior', () => {
  it('executes requires → condition → emit_when → postcondition → dispatch all in order', async () => {
    const entityId = nextUuidv7();
    const secondaryId = nextUuidv7();

    const { result, events, state } = await bootAndRun({
      boundaryName: 'Loan',
      contractPath: '/loans/{id}',
      entity: {
        id: entityId,
        status: 'ACTIVE',
        balance: 500,
        principal: 1000,
        transactions: [],
        riskScore: 30,
      },
      commandPayload: { amount: 200, secondaryId, notify: true },
      boundaryYaml: `
boundary: Loan
contract_path: /loans/{id}
fallback_override: false
scripts:
  - name: checkActive
    code: |
      export default function(ctx) {
        return ctx.state.status === 'ACTIVE';
      }
event_catalog:
  - type: LoanRepaid
    payload_template:
      id: "command.targetId"
      amount: "command.payload.amount"
  - type: NotificationQueued
    payload_template:
      id: "command.targetId"
behaviors:
  - name: repay
    match:
      intent: mutation
      condition: "state.balance > 0"
      requires:
        - name: is-active
          condition: "ts:checkActive"
          error_code: NOT_ACTIVE
          error_message: "Loan must be ACTIVE"
    emit_when:
      - when: "command.payload.notify == true"
        emit: NotificationQueued
      - when: "command.payload.amount > 0"
        emit: LoanRepaid
    postcondition: "state.balance >= 0"
    dispatch_commands:
      - boundary: AuditLoan
        intent: creation
        target_id: "command.payload.secondaryId"
        condition: "state.riskScore < 50"
        payload: {}
reducers:
  - on: LoanRepaid
    patches:
      - { op: replace, path: /balance, value: "\${state.balance - event.payload.amount}" }
  - on: NotificationQueued
    patches:
      - { op: replace, path: /notified, value: "\${true}" }
`,
      extraDslModules: [
        {
          name: 'audit',
          yaml: `
boundary: AuditLoan
contract_path: /audit-loans/{id}
fallback_override: false
event_catalog:
  - type: AuditCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: audit-behavior
    match:
      intent: creation
      condition: "true"
    emit: AuditCreated
reducers:
  - on: AuditCreated
    patches:
      - { op: replace, path: /logged, value: "\${true}" }
`,
        },
      ],
    });

    expect(result.status).toBe(200);
    // Requires passes (checkActive → true), condition passes (balance > 0)
    // emit_when: notify=true → NotificationQueued, amount>0 → LoanRepaid
    // postcondition: balance (500-200=300) >= 0 → passes
    // dispatch: riskScore (30) < 50 → AuditCreated fires
    const types = events.map(e => e.type);
    expect(types).toContain('NotificationQueued');
    expect(types).toContain('LoanRepaid');
    expect(types).toContain('AuditCreated');

    // State: balance updated, notified set
    expect(state?.['balance']).toBe(300);
    expect(state?.['notified']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test F: Both inline TS and CEL interleaved in same UoW
// ---------------------------------------------------------------------------

describe('Cross-feature: inline TS and CEL interleaved in same UoW', () => {
  it('CEL condition and ts: payload field both work in the same behavior', async () => {
    const entityId = nextUuidv7();
    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 200, tier: 'SILVER' },
      commandPayload: { amount: 50 },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
scripts:
  - name: computeLabel
    code: |
      export default function(ctx) {
        return ctx.state.tier + "-" + ctx.command.payload.amount;
      }
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
      label: "ts:computeLabel"
      remaining: "state.balance - command.payload.amount"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "state.balance > command.payload.amount"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    patches:
      - { op: replace, path: /label, value: "\${event.payload.label}" }
      - { op: replace, path: /balance, value: "\${state.balance - event.payload.remaining}" }
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.['label']).toBe('SILVER-50');
    expect(events[0]?.payload?.['remaining']).toBe(150);
  });
});
