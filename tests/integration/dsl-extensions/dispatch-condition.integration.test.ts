/**
 * REQ-63: dispatch_commands[].condition — end-to-end integration permutation tests.
 *
 * Covers: single dispatch fires/skips, multiple dispatches (partial), condition
 * references command.payload AND state, cascade depth, no condition (unconditional).
 *
 * NOTE: Secondary dispatches use `intent: creation` so no pre-seeding is needed.
 */

import { bootAndRun } from './_helpers/dsl-builder.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';

// ---------------------------------------------------------------------------
// Shared secondary DSL modules
// ---------------------------------------------------------------------------

const secondaryWidgetYaml = `
boundary: SecondaryWidget
contract_path: /secondary-widgets/{id}
fallback_override: false
event_catalog:
  - type: SecondaryCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: secondary-behavior
    match:
      intent: creation
      condition: "true"
    emit: SecondaryCreated
reducers:
  - on: SecondaryCreated
    patches:
      - { op: replace, path: /status, value: "\${'NOTIFIED'}" }
`;

const auditWidgetYaml = `
boundary: AuditWidget
contract_path: /audit-widgets/{id}
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
`;

const bureauWidgetYaml = `
boundary: BureauWidget
contract_path: /bureau-widgets/{id}
fallback_override: false
event_catalog:
  - type: BureauNotified
    payload_template:
      id: "command.targetId"
behaviors:
  - name: bureau-behavior
    match:
      intent: creation
      condition: "true"
    emit: BureauNotified
reducers:
  - on: BureauNotified
    patches:
      - { op: replace, path: /notified, value: "\${true}" }
`;

// ---------------------------------------------------------------------------
// Test: dispatch with condition=true → secondary fires
// ---------------------------------------------------------------------------

describe('REQ-63: dispatch_commands condition — condition true, secondary fires', () => {
  it('secondary command fires when dispatch condition evaluates to true', async () => {
    const entityId = nextUuidv7();
    const secondaryId = nextUuidv7();

    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 100 },
      commandPayload: { amount: 100, secondaryId },
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
    dispatch_commands:
      - boundary: SecondaryWidget
        intent: creation
        target_id: "command.payload.secondaryId"
        condition: "command.payload.amount > 50"
        payload: {}
reducers:
  - on: WidgetUpdated
    patches:
      - { op: replace, path: /status, value: "\${'UPDATED'}" }
`,
      extraDslModules: [
        { name: 'secondary', yaml: secondaryWidgetYaml },
      ],
    });

    // Primary event should fire and secondary should also fire (amount 100 > 50)
    expect(result.status).toBe(200);
    const types = events.map(e => e.type);
    expect(types).toContain('WidgetUpdated');
    expect(types).toContain('SecondaryCreated');
  });
});

// ---------------------------------------------------------------------------
// Test: dispatch with condition=false → secondary silently skipped
// ---------------------------------------------------------------------------

describe('REQ-63: dispatch_commands condition — condition false, secondary skipped', () => {
  it('primary commits but secondary is skipped when dispatch condition is false', async () => {
    const entityId = nextUuidv7();
    const secondaryId = nextUuidv7();

    const { result, events, state } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 10 },
      commandPayload: { amount: 5, secondaryId },
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
    dispatch_commands:
      - boundary: SecondaryWidget
        intent: creation
        target_id: "command.payload.secondaryId"
        condition: "command.payload.amount > 50"
        payload: {}
reducers:
  - on: WidgetUpdated
    patches:
      - { op: replace, path: /status, value: "\${'UPDATED'}" }
`,
      extraDslModules: [
        { name: 'secondary', yaml: secondaryWidgetYaml },
      ],
    });

    // Primary should succeed; secondary skipped (amount 5 is not > 50)
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('WidgetUpdated');
    expect(state?.['status']).toBe('UPDATED');
  });
});

// ---------------------------------------------------------------------------
// Test: multiple dispatch_commands — some fire, others don't
// ---------------------------------------------------------------------------

describe('REQ-63: dispatch_commands — multiple dispatches, partial firing', () => {
  it('fires unconditional dispatch but not conditional when condition is false', async () => {
    const entityId = nextUuidv7();
    const auditId = nextUuidv7();
    const bureauId = nextUuidv7();

    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 100 },
      commandPayload: { amount: 10, auditId, bureauId },
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
    dispatch_commands:
      - boundary: AuditWidget
        intent: creation
        target_id: "command.payload.auditId"
        payload: {}
      - boundary: BureauWidget
        intent: creation
        target_id: "command.payload.bureauId"
        condition: "command.payload.amount > 50"
        payload: {}
reducers:
  - on: WidgetUpdated
    patches:
      - { op: replace, path: /status, value: "\${'UPDATED'}" }
`,
      extraDslModules: [
        { name: 'audit', yaml: auditWidgetYaml },
        { name: 'bureau', yaml: bureauWidgetYaml },
      ],
    });

    expect(result.status).toBe(200);
    // Primary + Audit should fire; Bureau (condition amount > 50, amount=10) should not
    const types = events.map(e => e.type);
    expect(types).toContain('WidgetUpdated');
    expect(types).toContain('AuditCreated');
    expect(types).not.toContain('BureauNotified');
  });
});

// ---------------------------------------------------------------------------
// Test: condition references state
// ---------------------------------------------------------------------------

describe('REQ-63: dispatch_commands — condition references state', () => {
  it('fires secondary when state.balance > 0 and condition checks it', async () => {
    // NOTE: dispatch_commands[].condition is evaluated against POST-projection state.
    // The reducer assigns status: 'UPDATED', so we check a field NOT modified by the reducer.
    const entityId = nextUuidv7();
    const secondaryId = nextUuidv7();

    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 100 },
      commandPayload: { secondaryId },
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
    dispatch_commands:
      - boundary: SecondaryWidget
        intent: creation
        target_id: "command.payload.secondaryId"
        condition: "state.balance > 0"
        payload: {}
reducers:
  - on: WidgetUpdated
    patches:
      - { op: replace, path: /status, value: "\${'UPDATED'}" }
`,
      extraDslModules: [
        { name: 'secondary', yaml: secondaryWidgetYaml },
      ],
    });

    expect(result.status).toBe(200);
    const types = events.map(e => e.type);
    expect(types).toContain('WidgetUpdated');
    expect(types).toContain('SecondaryCreated');
  });

  it('skips secondary when state.balance is 0 (condition requires balance > 0)', async () => {
    // dispatch condition is post-projection; balance is 0 so condition fails
    const entityId = nextUuidv7();
    const secondaryId = nextUuidv7();

    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'FROZEN', balance: 0 },
      commandPayload: { secondaryId },
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
    dispatch_commands:
      - boundary: SecondaryWidget
        intent: creation
        target_id: "command.payload.secondaryId"
        condition: "state.balance > 0"
        payload: {}
reducers:
  - on: WidgetUpdated
    patches:
      - { op: replace, path: /status, value: "\${'UPDATED'}" }
`,
      extraDslModules: [
        { name: 'secondary', yaml: secondaryWidgetYaml },
      ],
    });

    expect(result.status).toBe(200);
    const types = events.map(e => e.type);
    expect(types).toContain('WidgetUpdated');
    expect(types).not.toContain('SecondaryCreated');
  });
});

// ---------------------------------------------------------------------------
// Test: unconditional dispatch (no condition field)
// ---------------------------------------------------------------------------

describe('REQ-63: dispatch_commands — unconditional dispatch', () => {
  it('always fires secondary when no condition is specified', async () => {
    const entityId = nextUuidv7();
    const secondaryId = nextUuidv7();

    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE' },
      commandPayload: { secondaryId },
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
    dispatch_commands:
      - boundary: SecondaryWidget
        intent: creation
        target_id: "command.payload.secondaryId"
        payload: {}
reducers:
  - on: WidgetUpdated
    patches:
      - { op: replace, path: /status, value: "\${'UPDATED'}" }
`,
      extraDslModules: [
        { name: 'secondary', yaml: secondaryWidgetYaml },
      ],
    });

    expect(result.status).toBe(200);
    const types = events.map(e => e.type);
    expect(types).toContain('WidgetUpdated');
    expect(types).toContain('SecondaryCreated');
  });
});
