/**
 * RED TEAM — combo 5: TIME-TRAVEL × REACTIONS × COMPUTED.
 *
 * Scenario: a command on Order triggers a reaction that mutates an Inventory
 * aggregate which has a COMPUTED field (available = capacity - reserved). The
 * reaction-emitted event is persisted to the Inventory aggregate's stream.
 *
 * Invariant: X-Potemkin-Read-At-Version on the Inventory aggregate, at the
 * version produced by the reaction event, must reconstruct the reaction-driven
 * state AND recompute the computed field correctly — identical to the live
 * committed state.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { rebuildEntityAtVersion } from '../../src/engine/timeTravel.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { Command } from '../../src/types.js';

const OPENAPI_YAML = `
openapi: "3.0.3"
info: { title: TT Reaction, version: "1.0.0" }
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
      properties:
        id: { type: string }
        capacity: { type: integer }
        reserved: { type: integer }
        available: { type: integer }
      required: [id, capacity, reserved]
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
state:
  computed:
    - name: available
      formula: "state.capacity - state.reserved"
      depends_on: [capacity, reserved]
event_catalog:
  - type: StockReserved
    payload_template:
      id: "event.aggregateId"
behaviors: []
reducers:
  - on: StockReserved
    patches:
      - { op: increment, path: /reserved, by: 1 }
initialization:
  - id: "00000000-0000-7000-8000-0000000000aa"
    capacity: 10
    reserved: 0
`;

const INVENTORY_FIXED_ID = '00000000-0000-7000-8000-0000000000aa';

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

describe('RED TEAM combo5: time-travel over a reaction-driven computed field', () => {
  let sys: BootedSystem;
  const INVENTORY_ID = INVENTORY_FIXED_ID;

  const GLOBAL_YAML = `
reactions:
  - name: reserve-on-order
    on: "Order:OrderPlaced"
    boundary: Inventory
    emit: StockReserved
    intent: mutation
    target: '"${INVENTORY_ID}"'
`;

  beforeEach(async () => {
    sys = await buildSystem(GLOBAL_YAML);
    // Inventory is seeded via `initialization` → a BaselineEntityCreatedEvent at
    // version 1 lives in the stream, so time-travel can reconstruct base state.
  });

  afterEach(() => resetSystem(sys));

  it('read-at-version reconstructs reaction-driven reserved AND recomputed available', async () => {
    const placeOrder = async (): Promise<void> => {
      const cmd: Command = {
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
      await executeUnitOfWork({
        command: cmd,
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        inferredSchemas: sys.inferredSchemas,
      });
    };

    // Place 3 orders → 3 reaction-driven StockReserved events on INVENTORY_ID.
    await placeOrder();
    await placeOrder();
    await placeOrder();

    // Live state: reserved=3, available=7.
    const live = sys.graph.get(INVENTORY_ID)!;
    expect(live['reserved']).toBe(3);
    expect(live['available']).toBe(7);

    // The Inventory stream: baseline (v1) + 3 reaction events (v2,v3,v4).
    const stream = sys.events.byAggregate(INVENTORY_ID);
    expect(stream).toHaveLength(4);

    const boundary = sys.dsl.byBoundaryName['Inventory']!;
    const inf = sys.inferredSchemas!['Inventory']!;

    const rebuildAt = (v: number): Record<string, unknown> | null =>
      rebuildEntityAtVersion(
        INVENTORY_ID, v, boundary, sys.events, sys.cel, undefined,
        sys.tsReducerRegistry,
        boundary.state?.computed ?? [],
        inf.computedOrder,
      );

    // v3 = baseline + 2 reaction events: reaction-driven reserved=2, and the
    // computed `available` is RECOMPUTED over the reaction-mutated state → 8.
    const atV3 = rebuildAt(3);
    expect(atV3).not.toBeNull();
    expect(atV3!['reserved']).toBe(2);
    expect(atV3!['available']).toBe(8);

    // INVARIANT (HOLDS): time-travel to the latest version equals live state,
    // including the reaction-driven mutation and the recomputed computed field.
    const atV4 = rebuildAt(4);
    expect(atV4!['reserved']).toBe(live['reserved']);
    expect(atV4!['available']).toBe(live['available']);
  });
});
