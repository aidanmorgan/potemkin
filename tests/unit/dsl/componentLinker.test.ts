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
 *
 * C5 coverage (cross-component reference rewriting):
 * 12. Self reaction.on ("ComponentName:Event") rewrites to "as:Event".
 * 13. Self reaction.boundary rewrites to as.
 * 14. Bare reaction.on ("Event" with no boundary prefix) is left unchanged.
 * 15. dispatch_commands.boundary targeting sibling alias rewrites to bind-mapped name.
 * 16. dispatch_commands.boundary targeting self (component name) rewrites to as.
 * 17. Unbound sibling alias in dispatch_commands throws BOOT_ERR_DSL_REFERENCE.
 * 18. Unbound sibling alias in reaction.on throws BOOT_ERR_DSL_REFERENCE.
 * 19. Two instantiations of the same component with different bind maps wire to
 *     different concrete sibling targets (the core reuse property).
 */

import { linkComponents, mergeIncludes } from '../../../src/dsl/componentLinker';
import { BootError } from '../../../src/errors';
import type { BoundaryConfig, ComponentDefinition, ReactionRule, SecondaryCommandSpec, UseEntry } from '../../../src/dsl/types';

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

// ---------------------------------------------------------------------------
// C5 tests: cross-component reference rewriting
// ---------------------------------------------------------------------------

// Helper: a component with a reaction using a qualified on trigger and a
// boundary field (both referencing the component's own name = SELF).
function makeComponentWithSelfReaction(componentName: string = 'OrderEntity'): ComponentDefinition {
  const reaction: ReactionRule = {
    on: `${componentName}:OrderPlaced`,
    boundary: componentName,
    emit: 'OrderConfirmed',
  };
  return {
    kind: 'component',
    name: componentName,
    eventCatalog: [
      { type: 'OrderPlaced', payloadTemplate: {} },
      { type: 'OrderConfirmed', payloadTemplate: {} },
    ],
    reducers: [],
    behaviors: [],
    reactions: [reaction],
  };
}

// Helper: a component whose behavior dispatches a secondary command to a sibling.
function makeComponentWithSiblingDispatch(
  componentName: string = 'OrderEntity',
  siblingAlias: string = 'Inventory',
): ComponentDefinition {
  const dispatchCmd: SecondaryCommandSpec = {
    boundary: siblingAlias,
    intent: 'mutation',
    operationId: 'reserveStock',
    targetId: 'event.payload.itemId',
  };
  return {
    kind: 'component',
    name: componentName,
    eventCatalog: [{ type: 'OrderPlaced', payloadTemplate: {} }],
    reducers: [],
    behaviors: [
      {
        name: 'place-order',
        match: { operationId: 'placeOrder', condition: 'true' },
        emit: 'OrderPlaced',
        dispatchCommands: [dispatchCmd],
      },
    ],
  };
}

// Helper: a component whose behavior dispatches a secondary command to SELF.
function makeComponentWithSelfDispatch(componentName: string = 'OrderEntity'): ComponentDefinition {
  const dispatchCmd: SecondaryCommandSpec = {
    boundary: componentName,
    intent: 'mutation',
    operationId: 'confirmOrder',
    targetId: 'event.payload.orderId',
  };
  return {
    kind: 'component',
    name: componentName,
    eventCatalog: [{ type: 'OrderPlaced', payloadTemplate: {} }],
    reducers: [],
    behaviors: [
      {
        name: 'place-order',
        match: { operationId: 'placeOrder', condition: 'true' },
        emit: 'OrderPlaced',
        dispatchCommands: [dispatchCmd],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// C5.1: Self reaction.on and reaction.boundary rewrite to `as`
// ---------------------------------------------------------------------------

describe('C5 — self reaction.on rewrites to as:Event', () => {
  it('rewrites "ComponentName:Event" in reaction.on to "as:Event"', () => {
    const component = makeComponentWithSelfReaction('OrderEntity');
    const { byBoundaryName, byContractPath } = emptyMaps();

    const result = linkComponents(
      [makeUseEntry({ component: 'OrderEntity', as: 'Order', contractPath: '/orders' })],
      { OrderEntity: component },
      byBoundaryName,
      byContractPath,
    );

    expect(result[0]!.reactions).toHaveLength(1);
    expect(result[0]!.reactions![0]!.on).toBe('Order:OrderPlaced');
  });

  it('rewrites reaction.boundary from component name to as', () => {
    const component = makeComponentWithSelfReaction('OrderEntity');
    const { byBoundaryName, byContractPath } = emptyMaps();

    const result = linkComponents(
      [makeUseEntry({ component: 'OrderEntity', as: 'Order', contractPath: '/orders' })],
      { OrderEntity: component },
      byBoundaryName,
      byContractPath,
    );

    expect(result[0]!.reactions![0]!.boundary).toBe('Order');
  });

  it('applies the correct as name for each of two instantiations', () => {
    const component = makeComponentWithSelfReaction('OrderEntity');
    const { byBoundaryName, byContractPath } = emptyMaps();

    const result = linkComponents(
      [
        makeUseEntry({ component: 'OrderEntity', as: 'DomesticOrder', contractPath: '/domestic-orders' }),
        makeUseEntry({ component: 'OrderEntity', as: 'InternationalOrder', contractPath: '/international-orders' }),
      ],
      { OrderEntity: component },
      byBoundaryName,
      byContractPath,
    );

    expect(result[0]!.reactions![0]!.on).toBe('DomesticOrder:OrderPlaced');
    expect(result[0]!.reactions![0]!.boundary).toBe('DomesticOrder');
    expect(result[1]!.reactions![0]!.on).toBe('InternationalOrder:OrderPlaced');
    expect(result[1]!.reactions![0]!.boundary).toBe('InternationalOrder');
  });
});

// ---------------------------------------------------------------------------
// C5.2: Bare reaction.on (no boundary prefix) is left unchanged
// ---------------------------------------------------------------------------

describe('C5 — bare reaction.on is left unchanged', () => {
  it('leaves "Event" (no colon) in reaction.on unchanged', () => {
    const component: ComponentDefinition = {
      kind: 'component',
      name: 'OrderEntity',
      eventCatalog: [{ type: 'OrderPlaced', payloadTemplate: {} }],
      reducers: [],
      behaviors: [],
      reactions: [{ on: 'OrderPlaced', boundary: 'OrderEntity', emit: 'OrderConfirmed' }],
    };
    const { byBoundaryName, byContractPath } = emptyMaps();

    const result = linkComponents(
      [makeUseEntry({ component: 'OrderEntity', as: 'Order', contractPath: '/orders' })],
      { OrderEntity: component },
      byBoundaryName,
      byContractPath,
    );

    expect(result[0]!.reactions![0]!.on).toBe('OrderPlaced');
  });
});

// ---------------------------------------------------------------------------
// C5.3: dispatch_commands.boundary rewrites via self and bind
// ---------------------------------------------------------------------------

describe('C5 — dispatch_commands.boundary rewrites to as (self)', () => {
  it('rewrites a self-targeting dispatch_commands.boundary to as', () => {
    const component = makeComponentWithSelfDispatch('OrderEntity');
    const { byBoundaryName, byContractPath } = emptyMaps();

    const result = linkComponents(
      [makeUseEntry({ component: 'OrderEntity', as: 'Order', contractPath: '/orders' })],
      { OrderEntity: component },
      byBoundaryName,
      byContractPath,
    );

    expect(result[0]!.behaviors[0]!.dispatchCommands![0]!.boundary).toBe('Order');
  });
});

describe('C5 — dispatch_commands.boundary rewrites sibling alias via bind', () => {
  it('rewrites a sibling alias to the concrete name from bind', () => {
    const component = makeComponentWithSiblingDispatch('OrderEntity', 'Inventory');
    const { byBoundaryName, byContractPath } = emptyMaps();

    const result = linkComponents(
      [makeUseEntry({
        component: 'OrderEntity',
        as: 'Order',
        contractPath: '/orders',
        bind: { Inventory: 'WarehouseInventory' },
      })],
      { OrderEntity: component },
      byBoundaryName,
      byContractPath,
    );

    expect(result[0]!.behaviors[0]!.dispatchCommands![0]!.boundary).toBe('WarehouseInventory');
  });
});

describe('C5 — two instantiations with different bind maps wire to different concrete siblings', () => {
  it('each instance dispatches to its own bound sibling', () => {
    const component = makeComponentWithSiblingDispatch('OrderEntity', 'Inventory');
    const { byBoundaryName, byContractPath } = emptyMaps();

    const result = linkComponents(
      [
        makeUseEntry({
          component: 'OrderEntity',
          as: 'DomesticOrder',
          contractPath: '/domestic-orders',
          bind: { Inventory: 'DomesticInventory' },
        }),
        makeUseEntry({
          component: 'OrderEntity',
          as: 'InternationalOrder',
          contractPath: '/international-orders',
          bind: { Inventory: 'InternationalInventory' },
        }),
      ],
      { OrderEntity: component },
      byBoundaryName,
      byContractPath,
    );

    expect(result[0]!.behaviors[0]!.dispatchCommands![0]!.boundary).toBe('DomesticInventory');
    expect(result[1]!.behaviors[0]!.dispatchCommands![0]!.boundary).toBe('InternationalInventory');
  });
});

// ---------------------------------------------------------------------------
// C5.4: Unbound sibling alias → BOOT_ERR_DSL_REFERENCE
// ---------------------------------------------------------------------------

describe('C5 — unbound sibling in dispatch_commands throws BOOT_ERR_DSL_REFERENCE', () => {
  it('throws BOOT_ERR_DSL_REFERENCE when dispatch boundary alias is not in bind', () => {
    const component = makeComponentWithSiblingDispatch('OrderEntity', 'Inventory');
    const { byBoundaryName, byContractPath } = emptyMaps();

    expect(() =>
      linkComponents(
        [makeUseEntry({
          component: 'OrderEntity',
          as: 'Order',
          contractPath: '/orders',
          // bind is omitted — Inventory is unbound
        })],
        { OrderEntity: component },
        byBoundaryName,
        byContractPath,
      ),
    ).toThrow(expect.objectContaining({ code: 'BOOT_ERR_DSL_REFERENCE' }));
  });

  it('error message names the unbound alias', () => {
    const component = makeComponentWithSiblingDispatch('OrderEntity', 'Inventory');
    const { byBoundaryName, byContractPath } = emptyMaps();

    try {
      linkComponents(
        [makeUseEntry({ component: 'OrderEntity', as: 'Order', contractPath: '/orders' })],
        { OrderEntity: component },
        byBoundaryName,
        byContractPath,
      );
      fail('expected BootError');
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
      expect((e as BootError).message).toContain('Inventory');
    }
  });
});

describe('C5 — unbound sibling in reaction.on throws BOOT_ERR_DSL_REFERENCE', () => {
  it('throws BOOT_ERR_DSL_REFERENCE when a reaction.on boundary prefix is not self and not in bind', () => {
    const component: ComponentDefinition = {
      kind: 'component',
      name: 'OrderEntity',
      eventCatalog: [{ type: 'StockReserved', payloadTemplate: {} }],
      reducers: [],
      behaviors: [],
      reactions: [
        // Trigger from sibling "Inventory" — but no bind supplied
        { on: 'Inventory:StockReserved', boundary: 'OrderEntity', emit: 'StockReserved' },
      ],
    };
    const { byBoundaryName, byContractPath } = emptyMaps();

    expect(() =>
      linkComponents(
        [makeUseEntry({ component: 'OrderEntity', as: 'Order', contractPath: '/orders' })],
        { OrderEntity: component },
        byBoundaryName,
        byContractPath,
      ),
    ).toThrow(expect.objectContaining({ code: 'BOOT_ERR_DSL_REFERENCE' }));
  });
});

// ---------------------------------------------------------------------------
// C5.8: a bind alias that shadows the component's own name is rejected
// ---------------------------------------------------------------------------

describe('C5 — bind alias shadowing the component self-name is rejected', () => {
  it('throws BOOT_ERR_DSL_SYNTAX when a bind key equals the component name', () => {
    const component = makeComponentWithSelfReaction('OrderEntity');
    const { byBoundaryName, byContractPath } = emptyMaps();

    expect(() =>
      linkComponents(
        [
          makeUseEntry({
            component: 'OrderEntity',
            as: 'Order',
            contractPath: '/orders',
            bind: { OrderEntity: 'SomethingElse' },
          }),
        ],
        { OrderEntity: component },
        byBoundaryName,
        byContractPath,
      ),
    ).toThrow(expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }));
  });
});

// ---------------------------------------------------------------------------
// C5.9: parameter substitution runs BEFORE reference rewriting
// (a parameterised sibling boundary name is resolved by C2, then rewritten via bind)
// ---------------------------------------------------------------------------

describe('C5 — parameterised boundary reference is substituted then rewritten', () => {
  it('resolves {{sib}} via parameters, then rewrites the resulting alias via bind', () => {
    const component: ComponentDefinition = {
      kind: 'component',
      name: 'OrderEntity',
      parameters: { sib: { type: 'string', required: true } },
      eventCatalog: [{ type: 'OrderPlaced', payloadTemplate: {} }],
      reducers: [],
      behaviors: [
        {
          name: 'place-order',
          match: { operationId: 'placeOrder', condition: 'true' },
          emit: 'OrderPlaced',
          dispatchCommands: [
            { boundary: '{{sib}}', intent: 'mutation', operationId: 'reserveStock', targetId: 'event.payload.itemId' },
          ],
        },
      ],
    };
    const { byBoundaryName, byContractPath } = emptyMaps();

    const result = linkComponents(
      [
        makeUseEntry({
          component: 'OrderEntity',
          as: 'Order',
          contractPath: '/orders',
          with: { sib: 'Warehouse' },        // {{sib}} -> "Warehouse" (C2)
          bind: { Warehouse: 'ConcreteWarehouse' }, // "Warehouse" -> "ConcreteWarehouse" (C5)
        }),
      ],
      { OrderEntity: component },
      byBoundaryName,
      byContractPath,
    );

    expect(result[0]!.behaviors![0]!.dispatchCommands![0]!.boundary).toBe('ConcreteWarehouse');
  });
});

// ---------------------------------------------------------------------------
// C4: mergeIncludes — fragment inclusion
// ---------------------------------------------------------------------------

function makeHostBoundary(overrides: Partial<BoundaryConfig> = {}): BoundaryConfig {
  return {
    boundary: 'HostBoundary',
    contractPath: '/hosts',
    fallbackOverride: false,
    behaviors: [],
    reducers: [],
    eventCatalog: [],
    ...overrides,
  };
}

function makeAuditMixin(): ComponentDefinition {
  return {
    kind: 'component',
    name: 'AuditMixin',
    eventCatalog: [{ type: 'AuditLogged', payloadTemplate: { actor: 'command.actor' } }],
    reducers: [{ on: 'AuditLogged', patches: [{ op: 'replace', path: '/lastActor', value: '${event.payload.actor}' }] }],
    behaviors: [],
  };
}

// C4.1: A boundary that includes a mixin gains the mixin's event types and reducers.
describe('C4 — mergeIncludes: boundary gains included event types and reducers', () => {
  it('appends mixin event catalog entries to the host', () => {
    const host = makeHostBoundary({
      include: [{ component: 'AuditMixin' }],
    });
    const boundaries = [host];
    const byBoundaryName = { HostBoundary: host };
    const byContractPath = { '/hosts': host };

    mergeIncludes(boundaries, { AuditMixin: makeAuditMixin() }, byBoundaryName, byContractPath);

    const merged = byBoundaryName['HostBoundary']!;
    const types = merged.eventCatalog.map((e) => e.type);
    expect(types).toContain('AuditLogged');
  });

  it('appends mixin reducer rules to the host', () => {
    const host = makeHostBoundary({
      include: [{ component: 'AuditMixin' }],
    });
    const boundaries = [host];
    const byBoundaryName = { HostBoundary: host };
    const byContractPath = { '/hosts': host };

    mergeIncludes(boundaries, { AuditMixin: makeAuditMixin() }, byBoundaryName, byContractPath);

    const merged = byBoundaryName['HostBoundary']!;
    const ons = merged.reducers.map((r) => r.on);
    expect(ons).toContain('AuditLogged');
  });

  it('registers the merged boundary in byBoundaryName', () => {
    const host = makeHostBoundary({
      include: [{ component: 'AuditMixin' }],
    });
    const boundaries = [host];
    const byBoundaryName = { HostBoundary: host };
    const byContractPath = { '/hosts': host };

    mergeIncludes(boundaries, { AuditMixin: makeAuditMixin() }, byBoundaryName, byContractPath);

    expect(byBoundaryName['HostBoundary']).toBe(boundaries[0]);
  });
});

// C4.2: Local declarations override included ones on the same key.
describe('C4 — mergeIncludes: local declaration overrides included entry on key clash', () => {
  it('keeps the local event catalog entry, not the included one', () => {
    const localEvent = { type: 'AuditLogged', payloadTemplate: { customField: "'local'" } };
    const host = makeHostBoundary({
      eventCatalog: [localEvent],
      include: [{ component: 'AuditMixin' }],
    });
    const boundaries = [host];
    const byBoundaryName = { HostBoundary: host };
    const byContractPath = { '/hosts': host };

    mergeIncludes(boundaries, { AuditMixin: makeAuditMixin() }, byBoundaryName, byContractPath);

    const merged = byBoundaryName['HostBoundary']!;
    // Only one AuditLogged entry (local wins; mixin's is suppressed).
    const matching = merged.eventCatalog.filter((e) => e.type === 'AuditLogged');
    expect(matching).toHaveLength(1);
    expect(matching[0]!.payloadTemplate['customField']).toBe("'local'");
  });

  it('appends included reducer alongside the local reducer on the same on (both present)', () => {
    const localReducer = { on: 'AuditLogged', patches: [{ op: 'replace' as const, path: '/localField', value: 'true' }] };
    const host = makeHostBoundary({
      reducers: [localReducer],
      include: [{ component: 'AuditMixin' }],
    });
    const boundaries = [host];
    const byBoundaryName = { HostBoundary: host };
    const byContractPath = { '/hosts': host };

    mergeIncludes(boundaries, { AuditMixin: makeAuditMixin() }, byBoundaryName, byContractPath);

    const merged = byBoundaryName['HostBoundary']!;
    const matching = merged.reducers.filter((r) => r.on === 'AuditLogged');
    // Both the local reducer and the included reducer coexist — reducer `on` is non-unique.
    expect(matching).toHaveLength(2);
    const paths = matching.map((r) => r.patches![0]!.path);
    expect(paths).toContain('/localField');
    expect(paths).toContain('/lastActor');
  });
});

// C4.3: Clash rules for two included fragments:
//  - event type clash → BOOT_ERR_DSL_SYNTAX (event type is a unique key)
//  - behavior name clash → BOOT_ERR_DSL_SYNTAX (behavior name is a unique key)
//  - reducer on clash → COEXIST (reducer on is a non-unique key; engine runs all matches)
describe('C4 — mergeIncludes: clash between two included fragments', () => {
  it('throws when two included components provide the same event type', () => {
    const mixin1: ComponentDefinition = {
      kind: 'component',
      name: 'MixinA',
      eventCatalog: [{ type: 'Clashing', payloadTemplate: {} }],
      reducers: [],
      behaviors: [],
    };
    const mixin2: ComponentDefinition = {
      kind: 'component',
      name: 'MixinB',
      eventCatalog: [{ type: 'Clashing', payloadTemplate: {} }],
      reducers: [],
      behaviors: [],
    };
    const host = makeHostBoundary({
      include: [{ component: 'MixinA' }, { component: 'MixinB' }],
    });
    const boundaries = [host];
    const byBoundaryName = { HostBoundary: host };
    const byContractPath = { '/hosts': host };

    expect(() =>
      mergeIncludes(boundaries, { MixinA: mixin1, MixinB: mixin2 }, byBoundaryName, byContractPath),
    ).toThrow(expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }));
  });

  it('two included components providing the same reducer on both coexist (reducer on is non-unique)', () => {
    // The engine runs ALL reducers whose `on` matches, so coexistence is correct.
    const mixin1: ComponentDefinition = {
      kind: 'component',
      name: 'MixinA',
      eventCatalog: [],
      reducers: [{ on: 'SharedEvent', patches: [{ op: 'replace', path: '/fieldA', value: 'fromA' }] }],
      behaviors: [],
    };
    const mixin2: ComponentDefinition = {
      kind: 'component',
      name: 'MixinB',
      eventCatalog: [],
      reducers: [{ on: 'SharedEvent', patches: [{ op: 'replace', path: '/fieldB', value: 'fromB' }] }],
      behaviors: [],
    };
    const host = makeHostBoundary({
      include: [{ component: 'MixinA' }, { component: 'MixinB' }],
    });
    const boundaries = [host];
    const byBoundaryName = { HostBoundary: host };
    const byContractPath = { '/hosts': host };

    expect(() =>
      mergeIncludes(boundaries, { MixinA: mixin1, MixinB: mixin2 }, byBoundaryName, byContractPath),
    ).not.toThrow();

    const merged = byBoundaryName['HostBoundary']!;
    const matching = merged.reducers.filter((r) => r.on === 'SharedEvent');
    // Both reducers are present.
    expect(matching).toHaveLength(2);
    const paths = matching.map((r) => r.patches![0]!.path);
    expect(paths).toContain('/fieldA');
    expect(paths).toContain('/fieldB');
  });

  it('does NOT throw when the host locally overrides the clashing key', () => {
    const mixin1: ComponentDefinition = {
      kind: 'component',
      name: 'MixinA',
      eventCatalog: [{ type: 'Clashing', payloadTemplate: {} }],
      reducers: [],
      behaviors: [],
    };
    const mixin2: ComponentDefinition = {
      kind: 'component',
      name: 'MixinB',
      eventCatalog: [{ type: 'Clashing', payloadTemplate: {} }],
      reducers: [],
      behaviors: [],
    };
    // The host declares Clashing locally — both mixin entries are suppressed.
    const host = makeHostBoundary({
      eventCatalog: [{ type: 'Clashing', payloadTemplate: { localField: "'yes'" } }],
      include: [{ component: 'MixinA' }, { component: 'MixinB' }],
    });
    const boundaries = [host];
    const byBoundaryName = { HostBoundary: host };
    const byContractPath = { '/hosts': host };

    expect(() =>
      mergeIncludes(boundaries, { MixinA: mixin1, MixinB: mixin2 }, byBoundaryName, byContractPath),
    ).not.toThrow();

    const merged = byBoundaryName['HostBoundary']!;
    const matching = merged.eventCatalog.filter((e) => e.type === 'Clashing');
    expect(matching).toHaveLength(1);
    expect(matching[0]!.payloadTemplate['localField']).toBe("'yes'");
  });
});

// C4.4: Unknown included component throws BOOT_ERR_DSL_REFERENCE.
describe('C4 — mergeIncludes: unknown included component throws BOOT_ERR_DSL_REFERENCE', () => {
  it('throws when the included component is not in the catalog', () => {
    const host = makeHostBoundary({
      include: [{ component: 'GhostMixin' }],
    });
    const boundaries = [host];
    const byBoundaryName = { HostBoundary: host };
    const byContractPath = { '/hosts': host };

    expect(() =>
      mergeIncludes(boundaries, {}, byBoundaryName, byContractPath),
    ).toThrow(expect.objectContaining({ code: 'BOOT_ERR_DSL_REFERENCE' }));
  });

  it('error message names the missing component', () => {
    const host = makeHostBoundary({
      include: [{ component: 'MissingMixin' }],
    });
    const boundaries = [host];
    const byBoundaryName = { HostBoundary: host };
    const byContractPath = { '/hosts': host };

    try {
      mergeIncludes(boundaries, {}, byBoundaryName, byContractPath);
      fail('expected BootError');
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
      expect((e as BootError).message).toContain('MissingMixin');
    }
  });
});

// C4.5: Parameter substitution applies to included components.
describe('C4 — mergeIncludes: parameter substitution applied via with:', () => {
  it('substitutes {{param}} tokens in included component event types', () => {
    const paramMixin: ComponentDefinition = {
      kind: 'component',
      name: 'ParamMixin',
      parameters: { prefix: { type: 'string', required: true } },
      eventCatalog: [{ type: '{{prefix}}Done', payloadTemplate: {} }],
      reducers: [{ on: '{{prefix}}Done' }],
      behaviors: [],
    };
    const host = makeHostBoundary({
      include: [{ component: 'ParamMixin', with: { prefix: 'Audit' } }],
    });
    const boundaries = [host];
    const byBoundaryName = { HostBoundary: host };
    const byContractPath = { '/hosts': host };

    mergeIncludes(boundaries, { ParamMixin: paramMixin }, byBoundaryName, byContractPath);

    const merged = byBoundaryName['HostBoundary']!;
    const types = merged.eventCatalog.map((e) => e.type);
    expect(types).toContain('AuditDone');
    const ons = merged.reducers.map((r) => r.on);
    expect(ons).toContain('AuditDone');
  });
});

// C4.6: Boundaries without include: are untouched by mergeIncludes.
describe('C4 — mergeIncludes: boundaries without include: are unmodified', () => {
  it('leaves boundaries without include: unchanged (same object reference)', () => {
    const host = makeHostBoundary(); // no include:
    const boundaries = [host];
    const byBoundaryName = { HostBoundary: host };
    const byContractPath = { '/hosts': host };

    mergeIncludes(boundaries, {}, byBoundaryName, byContractPath);

    expect(boundaries[0]).toBe(host);
    expect(byBoundaryName['HostBoundary']).toBe(host);
  });
});

// C4.7 (Defect 2): component-carried include: propagated through use: instantiation.
// linkComponents must copy the component's include field onto the concrete BoundaryConfig
// so that the subsequent mergeIncludes pass processes it.
describe('C4 — use:-instantiated boundary with component-declared include: gains mixin fragments', () => {
  it('linkComponents propagates component include: onto the concrete boundary', () => {
    // A component that declares include: AuditMixin.
    const component: ComponentDefinition = {
      kind: 'component',
      name: 'AuditedEntity',
      eventCatalog: [{ type: 'EntityCreated', payloadTemplate: {} }],
      reducers: [{ on: 'EntityCreated' }],
      behaviors: [],
      include: [{ component: 'AuditMixin' }],
    };

    const { byBoundaryName, byContractPath } = emptyMaps();
    const linked = linkComponents(
      [makeUseEntry({ component: 'AuditedEntity', as: 'MyEntity', contractPath: '/my-entities' })],
      { AuditedEntity: component },
      byBoundaryName,
      byContractPath,
    );

    // The concrete boundary must carry the include field so mergeIncludes can act on it.
    expect(linked[0]!.include).toBeDefined();
    expect(linked[0]!.include).toHaveLength(1);
    expect(linked[0]!.include![0]!.component).toBe('AuditMixin');
  });

  it('mergeIncludes then merges the mixin into the use:-instantiated boundary', () => {
    const component: ComponentDefinition = {
      kind: 'component',
      name: 'AuditedEntity',
      eventCatalog: [{ type: 'EntityCreated', payloadTemplate: {} }],
      reducers: [{ on: 'EntityCreated' }],
      behaviors: [],
      include: [{ component: 'AuditMixin' }],
    };

    const { byBoundaryName, byContractPath } = emptyMaps();
    const linked = linkComponents(
      [makeUseEntry({ component: 'AuditedEntity', as: 'MyEntity', contractPath: '/my-entities' })],
      { AuditedEntity: component },
      byBoundaryName,
      byContractPath,
    );

    // Now run the C4 merge pass.
    mergeIncludes(linked, { AuditedEntity: component, AuditMixin: makeAuditMixin() }, byBoundaryName, byContractPath);

    const merged = byBoundaryName['MyEntity']!;
    const types = merged.eventCatalog.map((e) => e.type);
    expect(types).toContain('EntityCreated');
    expect(types).toContain('AuditLogged');

    const ons = merged.reducers.map((r) => r.on);
    expect(ons).toContain('EntityCreated');
    expect(ons).toContain('AuditLogged');
  });
});
