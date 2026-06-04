/**
 * Unit tests for src/dsl/configLoader.ts.
 *
 * The loader validates the potemkin.yaml TOP-LEVEL via configSchema, resolves
 * `modules:` globs, partitions boundary modules from global modules, and
 * compiles the snake_case DSL bodies through the single canonical compiler
 * (compileDsl). It returns a fully-populated CompiledDsl plus the top-level
 * metadata boot needs.
 *
 * Boundary module bodies use the canonical snake_case DSL dialect
 * (boundary / contract_path / event_catalog / payload_template / reducers[].patches).
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

// A complete, snake_case boundary module that the canonical compiler accepts.
const LEAD_MODULE = `
boundary: Lead
contract_path: /leads
event_catalog:
  - type: LeadCreated
    payload_template:
      agentId: "event.payload.agentId"
reducers:
  - on: LeadCreated
    patches:
      - { op: replace, path: /status, value: "\${'NEW'}" }
`;

describe('loadPotemkinConfig — happy path', () => {
  it('loads potemkin.yaml + boundary modules from a glob into a CompiledDsl', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules:
  - "dsl/*.yaml"
`,
      'dsl/lead.yaml': LEAD_MODULE,
    });
    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'));
    expect(loaded.compiledDsl.boundaries.length).toBe(1);
    expect(loaded.compiledDsl.boundaries[0].boundary).toBe('Lead');
    expect(loaded.compiledDsl.byContractPath['/leads'].boundary).toBe('Lead');
    expect(loaded.boundaryModulePaths.length).toBe(1);
    expect(loaded.specmaticConfigPath).toBe(path.resolve(root, 'specmatic.yaml'));
  });
});

describe('Glob-based modular decomposition', () => {
  it('resolves a recursive ** glob', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules:
  - "dsl/**/*.yaml"
`,
      'dsl/lead.yaml': `boundary: Lead\ncontract_path: /a\nevent_catalog: []\n`,
      'dsl/sub/opportunity.yaml': `boundary: Opportunity\ncontract_path: /b\nevent_catalog: []\n`,
    });
    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'));
    expect(loaded.compiledDsl.boundaries.map((b) => b.boundary).sort()).toEqual([
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
      'dsl/lead.yaml': `boundary: Lead\ncontract_path: /a\nevent_catalog: []\n`,
    });
    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'));
    expect(loaded.compiledDsl.boundaries.length).toBe(1);
  });

  it('partitions a global module (no boundary:) into the global config', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules:
  - "dsl/**/*.yaml"
`,
      'dsl/lead.yaml': `boundary: Lead\ncontract_path: /a\nevent_catalog: []\n`,
      'dsl/global.yaml': `
idempotency:
  enabled: true
  ttl_seconds: 100
  hash_includes_body: true
`,
    });
    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'));
    expect(loaded.compiledDsl.boundaries.length).toBe(1);
    expect(loaded.globalModulePaths.length).toBe(1);
    expect(loaded.compiledDsl.idempotency?.ttlSeconds).toBe(100);
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

describe('Strict unknown-key rejection (potemkin.yaml top-level)', () => {
  it('rejects unknown top-level keys with a "did you mean?" suggestion', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules: ["dsl/*.yaml"]
seedz: []
`,
      'dsl/lead.yaml': `boundary: Lead\ncontract_path: /a\nevent_catalog: []\n`,
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

describe('DSL body validation flows through the snake_case compiler', () => {
  it('throws BOOT_ERR_DSL_SYNTAX when a boundary omits contract_path', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules: ["dsl/*.yaml"]
`,
      'dsl/lead.yaml': `boundary: Lead\nevent_catalog: []\n`,
    });
    await expectBootCode(
      () => loadPotemkinConfig(path.join(root, 'potemkin.yaml')),
      'BOOT_ERR_DSL_SYNTAX',
    );
  });

  it('throws BOOT_ERR_DSL_REFERENCE when a reducer references an unknown event', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules: ["dsl/*.yaml"]
`,
      'dsl/lead.yaml': `
boundary: Lead
contract_path: /a
event_catalog: []
reducers:
  - on: NeverDeclared
    patches:
      - { op: replace, path: /x, value: "\${'y'}" }
`,
    });
    await expectBootCode(
      () => loadPotemkinConfig(path.join(root, 'potemkin.yaml')),
      'BOOT_ERR_DSL_REFERENCE',
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
spec_id: crm-v1
contract_path: /leads
methods: [POST]
event_catalog: []
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
    expect(loaded.compiledDsl.boundaries.length).toBe(1);
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

  it('skips the check when out_of_contract: true', async () => {
    const root = await makeTmpFixture({
      ...baseFixture,
      'dsl/lead.yaml': `
boundary: Lead
spec_id: crm-v1
contract_path: /leads-nowhere
out_of_contract: true
event_catalog: []
`,
    });
    const eps: SpecEndpoint[] = [];
    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'), {
      specEndpoints: eps,
    });
    expect(loaded.compiledDsl.boundaries.length).toBe(1);
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
contract_path: /a
event_catalog:
  - type: LeadCreated
    payload_template: {}
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
contract_path: /a
event_catalog:
  - type: LineItemAdded
    payload_template: {}
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

describe('BOOT_ERR_CONFIG_MISSING — unreadable potemkin.yaml', () => {
  it('throws BOOT_ERR_CONFIG_MISSING when potemkin.yaml does not exist', async () => {
    await expectBootCode(
      () => loadPotemkinConfig('/nonexistent/path/potemkin.yaml'),
      'BOOT_ERR_CONFIG_MISSING',
    );
  });
});

describe('BOOT_ERR_MISSING_SPEC_ID — boundary missing specId during contract cross-check', () => {
  it('throws BOOT_ERR_MISSING_SPEC_ID when a boundary has no specId and specEndpoints are provided', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': `
version: 1
specmatic: ./specmatic.yaml
modules: ["dsl/*.yaml"]
`,
      'dsl/lead.yaml': `
boundary: Lead
contract_path: /leads
event_catalog: []
`,
    });
    const eps: SpecEndpoint[] = [
      { specId: 'crm-v1', path: '/leads', method: 'POST' },
    ];
    await expectBootCode(
      () => loadPotemkinConfig(path.join(root, 'potemkin.yaml'), { specEndpoints: eps }),
      'BOOT_ERR_MISSING_SPEC_ID',
    );
  });
});
