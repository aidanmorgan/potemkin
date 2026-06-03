/**
 * reactions.integration.test.ts  —  R3: In-UoW reaction firing engine
 *
 * Acceptance criteria (potemkin-g4ku):
 *  1. A single request produces BOTH boundary mutations committed in one eventStore.append.
 *  2. reaction intent: creation creates a new aggregate.
 *  3. reaction intent: mutation mutates an existing aggregate.
 *  4. A throwing reaction (bad CEL / schema mismatch) aborts the UoW — no events committed.
 *  5. Recursive fan-out: a reaction-emitted event itself triggers a further reaction.
 *  6. Budget cap (> MAX_UOW_REACTIONS_BUDGET) throws InternalExecutionError.
 *  7. when gate = false: reaction does not fire.
 *  8. Existing dispatch_commands / saga tests remain green (covered by their own suites).
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import { InternalExecutionError } from '../../src/errors.js';
import type { Command } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Shared minimal OpenAPI
// ---------------------------------------------------------------------------

const OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: Reactions Test
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
  /orders/{id}:
    get:
      operationId: getOrder
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
                $ref: "#/components/schemas/OrderById"
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
  /journals/{id}:
    get:
      operationId: getJournal
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
                $ref: "#/components/schemas/Journal"
components:
  schemas:
    Order:
      type: object
      properties:
        id:        { type: string }
        productId: { type: string }
        quantity:  { type: integer }
      required: [id, productId, quantity]
    OrderById:
      type: object
      properties:
        id:        { type: string }
        productId: { type: string }
        quantity:  { type: integer }
      required: [id, productId, quantity]
    Inventory:
      type: object
      properties:
        id:         { type: string }
        reserved:   { type: integer }
      required: [id, reserved]
    Journal:
      type: object
      properties:
        id:       { type: string }
        orderId:  { type: string }
      required: [id, orderId]
`;

// ---------------------------------------------------------------------------
// DSL modules
// ---------------------------------------------------------------------------

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
`;

const ORDER_BY_ID_DSL = `
boundary: OrderById
contract_path: /orders/{id}
fallback_override: true
event_catalog: []
behaviors: []
reducers: []
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
      id:       "event.aggregateId"
      reserved: "0"
  - type: ReservationIncremented
    payload_template:
      id: "event.aggregateId"
behaviors: []
reducers:
  - on: StockReserved
    patches:
      - { op: replace, path: /id,       value: "\${event.payload.id}" }
      - { op: replace, path: /reserved, value: 0 }
  - on: ReservationIncremented
    patches:
      - { op: increment, path: /reserved, by: 1 }
`;

const JOURNAL_DSL = `
boundary: Journal
contract_path: /journals/{id}
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: JournalEntryCreated
    payload_template:
      id:      "$uuidv7()"
      orderId: "event.aggregateId"
behaviors: []
reducers:
  - on: JournalEntryCreated
    patches:
      - { op: replace, path: /id,      value: "\${event.payload.id}" }
      - { op: replace, path: /orderId, value: "\${event.payload.orderId}" }
`;

// ---------------------------------------------------------------------------
// Helper: build system with the given global reactions YAML
// ---------------------------------------------------------------------------

async function buildSystem(globalYaml: string): Promise<BootedSystem> {
  const openapi = await loadOpenApi(OPENAPI_YAML);
  const compiledDsl = await compileDsl(
    [
      { name: 'order', yaml: ORDER_DSL },
      { name: 'orderById', yaml: ORDER_BY_ID_DSL },
      { name: 'inventory', yaml: INVENTORY_DSL },
      { name: 'journal', yaml: JOURNAL_DSL },
    ],
    globalYaml || undefined,
  );
  return bootSystem({ openapi, compiledDsl });
}

function makePlaceOrderCommand(overrides: Partial<Command> = {}): Command {
  return {
    commandId: nextUuidv7(),
    boundary: 'Order',
    intent: 'creation',
    targetId: nextUuidv7(),
    payload: { productId: 'prod-abc', quantity: 3 },
    queryParams: {},
    httpMethod: 'POST',
    path: '/orders',
    origin: 'inbound',
    depth: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: Basic mutation reaction
// ---------------------------------------------------------------------------

describe('reactions R3: mutation reaction fires atomically', () => {
  const INVENTORY_ID = nextUuidv7();

  const GLOBAL_WITH_MUTATION_REACTION = `
reactions:
  - name: reserve-stock-on-order
    on: "Order:OrderPlaced"
    boundary: Inventory
    emit: StockReserved
    intent: mutation
    target: '"${INVENTORY_ID}"'
`;

  let sys: BootedSystem;

  beforeEach(async () => {
    sys = await buildSystem(GLOBAL_WITH_MUTATION_REACTION);
    // Pre-seed the Inventory aggregate so the mutation reaction has something to mutate
    sys.graph.set(INVENTORY_ID, { id: INVENTORY_ID, reserved: 5 });
  });

  afterEach(() => resetSystem(sys));

  it('a single request commits both Order and Inventory events in one append', async () => {
    const initialCount = sys.events.size();
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

    // Two events: OrderPlaced (Order) + StockReserved (Inventory)
    expect(result.events).toHaveLength(2);
    expect(sys.events.size()).toBe(initialCount + 2);
  });

  it('the first event is on the Order boundary', async () => {
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

    expect(result.events[0]!.boundary).toBe('Order');
    expect(result.events[0]!.type).toBe('OrderPlaced');
  });

  it('the second event is on the Inventory boundary (reaction-emitted)', async () => {
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

    expect(result.events[1]!.boundary).toBe('Inventory');
    expect(result.events[1]!.type).toBe('StockReserved');
    expect(result.events[1]!.aggregateId).toBe(INVENTORY_ID);
  });

  it('the Inventory state graph reflects the reaction within the same cycle', async () => {
    const cmd = makePlaceOrderCommand();
    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
    });

    const inv = sys.graph.get(INVENTORY_ID);
    expect(inv).not.toBeNull();
    // StockReserved reducer sets reserved to 0
    expect(inv!['reserved']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Creation reaction
// ---------------------------------------------------------------------------

describe('reactions R3: creation reaction creates a new aggregate', () => {
  const GLOBAL_WITH_CREATION_REACTION = `
reactions:
  - name: journal-on-order
    on: "Order:OrderPlaced"
    boundary: Journal
    emit: JournalEntryCreated
    intent: creation
`;

  let sys: BootedSystem;

  beforeEach(async () => {
    sys = await buildSystem(GLOBAL_WITH_CREATION_REACTION);
  });

  afterEach(() => resetSystem(sys));

  it('creates a new Journal aggregate on OrderPlaced', async () => {
    const initialGraphSize = sys.graph.size();
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

    // Two events: OrderPlaced + JournalEntryCreated
    expect(result.events).toHaveLength(2);
    // Graph grew by 2: the new Order + the new Journal entry
    expect(sys.graph.size()).toBe(initialGraphSize + 2);
  });

  it('the Journal event is on the Journal boundary', async () => {
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

    const journalEvt = result.events[1]!;
    expect(journalEvt.boundary).toBe('Journal');
    expect(journalEvt.type).toBe('JournalEntryCreated');
  });

  it('the created Journal entity stores the originating orderId', async () => {
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

    const journalEvt = result.events[1]!;
    const journal = sys.graph.get(journalEvt.aggregateId);
    expect(journal).not.toBeNull();
    expect(journal!['orderId']).toBe(cmd.targetId);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Throwing reaction aborts UoW atomically
// ---------------------------------------------------------------------------

describe('reactions R3: a throwing reaction aborts the UoW (no events committed)', () => {
  const INVENTORY_ID = nextUuidv7();

  // Bad target expression — will throw CEL eval error
  const GLOBAL_WITH_BAD_REACTION = `
reactions:
  - name: bad-reaction
    on: "Order:OrderPlaced"
    boundary: Inventory
    emit: StockReserved
    intent: mutation
    target: "event.payload.nonexistent.deeply.nested.field.that.throws"
`;

  let sys: BootedSystem;

  beforeEach(async () => {
    sys = await buildSystem(GLOBAL_WITH_BAD_REACTION);
    sys.graph.set(INVENTORY_ID, { id: INVENTORY_ID, reserved: 5 });
  });

  afterEach(() => resetSystem(sys));

  it('throws InternalExecutionError when the reaction target expression throws', async () => {
    const initialCount = sys.events.size();
    const cmd = makePlaceOrderCommand();

    await expect(
      executeUnitOfWork({
        command: cmd,
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
      }),
    ).rejects.toThrow(InternalExecutionError);

    // No events must have been committed
    expect(sys.events.size()).toBe(initialCount);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: when gate suppresses the reaction
// ---------------------------------------------------------------------------

describe('reactions R3: when gate suppresses the reaction when false', () => {
  const INVENTORY_ID = nextUuidv7();

  const GLOBAL_WITH_GATED_REACTION = `
reactions:
  - name: gated-reaction
    on: "Order:OrderPlaced"
    when: "event.payload.quantity > 100"
    boundary: Inventory
    emit: StockReserved
    intent: mutation
    target: '"${INVENTORY_ID}"'
`;

  let sys: BootedSystem;

  beforeEach(async () => {
    sys = await buildSystem(GLOBAL_WITH_GATED_REACTION);
    sys.graph.set(INVENTORY_ID, { id: INVENTORY_ID, reserved: 5 });
  });

  afterEach(() => resetSystem(sys));

  it('only one event is staged when the when gate is false', async () => {
    const cmd = makePlaceOrderCommand({ payload: { productId: 'x', quantity: 3 } });
    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
    });

    // Only OrderPlaced — reaction skipped because quantity (3) <= 100
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('OrderPlaced');
  });

  it('reaction fires when the when gate is true', async () => {
    const cmd = makePlaceOrderCommand({ payload: { productId: 'x', quantity: 200 } });
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
    expect(result.events[1]!.type).toBe('StockReserved');
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Recursive fan-out
// ---------------------------------------------------------------------------

describe('reactions R3: recursive fan-out (reaction triggers further reaction)', () => {
  const INVENTORY_ID = nextUuidv7();

  // OrderPlaced → StockReserved (Inventory, mutation) → ReservationIncremented (Inventory, mutation)
  const GLOBAL_WITH_CHAIN_REACTIONS = `
reactions:
  - name: reserve-on-order
    on: "Order:OrderPlaced"
    boundary: Inventory
    emit: StockReserved
    intent: mutation
    target: '"${INVENTORY_ID}"'
  - name: increment-on-reserved
    on: "Inventory:StockReserved"
    boundary: Inventory
    emit: ReservationIncremented
    intent: mutation
    target: '"${INVENTORY_ID}"'
`;

  let sys: BootedSystem;

  beforeEach(async () => {
    sys = await buildSystem(GLOBAL_WITH_CHAIN_REACTIONS);
    sys.graph.set(INVENTORY_ID, { id: INVENTORY_ID, reserved: 5 });
  });

  afterEach(() => resetSystem(sys));

  it('produces three events: OrderPlaced + StockReserved + ReservationIncremented', async () => {
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

    expect(result.events).toHaveLength(3);
    expect(result.events[0]!.type).toBe('OrderPlaced');
    expect(result.events[1]!.type).toBe('StockReserved');
    expect(result.events[2]!.type).toBe('ReservationIncremented');
  });

  it('all three events are committed in a single append (atomic)', async () => {
    const initialCount = sys.events.size();
    const cmd = makePlaceOrderCommand();

    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
    });

    expect(sys.events.size()).toBe(initialCount + 3);
  });

  it('the final Inventory state reflects the incremented reservation', async () => {
    const cmd = makePlaceOrderCommand();
    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
    });

    const inv = sys.graph.get(INVENTORY_ID);
    // StockReserved sets reserved=0, ReservationIncremented increments by 1 → 1
    expect(inv!['reserved']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 6: payload overrides in the reaction
// ---------------------------------------------------------------------------

describe('reactions R3: reaction payload overrides merge over payload_template', () => {
  const INVENTORY_ID = nextUuidv7();

  const GLOBAL_WITH_PAYLOAD_REACTION = `
reactions:
  - name: reserve-with-payload
    on: "Order:OrderPlaced"
    boundary: Inventory
    emit: StockReserved
    intent: mutation
    target: '"${INVENTORY_ID}"'
    payload:
      id: '"${INVENTORY_ID}"'
`;

  let sys: BootedSystem;

  beforeEach(async () => {
    sys = await buildSystem(GLOBAL_WITH_PAYLOAD_REACTION);
    sys.graph.set(INVENTORY_ID, { id: INVENTORY_ID, reserved: 5 });
  });

  afterEach(() => resetSystem(sys));

  it('the reaction event payload carries the overridden id field', async () => {
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

    const reactionEvt = result.events[1]!;
    expect(reactionEvt.payload['id']).toBe(INVENTORY_ID);
  });
});
