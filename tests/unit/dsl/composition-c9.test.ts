/**
 * C9 — Regression / migration sweep.
 *
 * Proves that:
 *  1. The loader classifies each of the four file kinds correctly via
 *     loadPotemkinConfig (the full on-disk path).
 *  2. compileDsl classifies all four kinds correctly in memory.
 *  3. Non-composed fixtures (no kind:/use:/include:) produce zero components
 *     and zero use entries in the compiled DSL.
 *  4. A boundary file with contract_path and no kind is never misclassified
 *     as a component or a global module.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { loadPotemkinConfig } from '../../../src/dsl/configLoader.js';
import { compileDsl } from '../../../src/dsl/parser.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function makeTmpFixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-c9-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return root;
}

const MINIMAL_SPECMATIC = `version: 3\n`;

const POTEMKIN_YAML = `
version: 1
specmatic: ./specmatic.yaml
modules:
  - "dsl/**/*.yaml"
`;

// ---------------------------------------------------------------------------
// Kind 1: LIVE BOUNDARY — has boundary: + contract_path, no kind:
// ---------------------------------------------------------------------------

const LIVE_BOUNDARY_YAML = `
boundary: Widget
contract_path: /widgets
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: "command.targetId"
behaviors: []
reducers:
  - on: WidgetCreated
`;

// ---------------------------------------------------------------------------
// Kind 2: COMPONENT — kind: component, no contract_path
// ---------------------------------------------------------------------------

const COMPONENT_YAML = `
kind: component
name: WidgetTemplate
parameters:
  statusField:
    type: string
    default: status
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: "command.targetId"
behaviors: []
reducers:
  - on: WidgetCreated
`;

// ---------------------------------------------------------------------------
// Kind 3: USE-MAPPING — use: array, no boundary:, no kind:
// ---------------------------------------------------------------------------

const USE_MAPPING_YAML = `
use:
  - component: WidgetTemplate
    as: Widget
    contract_path: /widgets
    with:
      statusField: status
`;

// ---------------------------------------------------------------------------
// Kind 4: GLOBAL MODULE — no boundary:, no kind:, no use:
// ---------------------------------------------------------------------------

const GLOBAL_MODULE_YAML = `
idempotency:
  enabled: true
  ttl_seconds: 120
  hash_includes_body: false
`;

// ---------------------------------------------------------------------------
// Suite 1 — loadPotemkinConfig: kind 1 (live boundary)
// ---------------------------------------------------------------------------

describe('C9 — loadPotemkinConfig classifies kind 1: live boundary', () => {
  it('a file with boundary: and contract_path (no kind:) is classified as a live boundary', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': POTEMKIN_YAML,
      'dsl/widget.yaml': LIVE_BOUNDARY_YAML,
    });

    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'));

    // Appears as a live boundary.
    expect(loaded.boundaryModulePaths).toHaveLength(1);
    expect(loaded.compiledDsl.byBoundaryName['Widget']).toBeDefined();
    expect(loaded.compiledDsl.boundaries).toHaveLength(1);

    // Must NOT appear in any other partition.
    expect(loaded.componentModulePaths).toHaveLength(0);
    expect(loaded.useMappingModulePaths).toHaveLength(0);
    expect(loaded.globalModulePaths).toHaveLength(0);

    // CompiledDsl must carry no components and no use entries.
    expect(loaded.compiledDsl.components).toBeUndefined();
    expect(loaded.compiledDsl.use).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — loadPotemkinConfig: kind 2 (component)
// ---------------------------------------------------------------------------

describe('C9 — loadPotemkinConfig classifies kind 2: component', () => {
  it('a file with kind: component is classified as a component and produces no live boundary', async () => {
    // Use-mapping references the component, so we need a live boundary too for the
    // loader to avoid BOOT_ERR_NO_MODULES on the boundary side.
    // To test a standalone component file without a use: file we need at least
    // one resolvable live boundary — supply one so compilation does not abort.
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': POTEMKIN_YAML,
      'dsl/widget-template.yaml': COMPONENT_YAML,
      'dsl/use.yaml': USE_MAPPING_YAML,
    });

    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'));

    // Component file is in its own partition.
    expect(loaded.componentModulePaths).toHaveLength(1);
    expect(path.basename(loaded.componentModulePaths[0]!)).toBe('widget-template.yaml');

    // The component produces NO live boundary from its own file.
    // The linked boundary (Widget, from use:) should appear.
    expect(loaded.compiledDsl.components).toBeDefined();
    expect(loaded.compiledDsl.components!['WidgetTemplate']).toBeDefined();
    expect(loaded.compiledDsl.components!['WidgetTemplate']!.kind).toBe('component');

    // Component file must NOT appear in boundary or global partitions.
    expect(loaded.boundaryModulePaths).toHaveLength(0);
    expect(loaded.globalModulePaths).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — loadPotemkinConfig: kind 3 (use-mapping)
// ---------------------------------------------------------------------------

describe('C9 — loadPotemkinConfig classifies kind 3: use-mapping', () => {
  it('a file with only use: (no boundary:, no kind:) is classified as a use-mapping file', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': POTEMKIN_YAML,
      'dsl/widget-template.yaml': COMPONENT_YAML,
      'dsl/simulation.yaml': USE_MAPPING_YAML,
    });

    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'));

    // Use-mapping file is in its own partition.
    expect(loaded.useMappingModulePaths).toHaveLength(1);
    expect(path.basename(loaded.useMappingModulePaths[0]!)).toBe('simulation.yaml');

    // The use: entries were linked into live boundaries.
    expect(loaded.compiledDsl.byBoundaryName['Widget']).toBeDefined();
    expect(loaded.compiledDsl.use).toBeDefined();
    expect(loaded.compiledDsl.use).toHaveLength(1);

    // Use-mapping file must NOT appear in boundary or global partitions.
    expect(loaded.boundaryModulePaths).toHaveLength(0);
    expect(loaded.globalModulePaths).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — loadPotemkinConfig: kind 4 (global module)
// ---------------------------------------------------------------------------

describe('C9 — loadPotemkinConfig classifies kind 4: global module', () => {
  it('a file with no boundary:, no kind:, no use: is classified as a global module', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': POTEMKIN_YAML,
      'dsl/widget.yaml': LIVE_BOUNDARY_YAML,
      'dsl/global.yaml': GLOBAL_MODULE_YAML,
    });

    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'));

    // Global file is in its own partition.
    expect(loaded.globalModulePaths).toHaveLength(1);
    expect(path.basename(loaded.globalModulePaths[0]!)).toBe('global.yaml');

    // The global config contributes idempotency config.
    expect(loaded.compiledDsl.idempotency).toBeDefined();
    expect(loaded.compiledDsl.idempotency!.ttlSeconds).toBe(120);

    // Global file must NOT appear in boundary, component, or use-mapping partitions.
    expect(loaded.componentModulePaths).toHaveLength(0);
    expect(loaded.useMappingModulePaths).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Non-composed fixture: zero components, all boundaries are live
// ---------------------------------------------------------------------------

describe('C9 — non-composed fixture incurs zero composition overhead', () => {
  it('a fixture with only live boundary files and a global module produces no components or use entries', async () => {
    const boundaryA = `
boundary: BoundaryA
contract_path: /boundary-a
event_catalog:
  - type: ACreated
    payload_template:
      id: "command.targetId"
behaviors: []
reducers:
  - on: ACreated
`;

    const boundaryB = `
boundary: BoundaryB
contract_path: /boundary-b
event_catalog:
  - type: BCreated
    payload_template:
      id: "command.targetId"
behaviors: []
reducers:
  - on: BCreated
`;

    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': POTEMKIN_YAML,
      'dsl/boundary-a.yaml': boundaryA,
      'dsl/boundary-b.yaml': boundaryB,
      'dsl/global.yaml': GLOBAL_MODULE_YAML,
    });

    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'));

    // Both boundaries are live.
    expect(loaded.compiledDsl.boundaries).toHaveLength(2);
    expect(loaded.compiledDsl.byBoundaryName['BoundaryA']).toBeDefined();
    expect(loaded.compiledDsl.byBoundaryName['BoundaryB']).toBeDefined();

    // Zero composition overhead — no components or use entries in compiled DSL.
    expect(loaded.compiledDsl.components).toBeUndefined();
    expect(loaded.compiledDsl.use).toBeUndefined();

    // Partitions are correct.
    expect(loaded.boundaryModulePaths).toHaveLength(2);
    expect(loaded.componentModulePaths).toHaveLength(0);
    expect(loaded.useMappingModulePaths).toHaveLength(0);
    expect(loaded.globalModulePaths).toHaveLength(1);
  });

  it('compileDsl with only live boundary modules has no components and no use on CompiledDsl', async () => {
    const compiled = await compileDsl([
      {
        name: 'alpha.yaml',
        yaml: `
boundary: Alpha
contract_path: /alpha
event_catalog:
  - type: AlphaCreated
    payload_template:
      id: "command.targetId"
behaviors: []
reducers:
  - on: AlphaCreated
`,
      },
      {
        name: 'beta.yaml',
        yaml: `
boundary: Beta
contract_path: /beta
event_catalog:
  - type: BetaCreated
    payload_template:
      id: "command.targetId"
behaviors: []
reducers:
  - on: BetaCreated
`,
      },
    ]);

    // All boundaries are live.
    expect(compiled.boundaries).toHaveLength(2);
    expect(compiled.byBoundaryName['Alpha']).toBeDefined();
    expect(compiled.byBoundaryName['Beta']).toBeDefined();

    // Zero composition fields.
    expect(compiled.components).toBeUndefined();
    expect(compiled.use).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — Boundary file is never misclassified as component or global
// ---------------------------------------------------------------------------

describe('C9 — live boundary file is not misclassified', () => {
  it('a file with boundary: + contract_path + no kind: is never treated as a component', async () => {
    // Directly through compileDsl — the boundary must not appear in components.
    const compiled = await compileDsl(
      [
        {
          name: 'widget.yaml',
          yaml: `
boundary: Widget
contract_path: /widgets
event_catalog: []
behaviors: []
reducers: []
`,
        },
      ],
      undefined,
      undefined,
      undefined,
    );

    expect(compiled.boundaries).toHaveLength(1);
    expect(compiled.byBoundaryName['Widget']).toBeDefined();
    // No component catalog was populated.
    expect(compiled.components).toBeUndefined();
  });

  it('boundary file is never merged into global config (no idempotency bleed)', async () => {
    // Supply a live boundary alongside a global module.
    // The boundary's event_catalog must not be consumed as a global config field.
    const compiled = await compileDsl(
      [
        {
          name: 'widget.yaml',
          yaml: `
boundary: Widget
contract_path: /widgets
event_catalog: []
behaviors: []
reducers: []
`,
        },
      ],
      // globalYaml has idempotency only.
      `idempotency:\n  enabled: true\n  ttl_seconds: 60\n  hash_includes_body: false\n`,
    );

    expect(compiled.boundaries).toHaveLength(1);
    expect(compiled.byBoundaryName['Widget']).toBeDefined();
    // Global config was parsed correctly alongside the live boundary.
    expect(compiled.idempotency).toBeDefined();
    expect(compiled.idempotency!.ttlSeconds).toBe(60);
    // Still no composition fields.
    expect(compiled.components).toBeUndefined();
    expect(compiled.use).toBeUndefined();
  });

  it('a file with boundary: + contract_path is not placed in the global partition by loadPotemkinConfig', async () => {
    const root = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': POTEMKIN_YAML,
      'dsl/widget.yaml': LIVE_BOUNDARY_YAML,
    });

    const loaded = await loadPotemkinConfig(path.join(root, 'potemkin.yaml'));

    // Must be in boundary partition only.
    expect(loaded.boundaryModulePaths).toHaveLength(1);
    expect(loaded.globalModulePaths).toHaveLength(0);
    expect(loaded.componentModulePaths).toHaveLength(0);
    expect(loaded.useMappingModulePaths).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — All four kinds in a single fixture
// ---------------------------------------------------------------------------

describe('C9 — all four file kinds in a single fixture are classified independently', () => {
  it('boundary, component, use-mapping, and global files each land in their own partition', async () => {
    // The use-mapping references WidgetTemplate and binds it to Widget at /widgets.
    // Including a live boundary named Widget at the same path would cause a
    // contract_path collision. Omit the live boundary file so all four partition
    // counts are exercisable without a collision; the linked boundary (Widget)
    // still appears in byBoundaryName via the use: linker.
    const rootNoLive = await makeTmpFixture({
      'specmatic.yaml': MINIMAL_SPECMATIC,
      'potemkin.yaml': POTEMKIN_YAML,
      'dsl/template.yaml': COMPONENT_YAML,
      'dsl/simulation.yaml': USE_MAPPING_YAML,
      'dsl/global.yaml': GLOBAL_MODULE_YAML,
    });

    const loaded = await loadPotemkinConfig(path.join(rootNoLive, 'potemkin.yaml'));

    // One component file.
    expect(loaded.componentModulePaths).toHaveLength(1);
    // One use-mapping file.
    expect(loaded.useMappingModulePaths).toHaveLength(1);
    // One global file.
    expect(loaded.globalModulePaths).toHaveLength(1);
    // No direct boundary files (the boundary came from use: linking).
    expect(loaded.boundaryModulePaths).toHaveLength(0);

    // The component was catalogued.
    expect(loaded.compiledDsl.components!['WidgetTemplate']).toBeDefined();
    // The use: entry was linked into a concrete live boundary.
    expect(loaded.compiledDsl.byBoundaryName['Widget']).toBeDefined();
    // Global config was merged.
    expect(loaded.compiledDsl.idempotency?.ttlSeconds).toBe(120);
  });
});
