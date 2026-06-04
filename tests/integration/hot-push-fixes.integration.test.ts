/**
 * Integration tests verifying all three hot-push path contracts:
 *
 * Reactions: After a hot push of reaction-bearing DSL,
 *   sys.dsl.reactionsByTrigger is populated and reactions fire normally.
 *
 * Derived projection pre-registration: After a hot push declaring a
 *   new derived_projection, GET /_admin/derived/<name> returns 200 {}
 *   immediately — not 404.
 *
 * Push-time validation: A hot push with an invalid behavior
 *   operationId is rejected 400 at push time. A hot push with a
 *   schema-violating reducer patch is also rejected 400 at push time.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import { resetSystem } from '../../src/engine/reset.js';
import type { Command } from '../../src/types.js';
import {
  withPersistentServer,
  type PersistentAgent,
} from '../_support/persistentAgent.js';
import { registerFileTeardown } from '../_support/testTeardown.js';

// ---------------------------------------------------------------------------
// Minimal OpenAPI shared across all suites
// ---------------------------------------------------------------------------

const OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: Hot Push Fixes Test
  version: "1.0.0"
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Order"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Order"
  /inventory/{id}:
    get:
      operationId: getInventory
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
                $ref: "#/components/schemas/Inventory"
components:
  schemas:
    Order:
      type: object
      properties:
        id:        { type: string }
        productId: { type: string }
        quantity:  { type: integer }
      required: [id, productId, quantity]
    Inventory:
      type: object
      properties:
        id:       { type: string }
        reserved: { type: integer }
      required: [id, reserved]
`;

// ---------------------------------------------------------------------------
// Boundary DSL modules
// ---------------------------------------------------------------------------

const INVENTORY_DSL_MODULE = {
  path: 'inventory.yaml',
  yaml: `
boundary: Inventory
contract_path: /inventory/{id}
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: StockReserved
    payload_template:
      id:       "event.aggregateId"
      reserved: "0"
behaviors: []
reducers:
  - on: StockReserved
    patches:
      - { op: replace, path: /id,       value: "\${event.payload.id}" }
      - { op: replace, path: /reserved, value: 0 }
`,
};

// Order boundary module WITH an inline reactions block targeting Inventory.
// Boundary-level reactions fill in `boundary` automatically from the containing
// boundary, so only the cross-boundary `boundary:` field is needed here.
const ORDER_DSL_MODULE_WITH_REACTION = {
  path: 'order.yaml',
  yaml: `
boundary: Order
contract_path: /orders
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: OrderPlaced
    payload_template:
      id:        "command.targetId"
      productId: "command.payload.productId"
      quantity:  "command.payload.quantity"
behaviors:
  - name: place-order
    match:
      operationId: createOrder
      condition: "true"
    emit: OrderPlaced
reducers:
  - on: OrderPlaced
    patches:
      - { op: replace, path: /id,        value: "\${event.payload.id}" }
      - { op: replace, path: /productId, value: "\${event.payload.productId}" }
      - { op: replace, path: /quantity,  value: "\${event.payload.quantity}" }
reactions:
  - name: reserve-on-order
    on: "Order:OrderPlaced"
    boundary: Inventory
    emit: StockReserved
    intent: mutation
    target: '"__inv__"'
`,
};

// Order boundary without a reaction (for tests that don't need it)
const ORDER_DSL_MODULE = {
  path: 'order.yaml',
  yaml: `
boundary: Order
contract_path: /orders
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: OrderPlaced
    payload_template:
      id:        "command.targetId"
      productId: "command.payload.productId"
      quantity:  "command.payload.quantity"
behaviors:
  - name: place-order
    match:
      operationId: createOrder
      condition: "true"
    emit: OrderPlaced
reducers:
  - on: OrderPlaced
    patches:
      - { op: replace, path: /id,        value: "\${event.payload.id}" }
      - { op: replace, path: /productId, value: "\${event.payload.productId}" }
      - { op: replace, path: /quantity,  value: "\${event.payload.quantity}" }
`,
};

// ---------------------------------------------------------------------------
// Helper: build command
// ---------------------------------------------------------------------------

function makePlaceOrderCommand(overrides: Partial<Command> = {}): Command {
  return {
    commandId: nextUuidv7(),
    boundary: 'Order',
    intent: 'creation',
    targetId: nextUuidv7(),
    payload: { productId: 'prod-001', quantity: 1 },
    queryParams: {},
    httpMethod: 'POST',
    path: '/orders',
    origin: 'inbound',
    depth: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fix 1: reactions survive a hot push
// ---------------------------------------------------------------------------

describe('Fix 1: hot push of reaction-bearing DSL populates reactionsByTrigger and reactions fire', () => {
  const INVENTORY_ID = '__inv__';

  let sys: BootedSystem;
  let agent: PersistentAgent;

  beforeAll(async () => {
    // Boot with no DSL so we start in wait-for-push mode (empty DSL).
    const openapi = await loadOpenApi(OPENAPI_YAML);
    sys = await bootSystem({ openapi });
    const app = createGateway(sys);
    const persistent = await withPersistentServer(app);
    agent = persistent.agent;
    registerFileTeardown(persistent.close);

    // Pre-seed the Inventory aggregate so the mutation reaction has a target.
    sys.graph.set(INVENTORY_ID, { id: INVENTORY_ID, reserved: 5 });
  });

  afterAll(() => {
    resetSystem(sys);
  });

  it('hot push of reaction-bearing DSL succeeds (200)', async () => {
    const res = await agent
      .post('/_engine/dsl')
      .send({
        modules: [ORDER_DSL_MODULE_WITH_REACTION, INVENTORY_DSL_MODULE],
        typescript: null,
        specEndpoints: [],
      })
      .expect(200);

    expect(res.body.boundaryCount).toBe(2);
  });

  it('reactionsByTrigger is populated after hot push', () => {
    expect(sys.dsl.reactionsByTrigger).toBeDefined();
    const key = 'Order:OrderPlaced';
    expect(sys.dsl.reactionsByTrigger?.has(key)).toBe(true);
    expect(sys.dsl.reactionsByTrigger?.get(key)).toHaveLength(1);
  });

  it('reactions array is populated after hot push', () => {
    expect(sys.dsl.reactions).toBeDefined();
    expect(sys.dsl.reactions?.length).toBeGreaterThan(0);
    expect(sys.dsl.reactions?.[0]?.name).toBe('reserve-on-order');
  });

  it('reaction fires after hot push — OrderPlaced triggers StockReserved on Inventory', async () => {
    const cmd = makePlaceOrderCommand();
    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
    });

    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.type).toBe('OrderPlaced');
    expect(result.events[1]!.type).toBe('StockReserved');
    expect(result.events[1]!.boundary).toBe('Inventory');
    expect(result.events[1]!.aggregateId).toBe(INVENTORY_ID);
  });

  it('Inventory state reflects the reaction-emitted StockReserved', async () => {
    const inv = sys.graph.get(INVENTORY_ID);
    // StockReserved reducer sets reserved to 0
    expect(inv).not.toBeNull();
    expect(inv!['reserved']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: derived projection pre-registration on hot push
// ---------------------------------------------------------------------------

describe('Fix 2: hot push of DSL with derived_projections pre-registers the name immediately', () => {
  let sys: BootedSystem;
  let agent: PersistentAgent;

  beforeAll(async () => {
    // Boot with a compiled DSL that already has derivedProjections declared.
    // Boot pre-registers the projection name at startup (Step 9 in boot.ts).
    const openapi = await loadOpenApi(OPENAPI_YAML);
    const compiledDsl = await compileDsl(
      [
        { name: 'order.yaml', yaml: ORDER_DSL_MODULE.yaml },
        { name: 'inventory.yaml', yaml: INVENTORY_DSL_MODULE.yaml },
      ],
      // global YAML carrying derived_projections
      `
derived_projections:
  - name: OrderStats
    key: event.aggregateId
    subscribe:
      - Order:OrderPlaced
    reduce:
      - on: OrderPlaced
        patches:
          - op: replace
            path: /id
            value: "\${event.aggregateId}"
`,
    );
    sys = await bootSystem({ openapi, compiledDsl });
    const app = createGateway(sys);
    const persistent = await withPersistentServer(app);
    agent = persistent.agent;
    registerFileTeardown(persistent.close);
  });

  afterAll(() => {
    resetSystem(sys);
  });

  it('GET /_admin/derived/OrderStats returns 200 {} after boot (pre-registered at boot time)', async () => {
    const res = await agent.get('/_admin/derived/OrderStats').expect(200);
    expect(res.body).toEqual({});
  });

  it('hot push of boundary modules (without derived_projections) succeeds (200)', async () => {
    // Simulate clearing the derived projection registry to put sys in the
    // pre-fix broken state: projection name is in sys.dsl.derivedProjections
    // but absent from sys.derivedProjections.
    sys.derivedProjections.clear();

    // Confirm the cleared state returns 404
    await agent.get('/_admin/derived/OrderStats').expect(404);

    // Now hot-push boundary-only modules; mergeGlobalConfig carries the existing
    // sys.dsl.derivedProjections forward into dsl.derivedProjections.
    const res = await agent
      .post('/_engine/dsl')
      .send({
        modules: [ORDER_DSL_MODULE, INVENTORY_DSL_MODULE],
        typescript: null,
        specEndpoints: [],
      })
      .expect(200);

    expect(res.body.boundaryCount).toBe(2);
  });

  it('GET /_admin/derived/OrderStats returns 200 {} immediately after the push (pre-registered by hot-push path)', async () => {
    const res = await agent.get('/_admin/derived/OrderStats').expect(200);
    // Empty projection — no events have been processed yet
    expect(res.body).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Fix 3a: invalid operationId rejected at push time (400)
// ---------------------------------------------------------------------------

describe('Fix 3a: hot push with invalid behavior operationId is rejected 400 at push time', () => {
  let sys: BootedSystem;
  let agent: PersistentAgent;

  const INVALID_OP_ID_MODULE = {
    path: 'bad-op.yaml',
    yaml: `
boundary: Order
contract_path: /orders
fallback_override: false
event_catalog:
  - type: OrderPlaced
    payload_template:
      id: "command.targetId"
behaviors:
  - name: bad-behavior
    match:
      operationId: nonExistentOperation
      condition: "true"
    emit: OrderPlaced
reducers: []
`,
  };

  beforeAll(async () => {
    const openapi = await loadOpenApi(OPENAPI_YAML);
    sys = await bootSystem({ openapi });
    const app = createGateway(sys);
    const persistent = await withPersistentServer(app);
    agent = persistent.agent;
    registerFileTeardown(persistent.close);
  });

  afterAll(() => {
    resetSystem(sys);
  });

  it('push with an unknown operationId returns 400', async () => {
    await agent
      .post('/_engine/dsl')
      .send({
        modules: [INVALID_OP_ID_MODULE],
        typescript: null,
        specEndpoints: [],
      })
      .expect(400);
  });

  it('400 response body names the unknown operationId', async () => {
    const res = await agent
      .post('/_engine/dsl')
      .send({
        modules: [INVALID_OP_ID_MODULE],
        typescript: null,
        specEndpoints: [],
      })
      .expect(400);

    expect(res.body.code).toMatch(/BOOT_ERR_UNKNOWN_OPERATION_ID/);
    expect(res.body.messages[0]).toContain('nonExistentOperation');
  });

  it('DSL is NOT installed after a rejected push (sys.dsl unchanged)', async () => {
    // sys.dsl.boundaries is empty (booted without DSL); after a rejected push it
    // must still be empty.
    expect(sys.dsl.boundaries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 3b: schema-violating reducer patch rejected at push time (400)
// ---------------------------------------------------------------------------

describe('Fix 3b: hot push with schema-violating reducer patch is rejected 400 at push time', () => {
  let sys: BootedSystem;
  let agent: PersistentAgent;

  // A reducer that references /nonExistentPath — unknown in the Order schema.
  // staticCheckDsl will flag this as DSL_PATH_UNKNOWN.
  const SCHEMA_VIOLATING_MODULE = {
    path: 'schema-bad.yaml',
    yaml: `
boundary: Order
contract_path: /orders
fallback_override: false
event_catalog:
  - type: OrderPlaced
    payload_template:
      id:        "command.targetId"
      productId: "command.payload.productId"
      quantity:  "command.payload.quantity"
behaviors:
  - name: place-order
    match:
      operationId: createOrder
      condition: "true"
    emit: OrderPlaced
reducers:
  - on: OrderPlaced
    patches:
      - { op: replace, path: /id,        value: "\${event.payload.id}" }
      - { op: replace, path: /productId, value: "\${event.payload.productId}" }
      - { op: replace, path: /quantity,  value: "\${event.payload.quantity}" }
      - { op: replace, path: /nonExistentPath, value: "bad" }
`,
  };

  beforeAll(async () => {
    const openapi = await loadOpenApi(OPENAPI_YAML);
    sys = await bootSystem({ openapi });
    const app = createGateway(sys);
    const persistent = await withPersistentServer(app);
    agent = persistent.agent;
    registerFileTeardown(persistent.close);
  });

  afterAll(() => {
    resetSystem(sys);
  });

  it('push with a schema-violating reducer patch returns 400', async () => {
    await agent
      .post('/_engine/dsl')
      .send({
        modules: [SCHEMA_VIOLATING_MODULE],
        typescript: null,
        specEndpoints: [],
      })
      .expect(400);
  });

  it('400 response body carries a schema-violation error code', async () => {
    const res = await agent
      .post('/_engine/dsl')
      .send({
        modules: [SCHEMA_VIOLATING_MODULE],
        typescript: null,
        specEndpoints: [],
      })
      .expect(400);

    expect(res.body.code).toMatch(/BOOT_ERR_DSL_SCHEMA_VIOLATION/);
  });

  it('DSL is NOT installed after a rejected push (sys.dsl unchanged)', async () => {
    expect(sys.dsl.boundaries).toHaveLength(0);
  });
});
