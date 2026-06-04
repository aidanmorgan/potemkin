/**
 * RED TEAM — combo 2: IDEMPOTENCY/DRY-RUN × SIDE-EFFECTS (reaction leakage).
 *
 * A dry-run (X-Potemkin-Dry-Run) must compute the would-be response WITHOUT
 * committing. Reactions fire INSIDE the UoW (staged events), so the question is
 * whether a dry-run leaks reaction-driven state into the live graph / event store.
 *
 * Invariant: after a dry-run command whose primary event triggers a reaction
 * mutating a DIFFERENT aggregate, neither the primary aggregate NOR the
 * reaction's target aggregate is mutated in the live graph, and no events are
 * appended.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { parseControlHeaders } from '../../src/http/controlHeaders.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { Command } from '../../src/types.js';

const OPENAPI_YAML = `
openapi: "3.0.3"
info: { title: DryRun Reaction, version: "1.0.0" }
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
    Order: { type: object, properties: { id: { type: string } }, required: [id] }
    Inventory: { type: object, properties: { id: { type: string }, reserved: { type: integer } }, required: [id, reserved] }
`;

const ORDER_DSL = `
boundary: Order
contract_path: /orders
fallback_override: false
identity: { creation: { generate: "$uuidv7()" } }
event_catalog:
  - type: OrderPlaced
    payload_template:
      id: "command.targetId"
behaviors:
  - name: place-order
    match: { operationId: createOrder, condition: "true" }
    emit: OrderPlaced
reducers:
  - on: OrderPlaced
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

const INVENTORY_DSL = `
boundary: Inventory
contract_path: /inventory/{id}
fallback_override: false
identity: { creation: { generate: "$uuidv7()" } }
event_catalog:
  - type: StockReserved
    payload_template:
      id: "event.aggregateId"
behaviors:
  - name: reserve
    match: { operationId: updateInventory, condition: "true" }
    emit: StockReserved
reducers:
  - on: StockReserved
    patches:
      - { op: increment, path: /reserved, by: 1 }
initialization:
  - id: "00000000-0000-7000-8000-0000000000dd"
    reserved: 0
`;

const INVENTORY_ID = '00000000-0000-7000-8000-0000000000dd';

const GLOBAL_YAML = `
reactions:
  - name: reserve-on-order
    on: "Order:OrderPlaced"
    boundary: Inventory
    emit: StockReserved
    intent: mutation
    target: '"${INVENTORY_ID}"'
`;

async function buildSystem(): Promise<BootedSystem> {
  const openapi = await loadOpenApi(OPENAPI_YAML);
  const compiledDsl = await compileDsl(
    [
      { name: 'order', yaml: ORDER_DSL },
      { name: 'inventory', yaml: INVENTORY_DSL },
    ],
    GLOBAL_YAML,
  );
  return bootSystem({ openapi, compiledDsl });
}

describe('RED TEAM combo2: dry-run does not leak reaction-driven mutations', () => {
  let sys: BootedSystem;

  beforeEach(async () => {
    sys = await buildSystem();
  });

  afterEach(() => resetSystem(sys));

  it('dry-run order leaves the reaction target Inventory unmutated and appends no events', async () => {
    const baselineEvents = sys.events.size();
    const invBefore = sys.events.byAggregate(INVENTORY_ID).length;

    const controls = parseControlHeaders({ 'x-potemkin-dry-run': 'true' });

    const cmd: Command = {
      commandId: nextUuidv7(),
      boundary: 'Order',
      intent: 'creation',
      targetId: nextUuidv7(),
      payload: {},
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
      controls,
    });

    // INVARIANT: no events appended, reaction target unmutated in the live graph.
    expect(sys.events.size()).toBe(baselineEvents);
    expect(sys.events.byAggregate(INVENTORY_ID).length).toBe(invBefore);
    expect(sys.graph.get(INVENTORY_ID)!['reserved']).toBe(0);
    // The dry-run Order aggregate must not be live either (absent → null/undefined).
    expect(sys.graph.get(cmd.targetId!) ?? null).toBeNull();
  });
});
