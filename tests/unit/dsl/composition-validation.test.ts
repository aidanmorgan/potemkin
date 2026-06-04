/**
 * Tests for three composition-validation contracts.
 *
 * Component reaction omitting boundary defaults to the component name
 *   (and self-rewrites it to `as` at instantiation).
 *
 * include: of a component rejects unsupported sections (reactions /
 *   identity / state / nested include:) with loud BOOT_ERR_DSL_SYNTAX errors,
 *   and rejects included behaviours whose dispatchCommands.boundary is not a
 *   concrete known boundary name.
 *
 * parameters: default is type-checked; required+default is mutually
 *   exclusive; required is validated as boolean.
 */

import { parseComponentYaml } from '../../../src/dsl/parser';
import { validateComponentConfig } from '../../../src/dsl/schema';
import { linkComponents, mergeIncludes } from '../../../src/dsl/componentLinker';
import { BootError } from '../../../src/errors';
import type { BoundaryConfig, ComponentDefinition, UseEntry } from '../../../src/dsl/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyMaps(): {
  byBoundaryName: Record<string, BoundaryConfig>;
  byContractPath: Record<string, BoundaryConfig>;
} {
  return { byBoundaryName: {}, byContractPath: {} };
}

function makeUseEntry(overrides: Partial<UseEntry> = {}): UseEntry {
  return {
    component: 'TestEntity',
    as: 'MyEntity',
    contractPath: '/my-entities',
    ...overrides,
  };
}

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
// Component reaction with no explicit boundary
// ---------------------------------------------------------------------------

describe('component reaction omitting boundary defaults to the component name', () => {
  it('a component reaction with no boundary: boots clean without a misleading global-config error', () => {
    expect(() =>
      validateComponentConfig({
        kind: 'component',
        name: 'WidgetEntity',
        event_catalog: [
          { type: 'WidgetCreated', payload_template: {} },
          { type: 'WidgetNotified', payload_template: {} },
        ],
        reducers: [],
        behaviors: [],
        reactions: [
          // No boundary field — should default to "WidgetEntity"
          { on: 'WidgetCreated', emit: 'WidgetNotified' },
        ],
      }),
    ).not.toThrow();
  });

  it('the defaulted boundary is the component name', () => {
    const def = validateComponentConfig({
      kind: 'component',
      name: 'WidgetEntity',
      event_catalog: [
        { type: 'WidgetCreated', payload_template: {} },
        { type: 'WidgetNotified', payload_template: {} },
      ],
      reducers: [],
      behaviors: [],
      reactions: [
        { on: 'WidgetCreated', emit: 'WidgetNotified' },
      ],
    });

    expect(def.reactions).toHaveLength(1);
    expect(def.reactions![0]!.boundary).toBe('WidgetEntity');
  });

  it('the defaulted boundary is rewritten to the as alias when instantiated via use:', () => {
    const component: ComponentDefinition = {
      kind: 'component',
      name: 'WidgetEntity',
      eventCatalog: [
        { type: 'WidgetCreated', payloadTemplate: {} },
        { type: 'WidgetNotified', payloadTemplate: {} },
      ],
      reducers: [],
      behaviors: [],
      // boundary defaults to component name at parse time (schema fix)
      reactions: [{ on: 'WidgetEntity:WidgetCreated', boundary: 'WidgetEntity', emit: 'WidgetNotified' }],
    };

    const { byBoundaryName, byContractPath } = emptyMaps();
    const result = linkComponents(
      [makeUseEntry({ component: 'WidgetEntity', as: 'Widget', contractPath: '/widgets' })],
      { WidgetEntity: component },
      byBoundaryName,
      byContractPath,
    );

    expect(result[0]!.reactions).toHaveLength(1);
    expect(result[0]!.reactions![0]!.boundary).toBe('Widget');
    expect(result[0]!.reactions![0]!.on).toBe('Widget:WidgetCreated');
  });

  it('parseComponentYaml: reaction without boundary does not throw misleading global-config error', () => {
    expect(() =>
      parseComponentYaml(`
kind: component
name: NoBoundaryReaction
event_catalog:
  - type: SomethingHappened
    payload_template: {}
  - type: ResponseEmitted
    payload_template: {}
reducers: []
behaviors: []
reactions:
  - on: SomethingHappened
    emit: ResponseEmitted
`),
    ).not.toThrow();
  });

  it('parseComponentYaml: omitted reaction boundary defaults to the component name', () => {
    const def = parseComponentYaml(`
kind: component
name: NoBoundaryReaction
event_catalog:
  - type: SomethingHappened
    payload_template: {}
  - type: ResponseEmitted
    payload_template: {}
reducers: []
behaviors: []
reactions:
  - on: SomethingHappened
    emit: ResponseEmitted
`);

    expect(def.reactions![0]!.boundary).toBe('NoBoundaryReaction');
  });
});

// ---------------------------------------------------------------------------
// include: rejects unsupported sections with loud errors
// ---------------------------------------------------------------------------

describe('include: rejects an included component that has reactions', () => {
  it('throws BOOT_ERR_DSL_SYNTAX naming "reactions"', () => {
    const mixin: ComponentDefinition = {
      kind: 'component',
      name: 'ReactiveMixin',
      eventCatalog: [{ type: 'MixinEvent', payloadTemplate: {} }],
      reducers: [],
      behaviors: [],
      reactions: [{ on: 'MixinEvent', boundary: 'ReactiveMixin', emit: 'MixinEvent' }],
    };

    const host = stubBoundary('HostBoundary', '/hosts');
    const hostWithInclude: BoundaryConfig = {
      ...host,
      include: [{ component: 'ReactiveMixin' }],
    };
    const boundaries = [hostWithInclude];
    const byBoundaryName = { HostBoundary: hostWithInclude };
    const byContractPath = { '/hosts': hostWithInclude };

    expect(() =>
      mergeIncludes(boundaries, { ReactiveMixin: mixin }, byBoundaryName, byContractPath),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });

  it('error message names the unsupported section "reactions"', () => {
    const mixin: ComponentDefinition = {
      kind: 'component',
      name: 'ReactiveMixin',
      eventCatalog: [],
      reducers: [],
      behaviors: [],
      reactions: [{ on: 'SomeEvent', boundary: 'ReactiveMixin', emit: 'SomeEvent' }],
    };

    const host = stubBoundary('HostBoundary', '/hosts');
    const hostWithInclude: BoundaryConfig = {
      ...host,
      include: [{ component: 'ReactiveMixin' }],
    };
    const boundaries = [hostWithInclude];
    const byBoundaryName = { HostBoundary: hostWithInclude };
    const byContractPath = { '/hosts': hostWithInclude };

    try {
      mergeIncludes(boundaries, { ReactiveMixin: mixin }, byBoundaryName, byContractPath);
      fail('expected BootError');
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
      expect((e as BootError).message).toContain('reactions');
      expect((e as BootError).message).toContain('ReactiveMixin');
    }
  });
});

describe('include: composes identity from a fragment when the host has none', () => {
  it('merges the fragment identity onto the host boundary', () => {
    const mixin: ComponentDefinition = {
      kind: 'component',
      name: 'IdentityMixin',
      eventCatalog: [],
      reducers: [],
      behaviors: [],
      identity: { creation: { generate: 'uuid' } },
    };

    const host = stubBoundary('HostBoundary', '/hosts');
    const hostWithInclude: BoundaryConfig = {
      ...host,
      include: [{ component: 'IdentityMixin' }],
    };
    const boundaries = [hostWithInclude];
    const byBoundaryName = { HostBoundary: hostWithInclude };
    const byContractPath = { '/hosts': hostWithInclude };

    mergeIncludes(boundaries, { IdentityMixin: mixin }, byBoundaryName, byContractPath);

    expect(boundaries[0]!.identity).toEqual({ creation: { generate: 'uuid' } });
  });

  it('clashes when both the host and a fragment declare identity', () => {
    const mixin: ComponentDefinition = {
      kind: 'component',
      name: 'IdentityMixin',
      eventCatalog: [],
      reducers: [],
      behaviors: [],
      identity: { creation: { generate: 'uuid' } },
    };

    const host = stubBoundary('HostBoundary', '/hosts');
    const hostWithInclude: BoundaryConfig = {
      ...host,
      identity: { creation: { generate: 'uuid' } },
      include: [{ component: 'IdentityMixin' }],
    };
    const boundaries = [hostWithInclude];
    const byBoundaryName = { HostBoundary: hostWithInclude };
    const byContractPath = { '/hosts': hostWithInclude };

    expect(() =>
      mergeIncludes(boundaries, { IdentityMixin: mixin }, byBoundaryName, byContractPath),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });
});

describe('include: composes the schema name from a fragment', () => {
  it('merges the fragment schema name onto the host boundary', () => {
    const mixin: ComponentDefinition = {
      kind: 'component',
      name: 'SchemaMixin',
      eventCatalog: [],
      reducers: [],
      behaviors: [],
      schema: 'sharedCustomer',
    };

    const host = stubBoundary('HostBoundary', '/hosts');
    const hostWithInclude: BoundaryConfig = {
      ...host,
      include: [{ component: 'SchemaMixin' }],
    };
    const boundaries = [hostWithInclude];
    const byBoundaryName = { HostBoundary: hostWithInclude };
    const byContractPath = { '/hosts': hostWithInclude };

    mergeIncludes(boundaries, { SchemaMixin: mixin }, byBoundaryName, byContractPath);

    expect(boundaries[0]!.schema).toBe('sharedCustomer');
  });

  it('clashes when both the host and a fragment declare a schema name', () => {
    const mixin: ComponentDefinition = {
      kind: 'component',
      name: 'SchemaMixin',
      eventCatalog: [],
      reducers: [],
      behaviors: [],
      schema: 'sharedCustomer',
    };

    const host = stubBoundary('HostBoundary', '/hosts');
    const hostWithInclude: BoundaryConfig = {
      ...host,
      schema: 'localCustomer',
      include: [{ component: 'SchemaMixin' }],
    };
    const boundaries = [hostWithInclude];
    const byBoundaryName = { HostBoundary: hostWithInclude };
    const byContractPath = { '/hosts': hostWithInclude };

    expect(() =>
      mergeIncludes(boundaries, { SchemaMixin: mixin }, byBoundaryName, byContractPath),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });
});

describe('include: composes state fields from a fragment', () => {
  it('unions the fragment state fields onto the host boundary', () => {
    const mixin: ComponentDefinition = {
      kind: 'component',
      name: 'StateMixin',
      eventCatalog: [],
      reducers: [],
      behaviors: [],
      state: { computed: [{ name: 'total', formula: '0', dependsOn: [] }] },
    };

    const host = stubBoundary('HostBoundary', '/hosts');
    const hostWithInclude: BoundaryConfig = {
      ...host,
      include: [{ component: 'StateMixin' }],
    };
    const boundaries = [hostWithInclude];
    const byBoundaryName = { HostBoundary: hostWithInclude };
    const byContractPath = { '/hosts': hostWithInclude };

    mergeIncludes(boundaries, { StateMixin: mixin }, byBoundaryName, byContractPath);

    expect(boundaries[0]!.state?.computed).toEqual([{ name: 'total', formula: '0', dependsOn: [] }]);
  });

  it('clashes when two sources declare the same state field name', () => {
    const mixin: ComponentDefinition = {
      kind: 'component',
      name: 'StateMixin',
      eventCatalog: [],
      reducers: [],
      behaviors: [],
      state: { computed: [{ name: 'total', formula: '0', dependsOn: [] }] },
    };

    const host = stubBoundary('HostBoundary', '/hosts');
    const hostWithInclude: BoundaryConfig = {
      ...host,
      state: { computed: [{ name: 'total', formula: '1', dependsOn: [] }] },
      include: [{ component: 'StateMixin' }],
    };
    const boundaries = [hostWithInclude];
    const byBoundaryName = { HostBoundary: hostWithInclude };
    const byContractPath = { '/hosts': hostWithInclude };

    expect(() =>
      mergeIncludes(boundaries, { StateMixin: mixin }, byBoundaryName, byContractPath),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });
});

describe('include: rejects an included component that has nested include:', () => {
  it('throws BOOT_ERR_DSL_SYNTAX naming the nested "include"', () => {
    const mixin: ComponentDefinition = {
      kind: 'component',
      name: 'NestedIncludeMixin',
      eventCatalog: [],
      reducers: [],
      behaviors: [],
      include: [{ component: 'AnotherMixin' }],
    };

    const host = stubBoundary('HostBoundary', '/hosts');
    const hostWithInclude: BoundaryConfig = {
      ...host,
      include: [{ component: 'NestedIncludeMixin' }],
    };
    const boundaries = [hostWithInclude];
    const byBoundaryName = { HostBoundary: hostWithInclude };
    const byContractPath = { '/hosts': hostWithInclude };

    expect(() =>
      mergeIncludes(boundaries, { NestedIncludeMixin: mixin }, byBoundaryName, byContractPath),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });
});

describe('include: rejects an included behavior whose dispatch boundary is not a known concrete boundary', () => {
  it('throws BOOT_ERR_DSL_SYNTAX when dispatch boundary is not in byBoundaryName', () => {
    const mixin: ComponentDefinition = {
      kind: 'component',
      name: 'DispatchMixin',
      eventCatalog: [{ type: 'MixinDone', payloadTemplate: {} }],
      reducers: [],
      behaviors: [
        {
          name: 'dispatch-to-alias',
          match: { operationId: 'doSomething', condition: 'true' },
          emit: 'MixinDone',
          dispatchCommands: [
            {
              boundary: 'SomeAlias',  // not a concrete known boundary
              intent: 'mutation',
              operationId: 'handleIt',
              targetId: 'event.payload.id',
            },
          ],
        },
      ],
    };

    const host = stubBoundary('HostBoundary', '/hosts');
    const hostWithInclude: BoundaryConfig = {
      ...host,
      include: [{ component: 'DispatchMixin' }],
    };
    const boundaries = [hostWithInclude];
    // byBoundaryName does NOT contain 'SomeAlias'
    const byBoundaryName: Record<string, BoundaryConfig> = { HostBoundary: hostWithInclude };
    const byContractPath = { '/hosts': hostWithInclude };

    expect(() =>
      mergeIncludes(boundaries, { DispatchMixin: mixin }, byBoundaryName, byContractPath),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });

  it('error message names the non-concrete boundary alias', () => {
    const mixin: ComponentDefinition = {
      kind: 'component',
      name: 'DispatchMixin',
      eventCatalog: [{ type: 'MixinDone', payloadTemplate: {} }],
      reducers: [],
      behaviors: [
        {
          name: 'dispatch-to-alias',
          match: { operationId: 'doSomething', condition: 'true' },
          emit: 'MixinDone',
          dispatchCommands: [
            {
              boundary: 'UnresolvableAlias',
              intent: 'mutation',
              operationId: 'handleIt',
              targetId: 'event.payload.id',
            },
          ],
        },
      ],
    };

    const host = stubBoundary('HostBoundary', '/hosts');
    const hostWithInclude: BoundaryConfig = {
      ...host,
      include: [{ component: 'DispatchMixin' }],
    };
    const boundaries = [hostWithInclude];
    const byBoundaryName: Record<string, BoundaryConfig> = { HostBoundary: hostWithInclude };
    const byContractPath = { '/hosts': hostWithInclude };

    try {
      mergeIncludes(boundaries, { DispatchMixin: mixin }, byBoundaryName, byContractPath);
      fail('expected BootError');
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
      expect((e as BootError).message).toContain('UnresolvableAlias');
    }
  });

  it('allows included behaviors with a dispatch boundary that IS a concrete known boundary', () => {
    const concreteBoundary = stubBoundary('ConcreteTarget', '/concrete');
    const mixin: ComponentDefinition = {
      kind: 'component',
      name: 'ConcreteMixin',
      eventCatalog: [{ type: 'MixinDone', payloadTemplate: {} }],
      reducers: [],
      behaviors: [
        {
          name: 'dispatch-to-concrete',
          match: { operationId: 'doSomething', condition: 'true' },
          emit: 'MixinDone',
          dispatchCommands: [
            {
              boundary: 'ConcreteTarget',  // a concrete known boundary
              intent: 'mutation',
              operationId: 'handleIt',
              targetId: 'event.payload.id',
            },
          ],
        },
      ],
    };

    const host = stubBoundary('HostBoundary', '/hosts');
    const hostWithInclude: BoundaryConfig = {
      ...host,
      include: [{ component: 'ConcreteMixin' }],
    };
    const boundaries = [hostWithInclude];
    const byBoundaryName: Record<string, BoundaryConfig> = {
      HostBoundary: hostWithInclude,
      ConcreteTarget: concreteBoundary,
    };
    const byContractPath = { '/hosts': hostWithInclude, '/concrete': concreteBoundary };

    expect(() =>
      mergeIncludes(boundaries, { ConcreteMixin: mixin }, byBoundaryName, byContractPath),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parameters: default type-check, required+default mutual exclusion,
//        required must be boolean
// ---------------------------------------------------------------------------

describe('parameter default type mismatch halts boot', () => {
  it('throws BOOT_ERR_DSL_SYNTAX when default is string but type is number', () => {
    expect(() =>
      validateComponentConfig({
        kind: 'component',
        name: 'BadDefault',
        parameters: {
          count: { type: 'number', default: 'not-a-number' },
        },
        event_catalog: [],
        reducers: [],
        behaviors: [],
      }),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });

  it('error message names the parameter with a mismatched default', () => {
    try {
      validateComponentConfig({
        kind: 'component',
        name: 'BadDefault',
        parameters: {
          myParam: { type: 'number', default: 'oops' },
        },
        event_catalog: [],
        reducers: [],
        behaviors: [],
      });
      fail('expected BootError');
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
      expect((e as BootError).message).toContain('myParam');
    }
  });

  it('throws BOOT_ERR_DSL_SYNTAX when default is number but type is boolean', () => {
    expect(() =>
      validateComponentConfig({
        kind: 'component',
        name: 'BadDefault',
        parameters: {
          flag: { type: 'boolean', default: 1 },
        },
        event_catalog: [],
        reducers: [],
        behaviors: [],
      }),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });

  it('throws BOOT_ERR_DSL_SYNTAX when default is boolean but type is string', () => {
    expect(() =>
      validateComponentConfig({
        kind: 'component',
        name: 'BadDefault',
        parameters: {
          label: { type: 'string', default: true },
        },
        event_catalog: [],
        reducers: [],
        behaviors: [],
      }),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });

  it('accepts a default whose type matches the declared type', () => {
    expect(() =>
      validateComponentConfig({
        kind: 'component',
        name: 'GoodDefault',
        parameters: {
          count: { type: 'number', default: 42 },
          label: { type: 'string', default: 'hello' },
          flag: { type: 'boolean', default: false },
        },
        event_catalog: [],
        reducers: [],
        behaviors: [],
      }),
    ).not.toThrow();
  });
});

describe('required: true and default are mutually exclusive', () => {
  it('throws BOOT_ERR_DSL_SYNTAX when both required: true and default are present', () => {
    expect(() =>
      validateComponentConfig({
        kind: 'component',
        name: 'BadParam',
        parameters: {
          myField: { type: 'string', required: true, default: 'fallback' },
        },
        event_catalog: [],
        reducers: [],
        behaviors: [],
      }),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });

  it('error message mentions mutual exclusivity', () => {
    try {
      validateComponentConfig({
        kind: 'component',
        name: 'BadParam',
        parameters: {
          field: { type: 'string', required: true, default: 'x' },
        },
        event_catalog: [],
        reducers: [],
        behaviors: [],
      });
      fail('expected BootError');
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
      expect((e as BootError).message).toContain('mutually exclusive');
    }
  });

  it('allows required: true without default', () => {
    expect(() =>
      validateComponentConfig({
        kind: 'component',
        name: 'RequiredOnly',
        parameters: {
          field: { type: 'string', required: true },
        },
        event_catalog: [],
        reducers: [],
        behaviors: [],
      }),
    ).not.toThrow();
  });

  it('allows default without required', () => {
    expect(() =>
      validateComponentConfig({
        kind: 'component',
        name: 'DefaultOnly',
        parameters: {
          field: { type: 'string', default: 'fallback' },
        },
        event_catalog: [],
        reducers: [],
        behaviors: [],
      }),
    ).not.toThrow();
  });

  it('allows required: false with default (not mutually exclusive — only required: true triggers the guard)', () => {
    expect(() =>
      validateComponentConfig({
        kind: 'component',
        name: 'RequiredFalseWithDefault',
        parameters: {
          field: { type: 'string', required: false, default: 'fallback' },
        },
        event_catalog: [],
        reducers: [],
        behaviors: [],
      }),
    ).not.toThrow();
  });
});

describe('required must be a boolean', () => {
  it('throws BOOT_ERR_DSL_SYNTAX when required is a string', () => {
    expect(() =>
      validateComponentConfig({
        kind: 'component',
        name: 'BadRequired',
        parameters: {
          field: { type: 'string', required: 'yes' },
        },
        event_catalog: [],
        reducers: [],
        behaviors: [],
      }),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });

  it('throws BOOT_ERR_DSL_SYNTAX when required is a number', () => {
    expect(() =>
      validateComponentConfig({
        kind: 'component',
        name: 'BadRequired',
        parameters: {
          field: { type: 'string', required: 1 },
        },
        event_catalog: [],
        reducers: [],
        behaviors: [],
      }),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });

  it('throws BOOT_ERR_DSL_SYNTAX when required is "no" (string, not boolean)', () => {
    expect(() =>
      validateComponentConfig({
        kind: 'component',
        name: 'BadRequired',
        parameters: {
          field: { type: 'string', required: 'no' },
        },
        event_catalog: [],
        reducers: [],
        behaviors: [],
      }),
    ).toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });

  it('accepts required: true (boolean true)', () => {
    expect(() =>
      validateComponentConfig({
        kind: 'component',
        name: 'GoodRequired',
        parameters: {
          field: { type: 'string', required: true },
        },
        event_catalog: [],
        reducers: [],
        behaviors: [],
      }),
    ).not.toThrow();
  });

  it('accepts required: false (boolean false)', () => {
    expect(() =>
      validateComponentConfig({
        kind: 'component',
        name: 'GoodRequired',
        parameters: {
          field: { type: 'string', required: false, default: 'x' },
        },
        event_catalog: [],
        reducers: [],
        behaviors: [],
      }),
    ).not.toThrow();
  });
});
