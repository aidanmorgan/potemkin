/**
 * RED TEAM: deterministic reset (invariant #1).
 *
 * After a COMPLEX live sequence (creations + reaction fan-out into a shared
 * aggregate + derived projections), resetSystem must return the system to a
 * state byte-identical to a FRESH boot of the same DSL (the engine's ephemeral
 * reset contract: reset == post-boot baseline). We snapshot the entire graph +
 * event log + derived projections of a fresh system and compare to the same
 * structures after running a sequence and resetting.
 */

import { bootSystem, type BootedSystem } from '../src/engine/boot.js';
import { executeUnitOfWork } from '../src/engine/uow.js';
import { resetSystem } from '../src/engine/reset.js';
import { getDerivedProjection } from '../src/projections/engine.js';
import { loadOpenApi } from '../src/contract/loader.js';
import { compileDsl } from '../src/dsl/parser.js';
import { nextUuidv7 } from '../src/ids/uuidv7.js';
import type { Command } from '../src/types.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: Reset Test, version: "1.0.0" }
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Order" }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Order" }
  /inventory/{id}:
    get:
      operationId: getInventory
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/Inventory" } } } }
components:
  schemas:
    Order: { type: object, properties: { id: { type: string }, productId: { type: string } }, required: [id, productId] }
    Inventory: { type: object, properties: { id: { type: string }, reserved: { type: integer } }, required: [id, reserved] }
`;

const ORDER_DSL = `
boundary: Order
contract_path: /orders
identity: { creation: { generate: '$uuidv7()' } }
event_catalog:
  - type: OrderPlaced
    payload_template: { id: command.targetId, productId: command.payload.productId }
  - type: BaselineEntityCreatedEvent
    payload_template: {}
behaviors:
  - name: place-order
    match: { operationId: createOrder, condition: 'true' }
    emit: OrderPlaced
reducers:
  - on: OrderPlaced
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /productId, value: "\${event.payload.productId}" }
initialization:
  - { id: seed-order-1, productId: seeded }
`;

const INVENTORY_ID = nextUuidv7();
const INVENTORY_DSL = `
boundary: Inventory
contract_path: /inventory/{id}
identity: { creation: { generate: '$uuidv7()' } }
event_catalog:
  - type: ReservationIncremented
    payload_template: { id: event.aggregateId }
behaviors: []
reducers:
  - on: ReservationIncremented
    patches:
      - { op: increment, path: /reserved, by: 1 }
initialization:
  - { id: "${INVENTORY_ID}", reserved: 0 }
`;

const GLOBAL = `
reactions:
  - name: reserve-stock
    on: "Order:OrderPlaced"
    boundary: Inventory
    emit: ReservationIncremented
    intent: mutation
    target: '"${INVENTORY_ID}"'
`;

async function build(): Promise<BootedSystem> {
  const openapi = await loadOpenApi(OPENAPI);
  const compiledDsl = await compileDsl(
    [{ name: 'order', yaml: ORDER_DSL }, { name: 'inventory', yaml: INVENTORY_DSL }],
    GLOBAL,
  );
  return bootSystem({ openapi, compiledDsl });
}

function order(): Command {
  return {
    commandId: nextUuidv7(),
    boundary: 'Order',
    intent: 'creation',
    targetId: nextUuidv7(),
    payload: { productId: 'p1' },
    queryParams: {},
    httpMethod: 'POST',
    path: '/orders',
    origin: 'inbound',
    depth: 0,
  };
}

function snapshot(sys: BootedSystem): unknown {
  const graph: Record<string, unknown> = {};
  for (const id of [...sys.graph.keys()].sort()) graph[id] = sys.graph.get(id);
  const events = sys.events.all().map((e) => ({
    boundary: e.boundary, aggregateId: e.aggregateId, type: e.type,
    seq: e.sequenceVersion, payload: e.payload,
  }));
  return { graph, events };
}

describe('REDTEAM deterministic reset', () => {
  it('reset after a complex live sequence yields a state byte-identical to a fresh boot', async () => {
    const fresh = await build();
    const freshSnap = JSON.stringify(snapshot(fresh));

    const sys = await build();
    const common = {
      dsl: sys.dsl, openapi: sys.openapi, graph: sys.graph, events: sys.events,
      cel: sys.cel, validator: sys.validator, schemaRegistry: sys.schemaRegistry,
      aggregateLocks: sys.aggregateLocks, inferredSchemas: sys.inferredSchemas,
      derivedProjections: sys.derivedProjections,
    };
    // Run several orders sequentially (each fans out a reaction into shared Inventory).
    for (let i = 0; i < 5; i++) {
      await executeUnitOfWork({ command: order(), ...common });
    }
    // Sanity: live state diverged from baseline before reset.
    expect(sys.graph.get(INVENTORY_ID)!['reserved']).toBe(5);

    resetSystem(sys);
    const resetSnap = JSON.stringify(snapshot(sys));

    // eslint-disable-next-line no-console
    console.log('REDTEAM reset: equalToFresh=', resetSnap === freshSnap);
    if (resetSnap !== freshSnap) {
      // eslint-disable-next-line no-console
      console.log('fresh=', freshSnap, '\nreset=', resetSnap);
    }

    expect(resetSnap).toBe(freshSnap);
  });
});
