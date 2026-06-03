/**
 * Script behaviour — end-to-end integration permutation tests (B3 migration).
 *
 * Previously these tests used inline `scripts: [{ name, code }]` YAML. The
 * inline form is removed (B3). All behavioural coverage is now exercised via
 * scanned @Script classes in tests/fixtures/inline-ts-migration/scripts/, and
 * ts:<id> references in boundary YAML resolve against the scanned registry.
 *
 * Tests that exercised sandbox isolation (throws, timeout, fs/process blocked)
 * are covered by unit tests for sandbox/transpile. Those cases are replaced
 * here with removed-syntax assertions — verifying that a boundary YAML
 * containing `scripts:` or `code:` halts boot with BOOT_ERR_REMOVED_SYNTAX.
 *
 * Covered:
 *   A  ts: boolean in match.condition (scanned @Script)
 *   B  ts: string in payload_template (scanned @Script)
 *   C  ctx.helpers.uuid and ctx.helpers.now (scanned @Script)
 *   D  inline scripts: throws → removed-syntax assertion
 *   E  inline scripts: timeout → removed-syntax assertion
 *   F  inline scripts: fs/process blocked → removed-syntax assertion
 *   G  inline scripts: syntax error → removed-syntax assertion
 *   H  ts: reference to non-existent scanned @Script → BOOT_ERR_DSL_REFERENCE
 *   I  ts: in reducer patch value → BOOT_ERR_SCRIPT_IN_REDUCER
 *   J  ts: in postcondition (scanned @Script)
 *   K  concurrent script invocations — isolation (scanned @Script)
 *   L  module scope / helper function (scanned @Script)
 */

import * as path from 'node:path';
import { bootAndRun, expectBootError } from './_helpers/dsl-builder.js';
import { BootError } from '../../../src/errors.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';

const SCRIPT_FIXTURE_DIR = path.join(__dirname, '..', '..', 'fixtures', 'inline-ts-migration');

// ---------------------------------------------------------------------------
// Test A: scanned @Script returning boolean used in behaviors[].match.condition
// ---------------------------------------------------------------------------

describe('ts: script in match.condition (scanned @Script)', () => {
  it('behavior fires when condition script returns true', async () => {
    const entityId = nextUuidv7();
    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 200 },
      commandPayload: {},
      typescriptScanDir: SCRIPT_FIXTURE_DIR,
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
      condition: "ts:checkRiskBand"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    patches:
      - op: replace
        path: /status
        value: "\${'UPDATED'}"
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
  });

  it('behavior does not fire when condition script returns false', async () => {
    const entityId = nextUuidv7();
    const { result } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 50 },
      commandPayload: {},
      typescriptScanDir: SCRIPT_FIXTURE_DIR,
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
      condition: "ts:checkRiskBand"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    patches:
      - op: replace
        path: /status
        value: "\${'UPDATED'}"
`,
    });
    // Script returns false (balance <= 100) → behavior doesn't match → 422
    expect(result.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Test B: scanned @Script returning a string used in payload_template
// ---------------------------------------------------------------------------

describe('ts: script in payload_template (scanned @Script)', () => {
  it('event payload field is set by script return value', async () => {
    const entityId = nextUuidv7();
    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', tier: 'GOLD' },
      commandPayload: {},
      typescriptScanDir: SCRIPT_FIXTURE_DIR,
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
      computed: "ts:buildPayload"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    patches:
      - op: replace
        path: /computed
        value: "\${event.payload.computed}"
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.['computed']).toBe('tier:GOLD');
  });
});

// ---------------------------------------------------------------------------
// Test C: scanned @Script using ctx.helpers.uuid and ctx.helpers.now
// ---------------------------------------------------------------------------

describe('ctx.helpers — uuid and now (scanned @Script)', () => {
  it('script can call ctx.helpers.uuid and return a UUID string', async () => {
    const entityId = nextUuidv7();
    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE' },
      commandPayload: {},
      typescriptScanDir: SCRIPT_FIXTURE_DIR,
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
      generatedId: "ts:makeId"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    patches:
      - op: replace
        path: /generatedId
        value: "\${event.payload.generatedId}"
`,
    });
    expect(result.status).toBe(200);
    const generatedId = events[0]?.payload?.['generatedId'] as string;
    expect(typeof generatedId).toBe('string');
    expect(generatedId.length).toBeGreaterThan(10);
  });

  it('script can call ctx.helpers.now and return an ISO string', async () => {
    const entityId = nextUuidv7();
    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE' },
      commandPayload: {},
      typescriptScanDir: SCRIPT_FIXTURE_DIR,
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
      ts: "ts:getTimestamp"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    patches:
      - op: replace
        path: /lastTs
        value: "\${event.payload.ts}"
`,
    });
    expect(result.status).toBe(200);
    const ts = events[0]?.payload?.['ts'] as string;
    expect(typeof ts).toBe('string');
    expect(() => new Date(ts)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests D, E, F, G: inline scripts: form is removed — BOOT_ERR_REMOVED_SYNTAX
//
// Sandbox behavior (throws, timeout, fs/process blocking) is tested in
// tests/unit/scripts/sandbox.test.ts — retained unchanged.
// ---------------------------------------------------------------------------

describe('inline scripts: is removed — BOOT_ERR_REMOVED_SYNTAX (B3)', () => {
  it('halts boot with BOOT_ERR_REMOVED_SYNTAX when scripts: block is present (D: throws case)', async () => {
    const bootError = await expectBootError({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
scripts:
  - name: faultyScript
    code: |
      export default function(ctx) {
        throw new Error("intentional script error");
      }
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
      errField: "ts:faultyScript"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    patches:
      - op: replace
        path: /status
        value: "\${'UPDATED'}"
`,
    });
    expect(bootError).toBeInstanceOf(BootError);
    expect(bootError.code).toBe('BOOT_ERR_REMOVED_SYNTAX');
    expect(bootError.message).toContain('@Script');
  });

  it('halts boot with BOOT_ERR_REMOVED_SYNTAX when scripts: block is present (E: timeout case)', async () => {
    const bootError = await expectBootError({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
scripts:
  - name: infiniteLoop
    code: |
      export default function(ctx) {
        while(true) {}
      }
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
      spin: "ts:infiniteLoop"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    patches:
      - op: replace
        path: /status
        value: "\${'UPDATED'}"
`,
    });
    expect(bootError).toBeInstanceOf(BootError);
    expect(bootError.code).toBe('BOOT_ERR_REMOVED_SYNTAX');
    expect(bootError.message).toContain('ts:<id>');
  });

  it('halts boot with BOOT_ERR_REMOVED_SYNTAX when scripts: block is present (F: sandbox case)', async () => {
    const bootError = await expectBootError({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
scripts:
  - name: tryFs
    code: |
      export default function(ctx) {
        try {
          const fs = require('fs');
          return true;
        } catch(e) {
          return false;
        }
      }
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "ts:tryFs"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    patches:
      - op: replace
        path: /status
        value: "\${'UPDATED'}"
`,
    });
    expect(bootError).toBeInstanceOf(BootError);
    expect(bootError.code).toBe('BOOT_ERR_REMOVED_SYNTAX');
  });

  it('halts boot with BOOT_ERR_REMOVED_SYNTAX when scripts: block is present (G: syntax-error case)', async () => {
    const bootError = await expectBootError({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
scripts:
  - name: badScript
    code: |
      export default function(ctx) {
        return @@@INVALID_SYNTAX@@@;
      }
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "ts:badScript"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    patches:
      - op: replace
        path: /status
        value: "\${'UPDATED'}"
`,
    });
    expect(bootError).toBeInstanceOf(BootError);
    expect(bootError.code).toBe('BOOT_ERR_REMOVED_SYNTAX');
  });
});

// ---------------------------------------------------------------------------
// Test H: ts: reference to non-existent scanned @Script → boot error
// ---------------------------------------------------------------------------

describe('ts: reference to missing script → boot error', () => {
  it('halts boot with BOOT_ERR_DSL_REFERENCE when ts: reference resolves to no scanned @Script', async () => {
    const bootError = await expectBootError({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
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
      condition: "ts:nonExistentScript"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    patches:
      - op: replace
        path: /status
        value: "\${'UPDATED'}"
`,
    });
    expect(bootError).toBeInstanceOf(BootError);
    expect(bootError.code).toBe('BOOT_ERR_DSL_REFERENCE');
    expect(bootError.message).toContain('nonExistentScript');
  });
});

// ---------------------------------------------------------------------------
// Test I: ts: in reducer patch value → BOOT_ERR_SCRIPT_IN_REDUCER
// ---------------------------------------------------------------------------

describe('ts: script in a reducer patch value → boot error', () => {
  it('halts boot with BOOT_ERR_SCRIPT_IN_REDUCER when a reducer patch value uses a ts: sentinel', async () => {
    const bootError = await expectBootError({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      typescriptScanDir: SCRIPT_FIXTURE_DIR,
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
    patches:
      - op: replace
        path: /status
        value: "ts:checkRiskBand"
`,
    });
    expect(bootError).toBeInstanceOf(BootError);
    expect(bootError.code).toBe('BOOT_ERR_SCRIPT_IN_REDUCER');
  });
});

// ---------------------------------------------------------------------------
// Test J: scanned @Script in postcondition
// ---------------------------------------------------------------------------

describe('ts: script in postcondition (scanned @Script)', () => {
  it('postcondition script runs after projection and aborts when it returns false', async () => {
    const entityId = nextUuidv7();
    const { result } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 50 },
      commandPayload: { amount: 200 },
      typescriptScanDir: SCRIPT_FIXTURE_DIR,
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
    postcondition: "ts:checkBalance"
reducers:
  - on: WidgetRepaid
    patches:
      - op: replace
        path: /balance
        value: "\${state.balance - event.payload.amount}"
`,
    });
    // balance goes to -150, postcondition script returns false → abort
    expect(result.status).toBe(500);
    expect(result.events).toHaveLength(0);
  });

  it('postcondition script passes and event is committed when it returns true', async () => {
    const entityId = nextUuidv7();
    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', balance: 500 },
      commandPayload: { amount: 100 },
      typescriptScanDir: SCRIPT_FIXTURE_DIR,
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
    postcondition: "ts:checkBalance"
reducers:
  - on: WidgetRepaid
    patches:
      - op: replace
        path: /balance
        value: "\${state.balance - event.payload.amount}"
`,
    });
    expect(result.status).toBe(200);
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test K: concurrent script invocations — no shared mutable state
// ---------------------------------------------------------------------------

describe('concurrent script invocations — isolation (scanned @Script)', () => {
  it('two concurrent commands do not share mutable state in scripts', async () => {
    const entityId1 = nextUuidv7();
    const entityId2 = nextUuidv7();

    const boundaryYaml = `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
      capturedBalance: "ts:getBalance"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    patches:
      - op: replace
        path: /capturedBalance
        value: "\${event.payload.capturedBalance}"
`;

    const [r1, r2] = await Promise.all([
      bootAndRun({
        boundaryName: 'Widget',
        contractPath: '/widgets/{id}',
        entity: { id: entityId1, status: 'ACTIVE', balance: 100 },
        commandPayload: {},
        typescriptScanDir: SCRIPT_FIXTURE_DIR,
        boundaryYaml,
      }),
      bootAndRun({
        boundaryName: 'Widget',
        contractPath: '/widgets/{id}',
        entity: { id: entityId2, status: 'ACTIVE', balance: 999 },
        commandPayload: {},
        typescriptScanDir: SCRIPT_FIXTURE_DIR,
        boundaryYaml,
      }),
    ]);

    expect(r1.result.status).toBe(200);
    expect(r2.result.status).toBe(200);
    expect(r1.events[0]?.payload?.['capturedBalance']).toBe(100);
    expect(r2.events[0]?.payload?.['capturedBalance']).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// Test L: scanned @Script using a module-level helper function
// ---------------------------------------------------------------------------

describe('script module scope — closures (scanned @Script)', () => {
  it('script can use a module-level helper function defined in its class file', async () => {
    const entityId = nextUuidv7();
    const { result, events } = await bootAndRun({
      boundaryName: 'Widget',
      contractPath: '/widgets/{id}',
      entity: { id: entityId, status: 'ACTIVE', score: 7 },
      commandPayload: {},
      typescriptScanDir: SCRIPT_FIXTURE_DIR,
      boundaryYaml: `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
event_catalog:
  - type: WidgetUpdated
    payload_template:
      id: "command.targetId"
      band: "ts:categorize"
behaviors:
  - name: test-behavior
    match:
      intent: mutation
      condition: "true"
    emit: WidgetUpdated
reducers:
  - on: WidgetUpdated
    patches:
      - op: replace
        path: /band
        value: "\${event.payload.band}"
`,
    });
    expect(result.status).toBe(200);
    expect(events[0]?.payload?.['band']).toBe('MED');
  });
});
