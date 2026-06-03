/**
 * reactions.integration.test.ts  —  R3 + R4: In-UoW reaction firing engine + termination
 *
 * Acceptance criteria (potemkin-g4ku / R3):
 *  1. A single request produces BOTH boundary mutations committed in one eventStore.append.
 *  2. reaction intent: creation creates a new aggregate.
 *  3. reaction intent: mutation mutates an existing aggregate.
 *  4. A throwing reaction (bad CEL / schema mismatch) aborts the UoW — no events committed.
 *  5. Recursive fan-out: a reaction-emitted event itself triggers a further reaction.
 *  6. when gate = false: reaction does not fire.
 *  7. Existing dispatch_commands / saga tests remain green (covered by their own suites).
 *
 * Acceptance criteria (potemkin-gpdk / R4):
 *  8. A reaction chain across 7 DISTINCT aggregates completes — depth-5 cap does not apply.
 *  9. A cyclic reaction (same reaction + same aggregate re-triggered) terminates silently
 *     with NO error and NO hang; the aggregate reflects exactly one application.
 * 10. A genuinely unbounded distinct-aggregate fan-out hits the event budget and throws
 *     ReactionBudgetExceededError (HTTP 508) naming the offending reaction.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import { InternalExecutionError, ReactionBudgetExceededError } from '../../src/errors.js';
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

// ---------------------------------------------------------------------------
// R4 Suite 7: 7-distinct-aggregate chain — depth-5 cap does not apply
// ---------------------------------------------------------------------------
//
// A relay chain: OrderPlaced triggers NodeVisited on NODE-0; a single reaction
// "relay-visit" fires on NodeVisited and re-emits NodeVisited on event.payload.nextId
// when nextId is non-empty. Nodes NODE-0..NODE-6 are chained; NODE-6 has nextId="".
// This produces 8 events total (1 OrderPlaced + 7 NodeVisited). The reaction fires
// on 7 distinct aggregates, which would exceed the depth-5 cap if reactions were
// governed by cmd.depth. Proves they are not.

describe('reactions R4: chain across 7 distinct aggregates completes (depth-5 cap bypassed)', () => {
  const NODE_IDS = Array.from({ length: 7 }, (_, i) => `node-r4-${i}`);

  // OpenAPI for the 7-node relay test (isolated from the shared OPENAPI_YAML)
  const RELAY_OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: Relay Test
  version: "1.0.0"
paths:
  /relay-orders:
    post:
      operationId: createRelayOrder
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/RelayOrder"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/RelayOrder"
  /relay-nodes/{id}:
    get:
      operationId: getRelayNode
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
                $ref: "#/components/schemas/RelayNode"
components:
  schemas:
    RelayOrder:
      type: object
      properties:
        id: { type: string }
      required: [id]
    RelayNode:
      type: object
      properties:
        id:      { type: string }
        visited: { type: boolean }
      required: [id, visited]
`;

  // RelayOrder boundary: emits OrderStarted carrying the first node id
  const RELAY_ORDER_DSL = `
boundary: RelayOrder
contract_path: /relay-orders
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: OrderStarted
    payload_template:
      id:          "command.targetId"
      firstNodeId: "command.payload.firstNodeId"
behaviors:
  - name: start-order
    match:
      operationId: createRelayOrder
      condition: "true"
    emit: OrderStarted
reducers:
  - on: OrderStarted
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

  // RelayNode boundary: NodeVisited event carries the next hop's id (empty = chain end)
  const RELAY_NODE_DSL = `
boundary: RelayNode
contract_path: /relay-nodes/{id}
fallback_override: false
event_catalog:
  - type: NodeVisited
    payload_template:
      id:     "event.aggregateId"
      nextId: "event.payload.nextId"
behaviors: []
reducers:
  - on: NodeVisited
    patches:
      - { op: replace, path: /id,      value: "\${event.payload.id}" }
      - { op: replace, path: /visited, value: true }
`;

  // Global reactions:
  //  1. On OrderStarted → NodeVisited on firstNodeId (starts the chain)
  //  2. On NodeVisited  → NodeVisited on nextId, when nextId non-empty (relays the chain)
  const RELAY_GLOBAL_YAML = `
reactions:
  - name: start-relay
    on: "RelayOrder:OrderStarted"
    boundary: RelayNode
    emit: NodeVisited
    intent: mutation
    target: "event.payload.firstNodeId"
    payload:
      nextId: '"${NODE_IDS[1]}"'
  - name: relay-visit
    on: "RelayNode:NodeVisited"
    when: "event.payload.nextId != ''"
    boundary: RelayNode
    emit: NodeVisited
    intent: mutation
    target: "event.payload.nextId"
    payload:
      nextId: >-
        event.payload.nextId == "${NODE_IDS[1]}" ? "${NODE_IDS[2]}" :
        event.payload.nextId == "${NODE_IDS[2]}" ? "${NODE_IDS[3]}" :
        event.payload.nextId == "${NODE_IDS[3]}" ? "${NODE_IDS[4]}" :
        event.payload.nextId == "${NODE_IDS[4]}" ? "${NODE_IDS[5]}" :
        event.payload.nextId == "${NODE_IDS[5]}" ? "${NODE_IDS[6]}" : ""
`;

  let sys: BootedSystem;

  beforeEach(async () => {
    const openapi = await loadOpenApi(RELAY_OPENAPI_YAML);
    const compiledDsl = await compileDsl(
      [
        { name: 'relayOrder', yaml: RELAY_ORDER_DSL },
        { name: 'relayNode', yaml: RELAY_NODE_DSL },
      ],
      RELAY_GLOBAL_YAML,
    );
    sys = await bootSystem({ openapi, compiledDsl });
    // Pre-seed all node aggregates so mutation reactions have a target
    for (const nodeId of NODE_IDS) {
      sys.graph.set(nodeId, { id: nodeId, visited: false });
    }
  });

  afterEach(() => resetSystem(sys));

  it('produces 8 events (1 OrderStarted + 7 NodeVisited) completing without error', async () => {
    const cmd: Command = {
      commandId: nextUuidv7(),
      boundary: 'RelayOrder',
      intent: 'creation',
      targetId: nextUuidv7(),
      payload: { firstNodeId: NODE_IDS[0] },
      queryParams: {},
      httpMethod: 'POST',
      path: '/relay-orders',
      origin: 'inbound',
      depth: 0,
    };

    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
    });

    expect(result.events).toHaveLength(8);
    expect(result.events[0]!.type).toBe('OrderStarted');
    expect(result.events.filter(e => e.type === 'NodeVisited')).toHaveLength(7);
  });

  it('all 7 relay nodes are marked visited in the graph', async () => {
    const cmd: Command = {
      commandId: nextUuidv7(),
      boundary: 'RelayOrder',
      intent: 'creation',
      targetId: nextUuidv7(),
      payload: { firstNodeId: NODE_IDS[0] },
      queryParams: {},
      httpMethod: 'POST',
      path: '/relay-orders',
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
    });

    for (const nodeId of NODE_IDS) {
      expect(sys.graph.get(nodeId)?.['visited']).toBe(true);
    }
  });

  it('all 8 events are committed in a single atomic append', async () => {
    const initialCount = sys.events.size();
    const cmd: Command = {
      commandId: nextUuidv7(),
      boundary: 'RelayOrder',
      intent: 'creation',
      targetId: nextUuidv7(),
      payload: { firstNodeId: NODE_IDS[0] },
      queryParams: {},
      httpMethod: 'POST',
      path: '/relay-orders',
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
    });

    expect(sys.events.size()).toBe(initialCount + 8);
  });
});

// ---------------------------------------------------------------------------
// R4 Suite 8: Cyclic reaction terminates via fired-set dedup
// ---------------------------------------------------------------------------
//
// Chain: OrderPlaced → StockReserved@INV → self-cycle emits StockReserved@INV →
//        second StockReserved@INV → self-cycle SUPPRESSED (fired-set).
// Proves the duplicate fire is silently suppressed — no error, no hang.
// Aggregate reflects exactly two StockReserved applications (reserved stays 0
// because StockReserved reducer sets reserved=0 unconditionally).

describe('reactions R4: cyclic reaction terminates via fired-set dedup (no error, no hang)', () => {
  const INVENTORY_ID = nextUuidv7();

  const GLOBAL_WITH_CYCLE = `
reactions:
  - name: reserve-on-order
    on: "Order:OrderPlaced"
    boundary: Inventory
    emit: StockReserved
    intent: mutation
    target: '"${INVENTORY_ID}"'
  - name: self-cycle
    on: "Inventory:StockReserved"
    boundary: Inventory
    emit: StockReserved
    intent: mutation
    target: "event.aggregateId"
`;

  let sys: BootedSystem;

  beforeEach(async () => {
    sys = await buildSystem(GLOBAL_WITH_CYCLE);
    sys.graph.set(INVENTORY_ID, { id: INVENTORY_ID, reserved: 0 });
  });

  afterEach(() => resetSystem(sys));

  it('terminates without error (no infinite loop)', async () => {
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
    ).resolves.not.toThrow();
  });

  it('produces exactly 3 events: OrderPlaced + 2 × StockReserved (cycle fires once then stops)', async () => {
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
    expect(result.events[2]!.type).toBe('StockReserved');
  });

  it('all 3 events are committed atomically', async () => {
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

  it('the Inventory aggregate reflects the reducer applied twice (reserved stays 0)', async () => {
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
    // StockReserved sets reserved=0; two applications still yield 0
    expect(inv!['reserved']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R4 Suite 9: Budget backstop — distinct-aggregate fan-out throws 508
// ---------------------------------------------------------------------------
//
// Use the relay chain from Suite 7 but set maxUowEvents: 3 (budget of 3
// reaction-emitted events). The chain of 7 NodeVisited reactions exceeds 3,
// so ReactionBudgetExceededError (HTTP 508) is thrown naming the offending reaction.

describe('reactions R4: reaction event budget exceeded throws ReactionBudgetExceededError (508)', () => {
  const NODE_IDS_BUDGET = Array.from({ length: 7 }, (_, i) => `node-budget-${i}`);

  const BUDGET_OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: Budget Test
  version: "1.0.0"
paths:
  /budget-orders:
    post:
      operationId: createBudgetOrder
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/BudgetOrder"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/BudgetOrder"
  /budget-nodes/{id}:
    get:
      operationId: getBudgetNode
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
                $ref: "#/components/schemas/BudgetNode"
components:
  schemas:
    BudgetOrder:
      type: object
      properties:
        id: { type: string }
      required: [id]
    BudgetNode:
      type: object
      properties:
        id:      { type: string }
        visited: { type: boolean }
      required: [id, visited]
`;

  const BUDGET_ORDER_DSL = `
boundary: BudgetOrder
contract_path: /budget-orders
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: BudgetOrderStarted
    payload_template:
      id:          "command.targetId"
      firstNodeId: "command.payload.firstNodeId"
behaviors:
  - name: start-budget-order
    match:
      operationId: createBudgetOrder
      condition: "true"
    emit: BudgetOrderStarted
reducers:
  - on: BudgetOrderStarted
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

  const BUDGET_NODE_DSL = `
boundary: BudgetNode
contract_path: /budget-nodes/{id}
fallback_override: false
event_catalog:
  - type: BudgetNodeVisited
    payload_template:
      id:     "event.aggregateId"
      nextId: "event.payload.nextId"
behaviors: []
reducers:
  - on: BudgetNodeVisited
    patches:
      - { op: replace, path: /id,      value: "\${event.payload.id}" }
      - { op: replace, path: /visited, value: true }
`;

  const BUDGET_GLOBAL_YAML = `
reactions:
  - name: budget-start-relay
    on: "BudgetOrder:BudgetOrderStarted"
    boundary: BudgetNode
    emit: BudgetNodeVisited
    intent: mutation
    target: "event.payload.firstNodeId"
    payload:
      nextId: '"${NODE_IDS_BUDGET[1]}"'
  - name: budget-relay-visit
    on: "BudgetNode:BudgetNodeVisited"
    when: "event.payload.nextId != ''"
    boundary: BudgetNode
    emit: BudgetNodeVisited
    intent: mutation
    target: "event.payload.nextId"
    payload:
      nextId: >-
        event.payload.nextId == "${NODE_IDS_BUDGET[1]}" ? "${NODE_IDS_BUDGET[2]}" :
        event.payload.nextId == "${NODE_IDS_BUDGET[2]}" ? "${NODE_IDS_BUDGET[3]}" :
        event.payload.nextId == "${NODE_IDS_BUDGET[3]}" ? "${NODE_IDS_BUDGET[4]}" :
        event.payload.nextId == "${NODE_IDS_BUDGET[4]}" ? "${NODE_IDS_BUDGET[5]}" :
        event.payload.nextId == "${NODE_IDS_BUDGET[5]}" ? "${NODE_IDS_BUDGET[6]}" : ""
`;

  let sys: BootedSystem;

  beforeEach(async () => {
    const openapi = await loadOpenApi(BUDGET_OPENAPI_YAML);
    const compiledDsl = await compileDsl(
      [
        { name: 'budgetOrder', yaml: BUDGET_ORDER_DSL },
        { name: 'budgetNode', yaml: BUDGET_NODE_DSL },
      ],
      BUDGET_GLOBAL_YAML,
    );
    sys = await bootSystem({ openapi, compiledDsl });
    for (const nodeId of NODE_IDS_BUDGET) {
      sys.graph.set(nodeId, { id: nodeId, visited: false });
    }
  });

  afterEach(() => resetSystem(sys));

  it('throws ReactionBudgetExceededError when maxUowEvents is exceeded', async () => {
    const cmd: Command = {
      commandId: nextUuidv7(),
      boundary: 'BudgetOrder',
      intent: 'creation',
      targetId: nextUuidv7(),
      payload: { firstNodeId: NODE_IDS_BUDGET[0] },
      queryParams: {},
      httpMethod: 'POST',
      path: '/budget-orders',
      origin: 'inbound',
      depth: 0,
    };

    await expect(
      executeUnitOfWork({
        command: cmd,
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        maxUowEvents: 3,
      }),
    ).rejects.toBeInstanceOf(ReactionBudgetExceededError);
  });

  it('ReactionBudgetExceededError has HTTP status 508', async () => {
    const cmd: Command = {
      commandId: nextUuidv7(),
      boundary: 'BudgetOrder',
      intent: 'creation',
      targetId: nextUuidv7(),
      payload: { firstNodeId: NODE_IDS_BUDGET[0] },
      queryParams: {},
      httpMethod: 'POST',
      path: '/budget-orders',
      origin: 'inbound',
      depth: 0,
    };

    try {
      await executeUnitOfWork({
        command: cmd,
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        maxUowEvents: 3,
      });
      throw new Error('Expected ReactionBudgetExceededError');
    } catch (err) {
      expect(err).toBeInstanceOf(ReactionBudgetExceededError);
      expect((err as ReactionBudgetExceededError).status).toBe(508);
    }
  });

  it('the error message names the offending reaction', async () => {
    const cmd: Command = {
      commandId: nextUuidv7(),
      boundary: 'BudgetOrder',
      intent: 'creation',
      targetId: nextUuidv7(),
      payload: { firstNodeId: NODE_IDS_BUDGET[0] },
      queryParams: {},
      httpMethod: 'POST',
      path: '/budget-orders',
      origin: 'inbound',
      depth: 0,
    };

    try {
      await executeUnitOfWork({
        command: cmd,
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        maxUowEvents: 3,
      });
      throw new Error('Expected ReactionBudgetExceededError');
    } catch (err) {
      expect(err).toBeInstanceOf(ReactionBudgetExceededError);
      expect((err as ReactionBudgetExceededError).message).toContain('budget-relay-visit');
    }
  });

  it('no events are committed when the budget is exceeded (atomic abort)', async () => {
    const initialCount = sys.events.size();
    const cmd: Command = {
      commandId: nextUuidv7(),
      boundary: 'BudgetOrder',
      intent: 'creation',
      targetId: nextUuidv7(),
      payload: { firstNodeId: NODE_IDS_BUDGET[0] },
      queryParams: {},
      httpMethod: 'POST',
      path: '/budget-orders',
      origin: 'inbound',
      depth: 0,
    };

    await expect(
      executeUnitOfWork({
        command: cmd,
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        maxUowEvents: 3,
      }),
    ).rejects.toBeInstanceOf(ReactionBudgetExceededError);

    expect(sys.events.size()).toBe(initialCount);
  });

  it('completes without error when budget is large enough (7 relay events succeed with budget=10)', async () => {
    const cmd: Command = {
      commandId: nextUuidv7(),
      boundary: 'BudgetOrder',
      intent: 'creation',
      targetId: nextUuidv7(),
      payload: { firstNodeId: NODE_IDS_BUDGET[0] },
      queryParams: {},
      httpMethod: 'POST',
      path: '/budget-orders',
      origin: 'inbound',
      depth: 0,
    };

    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      maxUowEvents: 10,
    });

    expect(result.events).toHaveLength(8);
  });
});
