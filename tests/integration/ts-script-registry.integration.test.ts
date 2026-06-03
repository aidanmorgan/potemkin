/**
 * B2: ts:<id> resolution against the scanned @Script registry.
 *
 * Verifies that:
 * 1. A boundary referencing ts:computeScore (resolved from a scanned @Script)
 *    boots successfully and the script executes end-to-end — the field is set
 *    by the scanned function, not inline code.
 * 2. An unknown ts:<id> (not in inline scripts and not in scanned @Script registry)
 *    halts boot with BOOT_ERR_DSL_REFERENCE naming the id.
 * 3. The scanned function is invoked as a direct host call (execution model is
 *    documented in the ScriptHandle — source field names the registration style).
 */

import * as path from 'node:path';

import { bootSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { BootError } from '../../src/errors.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { Command } from '../../src/types.js';
import { scriptRegistry as sdkScriptRegistry } from '../../src/sdk/index.js';

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'ts-script');
const CONFIG = path.join(FIXTURE_DIR, 'potemkin.yaml');
const OPENAPI = path.join(FIXTURE_DIR, 'openapi', 'leads.yaml');

function createLeadCommand(source: string): Command {
  return {
    commandId: nextUuidv7(),
    boundary: 'Lead',
    intent: 'creation',
    targetId: nextUuidv7(),
    payload: { companyName: 'Acme Corp', source },
    queryParams: {},
    httpMethod: 'POST',
    path: '/leads',
    origin: 'inbound',
    depth: 0,
  };
}

afterEach(() => {
  sdkScriptRegistry.resetSync();
});

describe('Scanned @Script resolves ts:<id> in payload_template', () => {
  it('boots successfully when ts:computeScore is backed by a scanned @Script', async () => {
    const openapi = await loadOpenApi(OPENAPI);
    const sys = await bootSystem({ openapi, potemkinConfigPath: CONFIG });
    expect(sys.dsl.scriptRegistry).toBeDefined();
    resetSystem(sys);
  });

  it('executes the scanned @Script and sets the score field (REFERRAL → 80)', async () => {
    const openapi = await loadOpenApi(OPENAPI);
    const sys = await bootSystem({ openapi, potemkinConfigPath: CONFIG });

    const cmd = createLeadCommand('REFERRAL');
    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      openapi: sys.openapi,
      schemaRegistry: sys.schemaRegistry,
      tsReducerRegistry: sys.tsReducerRegistry,
      logger: sys.logger,
    });

    const state = sys.graph.get(cmd.targetId!);
    expect(state).not.toBeNull();
    expect(state!['score']).toBe(80);
    expect(state!['source']).toBe('REFERRAL');
    expect(state!['companyName']).toBe('Acme Corp');

    resetSystem(sys);
  });

  it('executes the scanned @Script and sets the score field (WEBSITE → 50)', async () => {
    const openapi = await loadOpenApi(OPENAPI);
    const sys = await bootSystem({ openapi, potemkinConfigPath: CONFIG });

    const cmd = createLeadCommand('WEBSITE');
    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      openapi: sys.openapi,
      schemaRegistry: sys.schemaRegistry,
      tsReducerRegistry: sys.tsReducerRegistry,
      logger: sys.logger,
    });

    const state = sys.graph.get(cmd.targetId!);
    expect(state!['score']).toBe(50);

    resetSystem(sys);
  });

  it('executes the scanned @Script and returns default score for unknown source (OTHER → 30)', async () => {
    const openapi = await loadOpenApi(OPENAPI);
    const sys = await bootSystem({ openapi, potemkinConfigPath: CONFIG });

    const cmd = createLeadCommand('OTHER');
    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      openapi: sys.openapi,
      schemaRegistry: sys.schemaRegistry,
      tsReducerRegistry: sys.tsReducerRegistry,
      logger: sys.logger,
    });

    const state = sys.graph.get(cmd.targetId!);
    expect(state!['score']).toBe(30);

    resetSystem(sys);
  });

  it('scanned @Script handle source field identifies class registration style', async () => {
    const openapi = await loadOpenApi(OPENAPI);
    const sys = await bootSystem({ openapi, potemkinConfigPath: CONFIG });

    const registry = sys.dsl.scriptRegistry!;
    const handle = registry.get('Lead', 'computeScore');
    expect(handle).toBeDefined();
    // class: prefix indicates direct host call (no vm sandbox) — the registration
    // style is trusted operator-authored code, not inline YAML-embedded source.
    expect(handle!.source).toMatch(/^class:/);

    resetSystem(sys);
  });
});

describe('Unknown ts:<id> halts boot with BOOT_ERR_DSL_REFERENCE', () => {
  it('throws BOOT_ERR_DSL_REFERENCE when ts:<id> resolves to neither inline nor scanned', async () => {
    const openapi = await loadOpenApi(OPENAPI);

    const dsl = await compileDsl([
      {
        name: 'lead.yaml',
        yaml: `
boundary: Lead
contract_path: /leads
fallback_override: false
identity:
  creation:
    generate: $uuidv7()
event_catalog:
  - type: LeadCreated
    payload_template:
      id: "command.targetId"
      score: "ts:noSuchScript"
behaviors:
  - name: createLead
    match:
      operationId: createLead
      condition: "true"
    emit: LeadCreated
reducers:
  - on: LeadCreated
    patches:
      - op: replace
        path: /id
        value: "\${event.payload.id}"
initialization: []
`,
      },
    ]);

    let caught: BootError | null = null;
    try {
      const sys = await bootSystem({ openapi, compiledDsl: dsl });
      resetSystem(sys);
    } catch (err) {
      caught = err instanceof BootError ? err : null;
    }

    expect(caught).toBeInstanceOf(BootError);
    expect(caught!.code).toBe('BOOT_ERR_DSL_REFERENCE');
    expect(caught!.message).toContain('noSuchScript');
  });

  it('throws BOOT_ERR_DSL_REFERENCE with behavior condition ts:<id> that is unknown', async () => {
    const openapi = await loadOpenApi(OPENAPI);

    const dsl = await compileDsl([
      {
        name: 'lead.yaml',
        yaml: `
boundary: Lead
contract_path: /leads
fallback_override: false
identity:
  creation:
    generate: $uuidv7()
event_catalog:
  - type: LeadCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: createLead
    match:
      operationId: createLead
      condition: "ts:missingConditionScript"
    emit: LeadCreated
reducers:
  - on: LeadCreated
    patches:
      - op: replace
        path: /id
        value: "\${event.payload.id}"
initialization: []
`,
      },
    ]);

    let caught: BootError | null = null;
    try {
      const sys = await bootSystem({ openapi, compiledDsl: dsl });
      resetSystem(sys);
    } catch (err) {
      caught = err instanceof BootError ? err : null;
    }

    expect(caught).toBeInstanceOf(BootError);
    expect(caught!.code).toBe('BOOT_ERR_DSL_REFERENCE');
    expect(caught!.message).toContain('missingConditionScript');
  });
});
