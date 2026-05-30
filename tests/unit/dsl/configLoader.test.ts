/**
 * Unit tests for src/dsl/configLoader.ts + src/dsl/configSchema.ts.
 *
 * Covers REQ-LOAD-001..006 and REQ-PATCH-003 (assign:/append: removal at the
 * validator).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { loadPotemkinConfig, type SpecEndpoint } from '../../../src/dsl/configLoader.js';
import { BootError } from '../../../src/errors.js';

async function makeTmpFixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-fixture-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return root;
}

function asBootError(e: unknown): BootError | null {
  return e instanceof BootError ? e : null;
}

async function expectBootCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  let caught: BootError | null = null;
  try {
    await fn();
  } catch (e) {
    caught = asBootError(e);
  }
  expect(caught?.code).toBe(code);
}

const MINIMAL_SPECMATIC = `version: 3\n`;

describe('loadPotemkinConfig — happy path (REQ-LOAD-001)', () => {
  it('loads potemkin.yaml + boundary modules from a glob', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules:
  - "dsl/*.yaml"
`,
      'dsl/lead.yaml': `
boundary: Lead
specId: crm-v1
contractPath: /leads
events:
  - name: LeadCreated
    template:
      agentId: event.payload.agentId
reducers:
  - on: LeadCreated
    patches:
      - { op: replace, path: /status, value: "\${'NEW'}" }
`,
    });
    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'));
    expect(loaded.modules.length).toBe(1);
    expect(loaded.modules[0].boundary.boundary).toBe('Lead');
    expect(loaded.specmaticConfigPath).toBe(path.resolve(root, 'specmatic.yaml'));
  });
});

describe('Glob-based modular decomposition (REQ-LOAD-002)', () => {
  it('resolves a recursive ** glob', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules:
  - "dsl/**/*.yaml"
`,
      'dsl/lead.yaml': `boundary: Lead\nspecId: x\ncontractPath: /a\nevents: []\n`,
      'dsl/sub/opportunity.yaml': `boundary: Opportunity\nspecId: x\ncontractPath: /b\nevents: []\n`,
    });
    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'));
    expect(loaded.modules.map((m) => m.boundary.boundary).sort()).toEqual([
      'Lead',
      'Opportunity',
    ]);
  });

  it('deduplicates files matched by multiple globs', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules:
  - "dsl/*.yaml"
  - "dsl/lead.yaml"
`,
      'dsl/lead.yaml': `boundary: Lead\nspecId: x\ncontractPath: /a\nevents: []\n`,
    });
    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'));
    expect(loaded.modules.length).toBe(1);
  });

  it('throws BOOT_ERR_NO_MODULES when no glob matches', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules: ["dsl/*.yaml"]
`,
    });
    await expectBootCode(
      () => loadPotemkinConfig(path.join(root, 'potemkin.yaml')),
      'BOOT_ERR_NO_MODULES',
    );
  });

  it('throws BOOT_ERR_INVALID_YAML on malformed YAML', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules: ["dsl/*.yaml"]
`,
      'dsl/bad.yaml': `boundary: [`,
    });
    await expectBootCode(
      () => loadPotemkinConfig(path.join(root, 'potemkin.yaml')),
      'BOOT_ERR_INVALID_YAML',
    );
  });
});

describe('camelCase enforcement (REQ-LOAD-003)', () => {
  it('rejects legacy snake_case keys with the camelCase replacement', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules: ["dsl/*.yaml"]
`,
      'dsl/lead.yaml': `
boundary: Lead
spec_id: x
contractPath: /a
event_catalog: []
`,
    });
    let caught: BootError | null = null;
    try {
      await loadPotemkinConfig(path.join(root, 'potemkin.yaml'));
    } catch (e) {
      caught = asBootError(e);
    }
    expect(caught?.code).toBe('BOOT_ERR_REMOVED_SYNTAX');
    // Names one of the legacy keys + the replacement
    expect(caught?.message).toMatch(/spec_id|event_catalog/);
  });
});

describe('Strict unknown-key rejection (REQ-LOAD-004)', () => {
  it('rejects unknown top-level keys with a "did you mean?" suggestion', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules: ["dsl/*.yaml"]
seedz: []
`,
      'dsl/lead.yaml': `boundary: Lead\nspecId: x\ncontractPath: /a\nevents: []\n`,
    });
    let caught: BootError | null = null;
    try {
      await loadPotemkinConfig(path.join(root, 'potemkin.yaml'));
    } catch (e) {
      caught = asBootError(e);
    }
    expect(caught?.code).toBe('BOOT_ERR_UNKNOWN_KEY');
    expect(caught?.message).toMatch(/seedz/);
    expect(caught?.message).toMatch(/seeds/); // suggestion
  });
});

describe('Boundary specId required (REQ-LOAD-005)', () => {
  it('throws BOOT_ERR_MISSING_SPEC_ID when a boundary omits specId', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules: ["dsl/*.yaml"]
`,
      'dsl/lead.yaml': `boundary: Lead\ncontractPath: /a\nevents: []\n`,
    });
    await expectBootCode(
      () => loadPotemkinConfig(path.join(root, 'potemkin.yaml')),
      'BOOT_ERR_MISSING_SPEC_ID',
    );
  });
});

describe('contractPath cross-check (REQ-LOAD-006)', () => {
  const baseFixture = {
    'specmatic.yaml': MINIMAL_SPECMATIC,
    'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules: ["dsl/*.yaml"]
`,
    'dsl/lead.yaml': `
boundary: Lead
specId: crm-v1
contractPath: /leads
methods: [POST]
events: []
`,
  };

  it('passes when contractPath + method are present', async () => {
    const root = await makeTmpFixture(baseFixture);
    const eps: SpecEndpoint[] = [
      { specId: 'crm-v1', path: '/leads', method: 'POST' },
    ];
    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'), {
      specEndpoints: eps,
    });
    expect(loaded.modules.length).toBe(1);
  });

  it('throws BOOT_ERR_UNKNOWN_SPEC_ID when specId is not in the endpoint set', async () => {
    const root = await makeTmpFixture(baseFixture);
    const eps: SpecEndpoint[] = [
      { specId: 'other-v2', path: '/leads', method: 'POST' },
    ];
    await expectBootCode(
      () => loadPotemkinConfig(path.join(root, 'potemkin.yaml'), { specEndpoints: eps }),
      'BOOT_ERR_UNKNOWN_SPEC_ID',
    );
  });

  it('throws BOOT_ERR_UNKNOWN_CONTRACT_PATH when path is missing', async () => {
    const root = await makeTmpFixture(baseFixture);
    const eps: SpecEndpoint[] = [
      { specId: 'crm-v1', path: '/other', method: 'POST' },
    ];
    await expectBootCode(
      () => loadPotemkinConfig(path.join(root, 'potemkin.yaml'), { specEndpoints: eps }),
      'BOOT_ERR_UNKNOWN_CONTRACT_PATH',
    );
  });

  it('throws BOOT_ERR_UNKNOWN_CONTRACT_PATH when declared method is missing', async () => {
    const root = await makeTmpFixture(baseFixture);
    const eps: SpecEndpoint[] = [
      { specId: 'crm-v1', path: '/leads', method: 'GET' },
    ];
    await expectBootCode(
      () => loadPotemkinConfig(path.join(root, 'potemkin.yaml'), { specEndpoints: eps }),
      'BOOT_ERR_UNKNOWN_CONTRACT_PATH',
    );
  });

  it('skips the check when outOfContract: true', async () => {
    const root = await makeTmpFixture({
      ...baseFixture,
      'dsl/lead.yaml': `
boundary: Lead
specId: crm-v1
contractPath: /leads-nowhere
outOfContract: true
events: []
`,
    });
    const eps: SpecEndpoint[] = [];
    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'), {
      specEndpoints: eps,
    });
    expect(loaded.modules.length).toBe(1);
  });
});

describe('Reducer assign:/append: rejection (REQ-PATCH-003)', () => {
  it('throws BOOT_ERR_REMOVED_SYNTAX when a reducer uses assign:', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules: ["dsl/*.yaml"]
`,
      'dsl/lead.yaml': `
boundary: Lead
specId: x
contractPath: /a
events: []
reducers:
  - on: LeadCreated
    assign:
      status: "'NEW'"
`,
    });
    await expectBootCode(
      () => loadPotemkinConfig(path.join(root, 'potemkin.yaml')),
      'BOOT_ERR_REMOVED_SYNTAX',
    );
  });

  it('throws BOOT_ERR_REMOVED_SYNTAX when a reducer uses append:', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules: ["dsl/*.yaml"]
`,
      'dsl/lead.yaml': `
boundary: Lead
specId: x
contractPath: /a
events: []
reducers:
  - on: LineItemAdded
    append:
      lineItems: event.payload
`,
    });
    await expectBootCode(
      () => loadPotemkinConfig(path.join(root, 'potemkin.yaml')),
      'BOOT_ERR_REMOVED_SYNTAX',
    );
  });
});
