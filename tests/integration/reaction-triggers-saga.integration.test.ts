/**
 * reaction-triggers-saga.integration.test.ts
 *
 * Sagas must fire when triggered by a reaction-emitted event, not just by
 * behaviour-emitted events on the originating command boundary. The UoW offers
 * every committed event to findTriggeredSagas, matching on the committed EVENT's
 * boundary/intent — so a saga subscribed to a reaction boundary fires even when
 * the originating command was on a different boundary.
 *
 * Saga matching uses the committed event's boundary and a derived intent:
 * the command's intent for behaviour-emitted events on the command boundary,
 * 'mutation' for reaction/dispatch events on another boundary.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { findTriggeredSagas } from '../../src/sagas/orchestrator.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { Command } from '../../src/types.js';

const OPENAPI_YAML = `
openapi: "3.0.3"
info: { title: Reaction Saga, version: "1.0.0" }
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/Order" } } }
      responses:
        "201": { description: Created, content: { application/json: { schema: { $ref: "#/components/schemas/Order" } } } }
  /inventory/{id}:
    put:
      operationId: updateInventory
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/Inventory" } } }
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/Inventory" } } } }
    get:
      operationId: getInventory
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/Inventory" } } } }
components:
  schemas:
    Order:
      type: object
      properties: { id: { type: string }, productId: { type: string } }
      required: [id, productId]
    Inventory:
      type: object
      properties: { id: { type: string }, reserved: { type: integer } }
      required: [id, reserved]
`;

const ORDER_DSL = `
boundary: Order
contract_path: /orders
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: OrderPlaced
    payload_template:
      id: "command.targetId"
      productId: "command.payload.productId"
behaviors:
  - name: place-order
    match:
      operationId: createOrder
      condition: "true"
    emit: OrderPlaced
reducers:
  - on: OrderPlaced
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /productId, value: "\${event.payload.productId}" }
`;

const INVENTORY_DSL = `
boundary: Inventory
contract_path: /inventory/{id}
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: StockReserved
    payload_template:
      id: "event.aggregateId"
behaviors:
  - name: reserve
    match:
      operationId: updateInventory
      condition: "true"
    emit: StockReserved
reducers:
  - on: StockReserved
    patches:
      - { op: increment, path: /reserved, by: 1 }
`;

async function buildSystem(globalYaml: string): Promise<BootedSystem> {
  const openapi = await loadOpenApi(OPENAPI_YAML);
  const compiledDsl = await compileDsl(
    [
      { name: 'order', yaml: ORDER_DSL },
      { name: 'inventory', yaml: INVENTORY_DSL },
    ],
    globalYaml,
  );
  return bootSystem({ openapi, compiledDsl });
}

/** Let post-commit fire-and-forget side-effects (sagas) settle. */
async function flushSideEffects(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('saga triggers on a reaction-emitted event', () => {
  let sys: BootedSystem;
  const INVENTORY_ID = nextUuidv7();

  // Reaction: OrderPlaced -> StockReserved on Inventory boundary.
  // Saga: triggered by (boundary: Inventory, intent: mutation) StockReserved.
  const GLOBAL_YAML = `
reactions:
  - name: reserve-on-order
    on: "Order:OrderPlaced"
    boundary: Inventory
    emit: StockReserved
    intent: mutation
    target: '"${INVENTORY_ID}"'
sagas:
  - name: AuditReservation
    trigger:
      boundary: Inventory
      intent: mutation
      condition: "true"
    steps:
      - name: noop
        boundary: Inventory
        intent: mutation
        operationId: updateInventory
        target_id: '"${INVENTORY_ID}"'
        payload: {}
`;

  beforeEach(async () => {
    sys = await buildSystem(GLOBAL_YAML);
    sys.graph.set(INVENTORY_ID, { id: INVENTORY_ID, reserved: 0 });
  });

  afterEach(() => resetSystem(sys));

  function placeOrder(): Command {
    return {
      commandId: nextUuidv7(),
      boundary: 'Order',
      intent: 'creation',
      targetId: nextUuidv7(),
      payload: { productId: 'prod-1' },
      queryParams: {},
      httpMethod: 'POST',
      path: '/orders',
      origin: 'inbound',
      depth: 0,
    };
  }

  it('findTriggeredSagas matches an Inventory saga against the reaction-emitted StockReserved event', async () => {
    const cmd = placeOrder();

    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      inferredSchemas: sys.inferredSchemas,
    });

    const stockEvt = result.events.find((e) => e.type === 'StockReserved');
    expect(stockEvt).toBeDefined();
    expect(stockEvt!.boundary).toBe('Inventory');

    // The UoW passes (command, evt) to findTriggeredSagas for every committed
    // event. Matching is keyed on the EVENT's boundary, so the Inventory saga
    // matches even though the originating command was on the Order boundary.
    const matched = findTriggeredSagas(sys.dsl.sagas, cmd, stockEvt!, sys.cel);
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe('AuditReservation');
  });

  it('end-to-end: the reaction event drives the saga to actually start', async () => {
    const cmd = placeOrder();

    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      aggregateLocks: sys.aggregateLocks,
      inferredSchemas: sys.inferredSchemas,
    });

    await flushSideEffects();

    const sagaEvents = sys.events.all().filter((e) => e.boundary === '__saga__');
    const started = sagaEvents.filter((e) => e.type === 'SagaStarted');
    expect(started).toHaveLength(1);
    expect(started[0].payload['sagaName']).toBe('AuditReservation');
  });
});
