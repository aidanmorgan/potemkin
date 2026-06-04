/**
 * Integration tests for C3: whole-boundary instantiation linker.
 *
 * Verifies:
 *  1. A single component instantiated by two use: entries produces two live
 *     boundaries with the `as` names and the bound contract_paths; both appear
 *     in the compiled byBoundaryName.
 *  2. Boot a system from such a config and assert each instance is independently
 *     created/mutated through executeUnitOfWork.
 *  3. A component alone (no use:) still yields no live boundary.
 *  4. Unknown component reference → BOOT_ERR_DSL_REFERENCE.
 *  5. Missing required parameter → BOOT_ERR_DSL_SYNTAX.
 *  6. Duplicate concrete boundary name → BOOT_ERR_DSL_DUPLICATE_BOUNDARY.
 *  7. Duplicate contract_path → BOOT_ERR_DSL_DUPLICATE_BOUNDARY.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { Command } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Shared OpenAPI spec covering two entity paths
// ---------------------------------------------------------------------------

const OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: C3 Composition Test
  version: "1.0.0"
paths:
  /items/{id}:
    post:
      operationId: createItem
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: false
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Item"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Item"
    get:
      operationId: getItem
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Item"
  /archived-items/{id}:
    post:
      operationId: createArchivedItem
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: false
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Item"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Item"
    get:
      operationId: getArchivedItem
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Item"
components:
  schemas:
    Item:
      type: object
      properties:
        id:     { type: string }
        status: { type: string }
      required: [id, status]
    ArchivedItem:
      type: object
      properties:
        id:     { type: string }
        status: { type: string }
      required: [id, status]
`;

// ---------------------------------------------------------------------------
// DSL: one component, two use: entries
// ---------------------------------------------------------------------------

const ITEM_COMPONENT_YAML = `
kind: component
name: ItemEntity
parameters:
  initialStatus:
    type: string
    required: true
event_catalog:
  - type: ItemCreated
    payload_template:
      id:     "command.targetId"
      status: "'{{initialStatus}}'"
behaviors:
  - name: create-item
    match:
      operationId: "{{operationId}}"
      condition: "true"
    emit: ItemCreated
reducers:
  - on: ItemCreated
    patches:
      - { op: replace, path: /id,     value: "\${event.payload.id}" }
      - { op: replace, path: /status, value: "\${event.payload.status}" }
`;

const ITEM_COMPONENT_WITH_OP_PARAM_YAML = `
kind: component
name: ItemEntity
parameters:
  initialStatus:
    type: string
    required: true
  operationId:
    type: string
    required: true
event_catalog:
  - type: ItemCreated
    payload_template:
      id:     "command.targetId"
      status: "'{{initialStatus}}'"
behaviors:
  - name: create-item
    match:
      operationId: "{{operationId}}"
      condition: "true"
    emit: ItemCreated
reducers:
  - on: ItemCreated
    patches:
      - { op: replace, path: /id,     value: "\${event.payload.id}" }
      - { op: replace, path: /status, value: "\${event.payload.status}" }
`;

const USE_MAPPING_YAML = `
use:
  - component: ItemEntity
    as: Item
    contract_path: /items/{id}
    with:
      initialStatus: ACTIVE
      operationId: createItem
  - component: ItemEntity
    as: ArchivedItem
    contract_path: /archived-items/{id}
    with:
      initialStatus: ARCHIVED
      operationId: createArchivedItem
`;

// ---------------------------------------------------------------------------
// Helper: compile DSL with component + use-mapping + no boundary files
// ---------------------------------------------------------------------------

async function buildComposedSystem(): Promise<{ sys: BootedSystem }> {
  const openapi = await loadOpenApi(OPENAPI_YAML);
  const compiledDsl = await compileDsl(
    [],
    undefined,
    [{ name: 'item-entity.yaml', yaml: ITEM_COMPONENT_WITH_OP_PARAM_YAML }],
    [{ name: 'simulation.yaml', yaml: USE_MAPPING_YAML }],
  );
  const sys = await bootSystem({ openapi, compiledDsl });
  return { sys };
}

function makeCreateCommand(boundary: string, path: string, operationId: string, overrides: Partial<Command> = {}): Command {
  return {
    commandId: nextUuidv7(),
    boundary,
    intent: 'creation',
    targetId: nextUuidv7(),
    payload: {},
    queryParams: {},
    httpMethod: 'POST',
    path,
    origin: 'inbound',
    depth: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: Two live boundaries in compiled output
// ---------------------------------------------------------------------------

describe('C3 — two use: entries produce two live boundaries', () => {
  it('both boundary names appear in compiledDsl.byBoundaryName', async () => {
    const compiledDsl = await compileDsl(
      [],
      undefined,
      [{ name: 'item-entity.yaml', yaml: ITEM_COMPONENT_WITH_OP_PARAM_YAML }],
      [{ name: 'simulation.yaml', yaml: USE_MAPPING_YAML }],
    );

    expect(compiledDsl.byBoundaryName['Item']).toBeDefined();
    expect(compiledDsl.byBoundaryName['ArchivedItem']).toBeDefined();
  });

  it('each boundary carries the bound contract_path', async () => {
    const compiledDsl = await compileDsl(
      [],
      undefined,
      [{ name: 'item-entity.yaml', yaml: ITEM_COMPONENT_WITH_OP_PARAM_YAML }],
      [{ name: 'simulation.yaml', yaml: USE_MAPPING_YAML }],
    );

    expect(compiledDsl.byBoundaryName['Item']!.contractPath).toBe('/items/{id}');
    expect(compiledDsl.byBoundaryName['ArchivedItem']!.contractPath).toBe('/archived-items/{id}');
  });

  it('both boundaries appear in compiledDsl.boundaries array', async () => {
    const compiledDsl = await compileDsl(
      [],
      undefined,
      [{ name: 'item-entity.yaml', yaml: ITEM_COMPONENT_WITH_OP_PARAM_YAML }],
      [{ name: 'simulation.yaml', yaml: USE_MAPPING_YAML }],
    );

    const names = compiledDsl.boundaries.map((b) => b.boundary);
    expect(names).toContain('Item');
    expect(names).toContain('ArchivedItem');
  });

  it('both boundaries are in byContractPath', async () => {
    const compiledDsl = await compileDsl(
      [],
      undefined,
      [{ name: 'item-entity.yaml', yaml: ITEM_COMPONENT_WITH_OP_PARAM_YAML }],
      [{ name: 'simulation.yaml', yaml: USE_MAPPING_YAML }],
    );

    expect(compiledDsl.byContractPath['/items/{id}']).toBeDefined();
    expect(compiledDsl.byContractPath['/archived-items/{id}']).toBeDefined();
  });

  it('the two BoundaryConfig objects are distinct (not the same reference)', async () => {
    const compiledDsl = await compileDsl(
      [],
      undefined,
      [{ name: 'item-entity.yaml', yaml: ITEM_COMPONENT_WITH_OP_PARAM_YAML }],
      [{ name: 'simulation.yaml', yaml: USE_MAPPING_YAML }],
    );

    expect(compiledDsl.byBoundaryName['Item']).not.toBe(compiledDsl.byBoundaryName['ArchivedItem']);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Each instance independently accepts commands via executeUnitOfWork
// ---------------------------------------------------------------------------

describe('C3 — each linked boundary is independently mutable', () => {
  let sys: BootedSystem;

  beforeEach(async () => {
    ({ sys } = await buildComposedSystem());
  });

  afterEach(() => { if (sys) resetSystem(sys); });

  it('a creation command on the Item boundary produces an ItemCreated event with ACTIVE status', async () => {
    const itemId = nextUuidv7();
    const cmd = makeCreateCommand('Item', `/items/${itemId}`, 'createItem', { targetId: itemId });
    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.boundary).toBe('Item');
    expect(result.events[0]!.type).toBe('ItemCreated');
    const state = sys.graph.get(itemId);
    expect(state!['status']).toBe('ACTIVE');
  });

  it('a creation command on the ArchivedItem boundary produces an ItemCreated event with ARCHIVED status', async () => {
    const itemId = nextUuidv7();
    const cmd = makeCreateCommand('ArchivedItem', `/archived-items/${itemId}`, 'createArchivedItem', { targetId: itemId });
    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.boundary).toBe('ArchivedItem');
    expect(result.events[0]!.type).toBe('ItemCreated');
    const state = sys.graph.get(itemId);
    expect(state!['status']).toBe('ARCHIVED');
  });

  it('each instance manages its own aggregate independently', async () => {
    const itemId = nextUuidv7();
    const archivedId = nextUuidv7();

    const cmd1 = makeCreateCommand('Item', `/items/${itemId}`, 'createItem', { targetId: itemId });
    const cmd2 = makeCreateCommand('ArchivedItem', `/archived-items/${archivedId}`, 'createArchivedItem', { targetId: archivedId });

    await executeUnitOfWork({ command: cmd1, dsl: sys.dsl, openapi: sys.openapi, graph: sys.graph, events: sys.events, cel: sys.cel, validator: sys.validator });
    await executeUnitOfWork({ command: cmd2, dsl: sys.dsl, openapi: sys.openapi, graph: sys.graph, events: sys.events, cel: sys.cel, validator: sys.validator });

    const item = sys.graph.get(itemId);
    const archived = sys.graph.get(archivedId);
    expect(item!['status']).toBe('ACTIVE');
    expect(archived!['status']).toBe('ARCHIVED');
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Component alone (no use:) is inert
// ---------------------------------------------------------------------------

describe('C3 — a component alone yields no live boundary', () => {
  it('compileDsl with only a component module and no use: entries produces empty byBoundaryName', async () => {
    const compiledDsl = await compileDsl(
      [],
      undefined,
      [{ name: 'item-entity.yaml', yaml: ITEM_COMPONENT_YAML }],
    );

    expect(Object.keys(compiledDsl.byBoundaryName)).toHaveLength(0);
    expect(compiledDsl.boundaries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Error cases (unknown component, missing param, duplicates)
// ---------------------------------------------------------------------------

describe('C3 — error detection during linking', () => {
  it('throws BOOT_ERR_DSL_REFERENCE for an unknown component name', async () => {
    await expect(
      compileDsl(
        [],
        undefined,
        [],
        [{ name: 'sim.yaml', yaml: `
use:
  - component: NonExistentComponent
    as: Thing
    contract_path: /things
` }],
      ),
    ).rejects.toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_REFERENCE' }),
    );
  });

  it('throws BOOT_ERR_DSL_SYNTAX for a missing required parameter', async () => {
    await expect(
      compileDsl(
        [],
        undefined,
        [{ name: 'item.yaml', yaml: ITEM_COMPONENT_WITH_OP_PARAM_YAML }],
        [{ name: 'sim.yaml', yaml: `
use:
  - component: ItemEntity
    as: Thing
    contract_path: /things
    with: {}
` }],
      ),
    ).rejects.toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }),
    );
  });

  it('throws BOOT_ERR_DSL_DUPLICATE_BOUNDARY when use.as collides with a file boundary name', async () => {
    const fileBoundaryYaml = `
boundary: Item
contract_path: /file-items
behaviors: []
reducers: []
event_catalog: []
`;
    await expect(
      compileDsl(
        [{ name: 'item.yaml', yaml: fileBoundaryYaml }],
        undefined,
        [{ name: 'component.yaml', yaml: ITEM_COMPONENT_WITH_OP_PARAM_YAML }],
        [{ name: 'sim.yaml', yaml: `
use:
  - component: ItemEntity
    as: Item
    contract_path: /linked-items/{id}
    with:
      initialStatus: ACTIVE
      operationId: createItem
` }],
      ),
    ).rejects.toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_DUPLICATE_BOUNDARY' }),
    );
  });

  it('throws BOOT_ERR_DSL_DUPLICATE_BOUNDARY when use.contractPath collides with a file boundary path', async () => {
    const fileBoundaryYaml = `
boundary: ExistingItem
contract_path: /items/{id}
behaviors: []
reducers: []
event_catalog: []
`;
    await expect(
      compileDsl(
        [{ name: 'existing.yaml', yaml: fileBoundaryYaml }],
        undefined,
        [{ name: 'component.yaml', yaml: ITEM_COMPONENT_WITH_OP_PARAM_YAML }],
        [{ name: 'sim.yaml', yaml: `
use:
  - component: ItemEntity
    as: NewItem
    contract_path: /items/{id}
    with:
      initialStatus: ACTIVE
      operationId: createItem
` }],
      ),
    ).rejects.toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_DUPLICATE_BOUNDARY' }),
    );
  });

  it('throws BOOT_ERR_DSL_DUPLICATE_BOUNDARY when two use: entries share the same as name', async () => {
    await expect(
      compileDsl(
        [],
        undefined,
        [{ name: 'component.yaml', yaml: ITEM_COMPONENT_WITH_OP_PARAM_YAML }],
        [{ name: 'sim.yaml', yaml: `
use:
  - component: ItemEntity
    as: SharedName
    contract_path: /path-a/{id}
    with:
      initialStatus: ACTIVE
      operationId: createItem
  - component: ItemEntity
    as: SharedName
    contract_path: /path-b/{id}
    with:
      initialStatus: ARCHIVED
      operationId: createArchivedItem
` }],
      ),
    ).rejects.toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_DUPLICATE_BOUNDARY' }),
    );
  });

  it('throws BOOT_ERR_DSL_DUPLICATE_BOUNDARY when two use: entries share the same contract_path', async () => {
    await expect(
      compileDsl(
        [],
        undefined,
        [{ name: 'component.yaml', yaml: ITEM_COMPONENT_WITH_OP_PARAM_YAML }],
        [{ name: 'sim.yaml', yaml: `
use:
  - component: ItemEntity
    as: NameA
    contract_path: /shared-path/{id}
    with:
      initialStatus: ACTIVE
      operationId: createItem
  - component: ItemEntity
    as: NameB
    contract_path: /shared-path/{id}
    with:
      initialStatus: ARCHIVED
      operationId: createArchivedItem
` }],
      ),
    ).rejects.toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_DUPLICATE_BOUNDARY' }),
    );
  });
});
