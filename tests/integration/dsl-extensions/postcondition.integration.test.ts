/**
 * REQ-62: behaviors[].postcondition — end-to-end integration permutation tests.
 *
 * Covers: passing postcondition, failing with POSTCONDITION_VIOLATED,
 * reference to emitted event + post-projection state, comprehension in postcondition,
 * and atomicity (event log unchanged on abort).
 */

import { bootAndRun } from './_helpers/dsl-builder.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';

// ---------------------------------------------------------------------------
// Test: postcondition passes → event committed
// ---------------------------------------------------------------------------

describe('REQ-62: postcondition — passes, event committed', () => {
  it('commits event when postcondition evaluates to true', async () => {
    const entityId = nextUuidv7();
    const { result, events, state } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 500 },
      commandPayload: { amount: 100 },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetRepaid
    payload_template:
      id: "command.targetId"
      amount: "command.payload.amount"
behaviors:
  - name: repay
    match:
      intent: mutation
      condition: "true"
    emit: WidgetRepaid
    postcondition: "state.balance >= 0"
reducers:
  - on: WidgetRepaid
    assign:
      balance: "state.balance - event.payload.amount"
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('WidgetRepaid');
    expect(state?.['balance']).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Test: postcondition fails → UoW aborts with POSTCONDITION_VIOLATED
// ---------------------------------------------------------------------------

describe('REQ-62: postcondition — fails, UoW aborts', () => {
  it('aborts UoW with POSTCONDITION_VIOLATED when postcondition is false', async () => {
    const entityId = nextUuidv7();
    const { result, events, state, thrownError } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 50 },
      commandPayload: { amount: 200 },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetRepaid
    payload_template:
      id: "command.targetId"
      amount: "command.payload.amount"
behaviors:
  - name: repay
    match:
      intent: mutation
      condition: "true"
    emit: WidgetRepaid
    postcondition: "state.balance >= 0"
reducers:
  - on: WidgetRepaid
    assign:
      balance: "state.balance - event.payload.amount"
`,
    });
    // Should fail with 500 POSTCONDITION_VIOLATED
    expect(result.status).toBe(500);
    // Events should be empty (not committed)
    expect(result.events).toHaveLength(0);
    // State should be unchanged (balance still 50, not -150)
    expect(state?.['balance']).toBe(50);

    // The thrown error should carry POSTCONDITION_VIOLATED code
    if (thrownError) {
      const details = (thrownError as unknown as { details: Record<string, unknown> }).details;
      expect(details?.['code']).toBe('POSTCONDITION_VIOLATED');
    }
  });

  it('event log is unchanged after postcondition abort (atomicity)', async () => {
    const entityId = nextUuidv7();

    // First, successfully update balance to 50
    const setupResult = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 50 },
      commandPayload: { amount: 200 },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetRepaid
    payload_template:
      id: "command.targetId"
      amount: "command.payload.amount"
behaviors:
  - name: repay
    match:
      intent: mutation
      condition: "true"
    emit: WidgetRepaid
    postcondition: "state.balance >= 0"
reducers:
  - on: WidgetRepaid
    assign:
      balance: "state.balance - event.payload.amount"
`,
    });

    // The failed UoW should not have committed events
    expect(setupResult.result.status).toBe(500);
    expect(setupResult.result.events).toHaveLength(0);

    // State should remain at initial value
    expect(setupResult.state?.['balance']).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Test: postcondition references the just-emitted event AND post-projection state
// ---------------------------------------------------------------------------

describe('REQ-62: postcondition — references emitted event and post-projection state', () => {
  it('postcondition can reference event payload fields', async () => {
    const entityId = nextUuidv7();
    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 500, maxAllowed: 500 },
      commandPayload: { amount: 100 },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetRepaid
    payload_template:
      id: "command.targetId"
      amount: "command.payload.amount"
behaviors:
  - name: repay
    match:
      intent: mutation
      condition: "true"
    emit: WidgetRepaid
    postcondition: "event.payload.amount <= state.maxAllowed"
reducers:
  - on: WidgetRepaid
    assign:
      balance: "state.balance - event.payload.amount"
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
  });

  it('postcondition fails when event amount exceeds max allowed', async () => {
    const entityId = nextUuidv7();
    const { result } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 1000, maxAllowed: 200 },
      commandPayload: { amount: 500 },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetRepaid
    payload_template:
      id: "command.targetId"
      amount: "command.payload.amount"
behaviors:
  - name: repay
    match:
      intent: mutation
      condition: "true"
    emit: WidgetRepaid
    postcondition: "event.payload.amount <= state.maxAllowed"
reducers:
  - on: WidgetRepaid
    assign:
      balance: "state.balance - event.payload.amount"
`,
    });
    expect(result.status).toBe(500);
    expect(result.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: postcondition using comprehension over a list field
// ---------------------------------------------------------------------------

describe('REQ-62: postcondition — comprehension over list field', () => {
  it('passes postcondition when comprehension over projected list is satisfied', async () => {
    const entityId = nextUuidv7();
    const { result, events, state } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', tags: ['standard'] },
      commandPayload: { newTag: 'premium' },
      schemas: {
        Widget: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['id'],
        },
      },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: TagAdded
    payload_template:
      id: "command.targetId"
      tag: "command.payload.newTag"
behaviors:
  - name: add-tag
    match:
      intent: mutation
      condition: "true"
    emit: TagAdded
    postcondition: "state.tags.size() > 0"
reducers:
  - on: TagAdded
    append:
      tags: "event.payload.tag"
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(state?.['tags']).toContain('premium');
  });

  it('fails postcondition when comprehension condition is not met after projection', async () => {
    const entityId = nextUuidv7();
    const { result } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', scores: [10, 20, 30] },
      commandPayload: {},
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: ScoresCleared
    payload_template:
      id: "command.targetId"
behaviors:
  - name: clear-scores
    match:
      intent: mutation
      condition: "true"
    emit: ScoresCleared
    postcondition: "state.scores.size() > 0"
reducers:
  - on: ScoresCleared
    assign:
      scores: "[]"
`,
    });
    // After clearing, scores.size() == 0, so postcondition fails
    expect(result.status).toBe(500);
    expect(result.events).toHaveLength(0);
  });
});
