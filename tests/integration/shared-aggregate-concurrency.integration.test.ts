/**
 * shared-aggregate-concurrency.integration.test.ts
 *
 * Regression for bug xgyh: the per-aggregate serialization lock in
 * executeUnitOfWork is keyed on command.targetId (the PRIMARY aggregate only).
 * Two UoWs on DIFFERENT primary aggregates that both fire a reaction into the
 * SAME third aggregate previously acquired DIFFERENT locks and ran concurrently,
 * each computing nextSequenceVersion for the shared aggregate from the same
 * uncommitted base. On commit the second append violated the monotonic-sequence
 * invariant — a lost update that 500s the request.
 *
 * The fix serializes every write-UoW in a cascade-capable system on a shared
 * cascade lock (acquired together with the primary lock in deterministic order,
 * so it is deadlock-free). This test drives two concurrent orders that each
 * reserve stock on one shared Inventory aggregate and asserts BOTH succeed with
 * a clean monotonic sequence and the reserved count reflects both increments.
 *
 * Converted from tests/redteam/shared-aggregate-concurrency.redteam.test.ts.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { Command } from '../../src/types.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: Shared Agg Test, version: "1.0.0" }
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
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Inventory" }
components:
  schemas:
    Order:
      type: object
      properties:
        id: { type: string }
        productId: { type: string }
      required: [id, productId]
    Inventory:
      type: object
      properties:
        id: { type: string }
        reserved: { type: integer }
      required: [id, reserved]
`;

const ORDER_DSL = `
boundary: Order
contract_path: /orders
identity:
  creation:
    generate: '$uuidv7()'
event_catalog:
  - type: OrderPlaced
    payload_template:
      id: command.targetId
      productId: command.payload.productId
behaviors:
  - name: place-order
    match: { operationId: createOrder, condition: 'true' }
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
identity:
  creation:
    generate: '$uuidv7()'
event_catalog:
  - type: ReservationIncremented
    payload_template:
      id: event.aggregateId
behaviors: []
reducers:
  - on: ReservationIncremented
    patches:
      - { op: increment, path: /reserved, by: 1 }
`;

const INVENTORY_ID = nextUuidv7();

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

describe('shared-aggregate concurrency via reactions (xgyh)', () => {
  it('two concurrent orders each reserve stock; shared Inventory ends at reserved=2 with monotonic seq', async () => {
    const sys = await build();
    sys.graph.set(INVENTORY_ID, { id: INVENTORY_ID, reserved: 0 });

    const common = {
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      aggregateLocks: sys.aggregateLocks,
      inferredSchemas: sys.inferredSchemas,
    };

    const results = await Promise.allSettled([
      executeUnitOfWork({ command: order(), ...common }),
      executeUnitOfWork({ command: order(), ...common }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');

    const invEvents = sys.events.byAggregate(INVENTORY_ID);
    const seqs = invEvents.map((e) => e.sequenceVersion);
    const inv = sys.graph.get(INVENTORY_ID);

    // Both UoWs commit; the shared aggregate reflects both reservations with a
    // clean monotonic sequence (1,2) — no lost update, no non-monotonic abort.
    expect(fulfilled.length).toBe(2);
    expect(seqs).toEqual([1, 2]);
    expect(inv?.['reserved']).toBe(2);
  });

  it('no deadlock: many concurrent cascading UoWs into one shared aggregate all commit', async () => {
    // Stress the multi-lock acquisition: N concurrent orders all cascade into the
    // single shared Inventory. If the cascade lock were acquired in a way that
    // could deadlock (or hang), this never resolves; it must settle with all N
    // fulfilled and a contiguous 1..N sequence on the shared aggregate.
    const sys = await build();
    sys.graph.set(INVENTORY_ID, { id: INVENTORY_ID, reserved: 0 });

    const common = {
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      aggregateLocks: sys.aggregateLocks,
      inferredSchemas: sys.inferredSchemas,
    };

    const N = 12;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => executeUnitOfWork({ command: order(), ...common })),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(N);

    const seqs = sys.events
      .byAggregate(INVENTORY_ID)
      .map((e) => e.sequenceVersion)
      .sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(sys.graph.get(INVENTORY_ID)?.['reserved']).toBe(N);
  });
});
