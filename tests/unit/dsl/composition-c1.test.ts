/**
 * Unit tests for C1: file-kind classification, component grammar, use:/include:/parameters
 * parsing, and Phase-1 validation.
 *
 * Coverage:
 *  - A kind: component file yields zero live boundaries (byBoundaryName has no entry)
 *  - Component with parameters parses into ComponentDefinition
 *  - use: entries parse into UseEntry on CompiledDsl.use
 *  - include: entries parse into IncludeEntry on BoundaryConfig
 *  - BOOT_ERR_DSL_SYNTAX for unknown kind value
 *  - BOOT_ERR_DSL_SYNTAX for malformed parameter type keyword
 *  - BOOT_ERR_DSL_SYNTAX for use: entry missing `as`
 *  - BOOT_ERR_DSL_SYNTAX for use: entry missing `contract_path`
 *  - BOOT_ERR_DSL_SYNTAX for use: entry missing `component`
 *  - BOOT_ERR_DSL_SYNTAX for include: entry missing `component`
 *  - Existing boundary files classify as live boundaries (unchanged)
 *  - Intra-component cross-reference: reducer on unknown event is rejected
 */

import { compileDsl, parseComponentYaml, parseUseMappingYaml } from '../../../src/dsl/parser';
import { validateBoundaryConfig, validateIncludeEntries, validateUseEntries } from '../../../src/dsl/schema';
import { BootError } from '../../../src/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const minimalBoundaryYaml = `
boundary: Widget
contract_path: /widgets
behaviors: []
reducers: []
event_catalog: []
`;

const minimalComponentYaml = `
kind: component
name: DocumentEntity
event_catalog:
  - type: DocumentCreated
    payload_template: {}
reducers:
  - on: DocumentCreated
behaviors: []
`;

// ---------------------------------------------------------------------------
// 1. A kind: component file yields zero live boundaries
// ---------------------------------------------------------------------------

describe('C1 — component file classification', () => {
  it('a kind: component module produces no entry in byBoundaryName', async () => {
    const compiled = await compileDsl(
      [],  // no live boundary modules
      undefined,
      [{ name: 'document.yaml', yaml: minimalComponentYaml }],
    );

    expect(Object.keys(compiled.byBoundaryName)).toHaveLength(0);
    expect(compiled.boundaries).toHaveLength(0);
  });

  it('a kind: component module appears in compiled.components', async () => {
    const compiled = await compileDsl(
      [],
      undefined,
      [{ name: 'document.yaml', yaml: minimalComponentYaml }],
    );

    expect(compiled.components).toBeDefined();
    expect(compiled.components!['DocumentEntity']).toBeDefined();
    expect(compiled.components!['DocumentEntity']!.kind).toBe('component');
    expect(compiled.components!['DocumentEntity']!.name).toBe('DocumentEntity');
  });

  it('live boundary files still classify as boundaries alongside component files', async () => {
    const compiled = await compileDsl(
      [{ name: 'widget.yaml', yaml: minimalBoundaryYaml }],
      undefined,
      [{ name: 'document.yaml', yaml: minimalComponentYaml }],
    );

    expect(compiled.boundaries).toHaveLength(1);
    expect(compiled.byBoundaryName['Widget']).toBeDefined();
    expect(Object.keys(compiled.components ?? {})).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. parameters: block parsing
// ---------------------------------------------------------------------------

describe('C1 — parameters block', () => {
  it('parses a component with typed parameters into ComponentDefinition', () => {
    const yaml = `
kind: component
name: DocEntity
parameters:
  initialStatus:
    type: string
    required: true
  statusField:
    type: string
    default: status
  maxRetries:
    type: number
    default: 3
event_catalog: []
`;
    const def = parseComponentYaml(yaml);
    expect(def.parameters).toBeDefined();
    expect(def.parameters!['initialStatus']).toEqual({ type: 'string', required: true });
    expect(def.parameters!['statusField']).toEqual({ type: 'string', default: 'status' });
    expect(def.parameters!['maxRetries']).toEqual({ type: 'number', default: 3 });
  });

  it('throws BOOT_ERR_DSL_SYNTAX for an unknown parameter type keyword', () => {
    expect(() =>
      parseComponentYaml(`
kind: component
name: BadParam
parameters:
  myField:
    type: integer
`),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });

  it('allows a parameter entry with neither default nor required (optional param)', () => {
    const def = parseComponentYaml(`
kind: component
name: Flexible
parameters:
  optionalField:
    type: boolean
`);
    expect(def.parameters!['optionalField']).toEqual({ type: 'boolean' });
  });
});

// ---------------------------------------------------------------------------
// 3. use: grammar
// ---------------------------------------------------------------------------

describe('C1 — use: grammar', () => {
  it('parses a use: array into UseEntry structures on CompiledDsl.use', async () => {
    const useMappingYaml = `
use:
  - component: DocumentEntity
    as: Document
    contract_path: /documents
    with:
      initialStatus: DRAFT
  - component: DocumentEntity
    as: ArchivedDocument
    contract_path: /archived-documents
    with:
      initialStatus: ARCHIVED
    bind:
      SiblingAlias: ConcreteTarget
`;
    const compiled = await compileDsl(
      [],
      undefined,
      undefined,
      [{ name: 'simulation.yaml', yaml: useMappingYaml }],
    );

    expect(compiled.use).toBeDefined();
    expect(compiled.use!).toHaveLength(2);
    expect(compiled.use![0]).toMatchObject({
      component: 'DocumentEntity',
      as: 'Document',
      contractPath: '/documents',
      with: { initialStatus: 'DRAFT' },
    });
    expect(compiled.use![1]).toMatchObject({
      component: 'DocumentEntity',
      as: 'ArchivedDocument',
      contractPath: '/archived-documents',
      with: { initialStatus: 'ARCHIVED' },
      bind: { SiblingAlias: 'ConcreteTarget' },
    });
  });

  it('throws BOOT_ERR_DSL_SYNTAX for use entry missing "component"', () => {
    expect(() =>
      validateUseEntries(
        [{ as: 'Doc', contract_path: '/docs' }],
        'root',
      ),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });

  it('throws BOOT_ERR_DSL_SYNTAX for use entry missing "as"', () => {
    expect(() =>
      validateUseEntries(
        [{ component: 'DocEntity', contract_path: '/docs' }],
        'root',
      ),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });

  it('throws BOOT_ERR_DSL_SYNTAX for use entry missing "contract_path"', () => {
    expect(() =>
      validateUseEntries(
        [{ component: 'DocEntity', as: 'Doc' }],
        'root',
      ),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. include: grammar
// ---------------------------------------------------------------------------

describe('C1 — include: grammar', () => {
  it('parses include: entries on a live boundary config', () => {
    const cfg = validateBoundaryConfig({
      boundary: 'Document',
      contract_path: '/documents',
      behaviors: [],
      reducers: [],
      event_catalog: [],
      include: [
        { component: 'AuditMixin', with: { actorField: 'modifiedBy' } },
      ],
    });

    expect(cfg.include).toBeDefined();
    expect(cfg.include!).toHaveLength(1);
    expect(cfg.include![0]).toMatchObject({
      component: 'AuditMixin',
      with: { actorField: 'modifiedBy' },
    });
  });

  it('throws BOOT_ERR_DSL_SYNTAX for include entry missing "component"', () => {
    expect(() =>
      validateIncludeEntries(
        [{ with: { foo: 'bar' } }],
        'root',
      ),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });

  it('parses include: on a component definition', () => {
    const def = parseComponentYaml(`
kind: component
name: ComposedEntity
include:
  - component: AuditMixin
    with:
      actorField: updatedBy
event_catalog: []
`);
    expect(def.include).toBeDefined();
    expect(def.include![0]).toMatchObject({ component: 'AuditMixin', with: { actorField: 'updatedBy' } });
  });
});

// ---------------------------------------------------------------------------
// 5. Unknown kind value
// ---------------------------------------------------------------------------

describe('C1 — unknown kind value', () => {
  it('throws BOOT_ERR_DSL_SYNTAX for a file with an unrecognised kind', () => {
    expect(() =>
      parseComponentYaml(`
kind: singleton
name: Foo
`),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Intra-component cross-reference validation (Phase-1)
// ---------------------------------------------------------------------------

describe('C1 — intra-component cross-reference validation', () => {
  it('throws BOOT_ERR_DSL_REFERENCE when a component reducer references an unknown event', () => {
    expect(() =>
      parseComponentYaml(`
kind: component
name: BrokenComponent
event_catalog:
  - type: DocumentCreated
    payload_template: {}
reducers:
  - on: DocumentDeleted
`),
    ).toThrow(BootError);
  });

  it('does not throw for a well-formed component with matching event refs', () => {
    expect(() =>
      parseComponentYaml(`
kind: component
name: GoodComponent
event_catalog:
  - type: ItemAdded
    payload_template: {}
reducers:
  - on: ItemAdded
`),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. parseUseMappingYaml direct tests
// ---------------------------------------------------------------------------

describe('C1 — parseUseMappingYaml', () => {
  it('parses a standalone use-mapping YAML into UseEntry array', () => {
    const entries = parseUseMappingYaml(`
use:
  - component: Widget
    as: SmallWidget
    contract_path: /small-widgets
`);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ component: 'Widget', as: 'SmallWidget', contractPath: '/small-widgets' });
  });

  it('throws BOOT_ERR_DSL_SYNTAX for an empty use array', () => {
    expect(() => parseUseMappingYaml('use: []')).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });
});
