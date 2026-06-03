/**
 * Unit tests for C3: componentLinker — linkComponents().
 *
 * Coverage:
 *  1. Unknown component name → BOOT_ERR_DSL_REFERENCE naming the component.
 *  2. Missing required parameter (via C2) → BOOT_ERR_DSL_SYNTAX.
 *  3. Duplicate concrete boundary name (use.as clashes with a file boundary) →
 *     BOOT_ERR_DSL_DUPLICATE_BOUNDARY.
 *  4. Duplicate concrete boundary name (two use: entries share the same as) →
 *     BOOT_ERR_DSL_DUPLICATE_BOUNDARY.
 *  5. Duplicate contract_path (use.contractPath clashes with a file boundary) →
 *     BOOT_ERR_DSL_DUPLICATE_BOUNDARY.
 *  6. Duplicate contract_path between two use: entries →
 *     BOOT_ERR_DSL_DUPLICATE_BOUNDARY.
 *  7. A component with no use: entry still yields no live boundary (inert).
 *  8. A component instantiated by one use: entry yields one BoundaryConfig.
 *  9. Two use: entries for the same component yield two DISTINCT BoundaryConfigs.
 * 10. Parameter substitution is applied ({{token}} resolved in event catalog).
 * 11. Linked boundary is registered in both byBoundaryName and byContractPath.
 */

import { linkComponents } from '../../../src/dsl/componentLinker';
import { BootError } from '../../../src/errors';
import type { BoundaryConfig, ComponentDefinition, UseEntry } from '../../../src/dsl/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComponent(overrides: Partial<ComponentDefinition> = {}): ComponentDefinition {
  return {
    kind: 'component',
    name: 'TestEntity',
    eventCatalog: [{ type: 'EntityCreated', payloadTemplate: {} }],
    reducers: [{ on: 'EntityCreated' }],
    behaviors: [],
    ...overrides,
  };
}

function makeUseEntry(overrides: Partial<UseEntry> = {}): UseEntry {
  return {
    component: 'TestEntity',
    as: 'MyEntity',
    contractPath: '/my-entities',
    ...overrides,
  };
}

function emptyMaps(): {
  byBoundaryName: Record<string, BoundaryConfig>;
  byContractPath: Record<string, BoundaryConfig>;
} {
  return { byBoundaryName: {}, byContractPath: {} };
}

// A minimal BoundaryConfig stub for pre-populating collision maps.
function stubBoundary(name: string, contractPath: string): BoundaryConfig {
  return {
    boundary: name,
    contractPath,
    fallbackOverride: false,
    behaviors: [],
    reducers: [],
    eventCatalog: [],
  };
}

// ---------------------------------------------------------------------------
// 1. Unknown component name
// ---------------------------------------------------------------------------

describe('linkComponents — unknown component', () => {
  it('throws BOOT_ERR_DSL_REFERENCE when use: references a component not in the catalog', () => {
    const { byBoundaryName, byContractPath } = emptyMaps();
    expect(() =>
      linkComponents(
        [makeUseEntry({ component: 'NonExistentEntity' })],
        {},
        byBoundaryName,
        byContractPath,
      ),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_REFERENCE' }),
    );
  });

  it('error message names the missing component', () => {
    const { byBoundaryName, byContractPath } = emptyMaps();
    try {
      linkComponents(
        [makeUseEntry({ component: 'GhostComponent' })],
        {},
        byBoundaryName,
        byContractPath,
      );
      fail('expected a BootError');
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
      expect((e as BootError).message).toContain('GhostComponent');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Missing required parameter (C2 surfaces this)
// ---------------------------------------------------------------------------

describe('linkComponents — missing required parameter', () => {
  it('throws BOOT_ERR_DSL_SYNTAX when a required parameter is not supplied', () => {
    const component = makeComponent({
      name: 'Parameterised',
      parameters: {
        initialStatus: { type: 'string', required: true },
      },
    });
    const { byBoundaryName, byContractPath } = emptyMaps();

    expect(() =>
      linkComponents(
        [makeUseEntry({ component: 'Parameterised', with: {} })],
        { Parameterised: component },
        byBoundaryName,
        byContractPath,
      ),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Duplicate concrete name — use.as clashes with a file boundary
// ---------------------------------------------------------------------------

describe('linkComponents — duplicate concrete boundary name', () => {
  it('throws BOOT_ERR_DSL_DUPLICATE_BOUNDARY when use.as collides with an existing boundary', () => {
    const { byBoundaryName, byContractPath } = emptyMaps();
    byBoundaryName['MyEntity'] = stubBoundary('MyEntity', '/other-path');
    byContractPath['/other-path'] = byBoundaryName['MyEntity']!;

    expect(() =>
      linkComponents(
        [makeUseEntry({ as: 'MyEntity', contractPath: '/new-path' })],
        { TestEntity: makeComponent() },
        byBoundaryName,
        byContractPath,
      ),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_DUPLICATE_BOUNDARY' }),
    );
  });

  it('throws BOOT_ERR_DSL_DUPLICATE_BOUNDARY when two use: entries share the same as', () => {
    const { byBoundaryName, byContractPath } = emptyMaps();

    expect(() =>
      linkComponents(
        [
          makeUseEntry({ as: 'SharedName', contractPath: '/path-a' }),
          makeUseEntry({ as: 'SharedName', contractPath: '/path-b' }),
        ],
        { TestEntity: makeComponent() },
        byBoundaryName,
        byContractPath,
      ),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_DUPLICATE_BOUNDARY' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Duplicate contract_path
// ---------------------------------------------------------------------------

describe('linkComponents — duplicate contract_path', () => {
  it('throws BOOT_ERR_DSL_DUPLICATE_BOUNDARY when use.contractPath collides with a file boundary', () => {
    const { byBoundaryName, byContractPath } = emptyMaps();
    byBoundaryName['ExistingBoundary'] = stubBoundary('ExistingBoundary', '/shared-path');
    byContractPath['/shared-path'] = byBoundaryName['ExistingBoundary']!;

    expect(() =>
      linkComponents(
        [makeUseEntry({ as: 'NewBoundary', contractPath: '/shared-path' })],
        { TestEntity: makeComponent() },
        byBoundaryName,
        byContractPath,
      ),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_DUPLICATE_BOUNDARY' }),
    );
  });

  it('throws BOOT_ERR_DSL_DUPLICATE_BOUNDARY when two use: entries share the same contractPath', () => {
    const { byBoundaryName, byContractPath } = emptyMaps();

    expect(() =>
      linkComponents(
        [
          makeUseEntry({ as: 'NameA', contractPath: '/shared' }),
          makeUseEntry({ as: 'NameB', contractPath: '/shared' }),
        ],
        { TestEntity: makeComponent() },
        byBoundaryName,
        byContractPath,
      ),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_DUPLICATE_BOUNDARY' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. A component alone (no use: entry) is inert
// ---------------------------------------------------------------------------

describe('linkComponents — inert component', () => {
  it('produces no boundary when use: entries is empty', () => {
    const { byBoundaryName, byContractPath } = emptyMaps();
    const result = linkComponents(
      [],
      { TestEntity: makeComponent() },
      byBoundaryName,
      byContractPath,
    );

    expect(result).toHaveLength(0);
    expect(Object.keys(byBoundaryName)).toHaveLength(0);
    expect(Object.keys(byContractPath)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Single use: entry produces one concrete BoundaryConfig
// ---------------------------------------------------------------------------

describe('linkComponents — single instantiation', () => {
  it('returns a BoundaryConfig with boundary = as and contractPath from the entry', () => {
    const { byBoundaryName, byContractPath } = emptyMaps();
    const result = linkComponents(
      [makeUseEntry({ as: 'MyDoc', contractPath: '/documents' })],
      { TestEntity: makeComponent() },
      byBoundaryName,
      byContractPath,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.boundary).toBe('MyDoc');
    expect(result[0]!.contractPath).toBe('/documents');
  });

  it('registers the concrete boundary in byBoundaryName and byContractPath', () => {
    const { byBoundaryName, byContractPath } = emptyMaps();
    linkComponents(
      [makeUseEntry({ as: 'MyDoc', contractPath: '/documents' })],
      { TestEntity: makeComponent() },
      byBoundaryName,
      byContractPath,
    );

    expect(byBoundaryName['MyDoc']).toBeDefined();
    expect(byContractPath['/documents']).toBeDefined();
    expect(byBoundaryName['MyDoc']!.contractPath).toBe('/documents');
  });
});

// ---------------------------------------------------------------------------
// 7. Two use: entries for the same component → two distinct BoundaryConfigs
// ---------------------------------------------------------------------------

describe('linkComponents — two instantiations of the same component', () => {
  it('produces two distinct BoundaryConfig objects', () => {
    const { byBoundaryName, byContractPath } = emptyMaps();
    const result = linkComponents(
      [
        makeUseEntry({ as: 'Document', contractPath: '/documents' }),
        makeUseEntry({ as: 'ArchivedDocument', contractPath: '/archived-documents' }),
      ],
      { TestEntity: makeComponent() },
      byBoundaryName,
      byContractPath,
    );

    expect(result).toHaveLength(2);
    expect(result[0]!.boundary).toBe('Document');
    expect(result[1]!.boundary).toBe('ArchivedDocument');
    expect(result[0]).not.toBe(result[1]);
  });

  it('registers both concrete boundaries in byBoundaryName and byContractPath', () => {
    const { byBoundaryName, byContractPath } = emptyMaps();
    linkComponents(
      [
        makeUseEntry({ as: 'Document', contractPath: '/documents' }),
        makeUseEntry({ as: 'ArchivedDocument', contractPath: '/archived-documents' }),
      ],
      { TestEntity: makeComponent() },
      byBoundaryName,
      byContractPath,
    );

    expect(byBoundaryName['Document']).toBeDefined();
    expect(byBoundaryName['ArchivedDocument']).toBeDefined();
    expect(byContractPath['/documents']).toBeDefined();
    expect(byContractPath['/archived-documents']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Parameter substitution is applied
// ---------------------------------------------------------------------------

describe('linkComponents — parameter substitution', () => {
  it('substitutes {{token}} in event catalog entries', () => {
    const component = makeComponent({
      name: 'Parameterised',
      parameters: { prefix: { type: 'string', required: true } },
      eventCatalog: [{ type: '{{prefix}}Created', payloadTemplate: {} }],
      reducers: [{ on: '{{prefix}}Created' }],
    });

    const { byBoundaryName, byContractPath } = emptyMaps();
    const result = linkComponents(
      [makeUseEntry({ component: 'Parameterised', as: 'Doc', contractPath: '/docs', with: { prefix: 'Document' } })],
      { Parameterised: component },
      byBoundaryName,
      byContractPath,
    );

    expect(result[0]!.eventCatalog[0]!.type).toBe('DocumentCreated');
    expect(result[0]!.reducers[0]!.on).toBe('DocumentCreated');
  });

  it('applies default parameter values when no with: arg is supplied', () => {
    const component = makeComponent({
      name: 'WithDefault',
      parameters: { statusField: { type: 'string', default: 'status' } },
      reducers: [{ on: 'EntityCreated', patches: [{ op: 'replace', path: '/{{statusField}}', value: 'active' }] }],
    });

    const { byBoundaryName, byContractPath } = emptyMaps();
    const result = linkComponents(
      [makeUseEntry({ component: 'WithDefault', as: 'MyBoundary', contractPath: '/things' })],
      { WithDefault: component },
      byBoundaryName,
      byContractPath,
    );

    expect(result[0]!.reducers[0]!.patches![0]!.path).toBe('/status');
  });
});
