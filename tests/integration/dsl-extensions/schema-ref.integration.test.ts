/**
 * REQ-65: event_catalog[].schema_ref — end-to-end integration permutation tests.
 *
 * Covers: passing schema validation, failing schema validation,
 * nested/allOf schema, missing schema_ref component → BootError,
 * absent schema_ref → no validation.
 */

import { bootAndRun, expectBootError } from './_helpers/dsl-builder.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';
import { BootError } from '../../../src/errors.js';

// ---------------------------------------------------------------------------
// Test: payload matches schema → projected normally
// ---------------------------------------------------------------------------

describe('REQ-65: schema_ref — payload matches schema', () => {
  it('projects event normally when payload satisfies schema_ref', async () => {
    const entityId = nextUuidv7();
    const { result, events, state } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', amount: 0 },
      commandPayload: { amount: 100 },
      schemas: {
        WidgetPaidEvent: {
          type: 'object',
          required: ['amount'],
          properties: {
            id: { type: 'string' },
            amount: { type: 'number' },
          },
        },
      },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetPaid
    schema_ref: "#/components/schemas/WidgetPaidEvent"
    payload_template:
      id: "command.targetId"
      amount: "command.payload.amount"
behaviors:
  - name: pay
    match:
      intent: mutation
      condition: "true"
    emit: WidgetPaid
reducers:
  - on: WidgetPaid
    assign:
      amount: "event.payload.amount"
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(state?.['amount']).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Test: payload violates schema → InternalExecutionError(SCHEMA_TYPE_MISMATCH)
// ---------------------------------------------------------------------------

describe('REQ-65: schema_ref — payload violates schema', () => {
  it('aborts UoW when event payload fails schema validation', async () => {
    const entityId = nextUuidv7();
    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', amount: 0 },
      // payload template produces a string for 'amount' field, but schema requires number
      commandPayload: {},
      schemas: {
        WidgetPaidEvent: {
          type: 'object',
          required: ['amount'],
          properties: {
            id: { type: 'string' },
            amount: { type: 'number' },
          },
        },
      },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetPaid
    schema_ref: "#/components/schemas/WidgetPaidEvent"
    payload_template:
      id: "command.targetId"
      amount: "'not-a-number'"
behaviors:
  - name: pay
    match:
      intent: mutation
      condition: "true"
    emit: WidgetPaid
reducers:
  - on: WidgetPaid
    assign:
      amount: "event.payload.amount"
`,
    });
    // Should fail validation
    expect(result.status).toBe(500);
    expect(result.events).toHaveLength(0);
    const body = result.body as Record<string, unknown>;
    // Check for schema violation code
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).toMatch(/SCHEMA|VIOLAT|schema/i);
  });

  it('aborts UoW when required field is missing from event payload', async () => {
    const entityId = nextUuidv7();
    const { result } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE' },
      commandPayload: {},
      schemas: {
        WidgetPaidEvent: {
          type: 'object',
          required: ['amount'],
          properties: {
            id: { type: 'string' },
            amount: { type: 'number' },
          },
        },
      },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetPaid
    schema_ref: "#/components/schemas/WidgetPaidEvent"
    payload_template:
      id: "command.targetId"
behaviors:
  - name: pay
    match:
      intent: mutation
      condition: "true"
    emit: WidgetPaid
reducers:
  - on: WidgetPaid
    assign:
      status: "'PAID'"
`,
    });
    expect(result.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Test: schema_ref pointing at a missing component → BootError
// ---------------------------------------------------------------------------

describe('REQ-65: schema_ref — missing component → BootError at boot', () => {
  it('halts boot with BootError when schema_ref references a non-existent schema', async () => {
    const bootError = await expectBootError({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetPaid
    schema_ref: "#/components/schemas/NonExistentSchema"
    payload_template:
      id: "command.targetId"
behaviors:
  - name: pay
    match:
      intent: mutation
      condition: "true"
    emit: WidgetPaid
reducers:
  - on: WidgetPaid
    assign:
      status: "'PAID'"
`,
    });
    expect(bootError).toBeInstanceOf(BootError);
    expect(bootError.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(bootError.message).toContain('NonExistentSchema');
  });
});

// ---------------------------------------------------------------------------
// Test: schema_ref absent → no payload validation performed
// ---------------------------------------------------------------------------

describe('REQ-65: schema_ref — absent, no validation', () => {
  it('projects event without validation when schema_ref is not specified', async () => {
    const entityId = nextUuidv7();
    const { result, events, state } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE' },
      // Deliberately using payload with unusual types — should pass without schema_ref
      commandPayload: { weirdValue: 'any-string-or-number' },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
      weirdValue: "command.payload.weirdValue"
behaviors:
  - name: update
    match:
      intent: mutation
      condition: "true"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    assign:
      weirdValue: "event.payload.weirdValue"
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(state?.['weirdValue']).toBe('any-string-or-number');
  });
});

// ---------------------------------------------------------------------------
// Test: schema_ref pointing at a nested schema (allOf merge)
// ---------------------------------------------------------------------------

describe('REQ-65: schema_ref — allOf merged schema', () => {
  it('validates event payload against an allOf-merged schema', async () => {
    const entityId = nextUuidv7();
    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE' },
      commandPayload: { amount: 50, currency: 'AUD' },
      schemas: {
        BasePayment: {
          type: 'object',
          required: ['amount'],
          properties: { amount: { type: 'number' } },
        },
        CurrencyPayment: {
          allOf: [
            { '$ref': '#/components/schemas/BasePayment' },
            {
              type: 'object',
              required: ['currency'],
              properties: { currency: { type: 'string' } },
            },
          ],
        },
      },
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: PaymentMade
    schema_ref: "#/components/schemas/CurrencyPayment"
    payload_template:
      id: "command.targetId"
      amount: "command.payload.amount"
      currency: "command.payload.currency"
behaviors:
  - name: pay
    match:
      intent: mutation
      condition: "true"
    emit: PaymentMade
reducers:
  - on: PaymentMade
    assign:
      lastPaymentAmount: "event.payload.amount"
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
  });
});
