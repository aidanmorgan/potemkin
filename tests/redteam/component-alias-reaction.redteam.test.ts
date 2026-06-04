/**
 * RED TEAM — combo 8: COMPONENTS/use × REACTIONS.
 *
 * Scenario: a component "Tracker" declares a reaction that reacts to
 * "Order:OrderPlaced" and emits "Tracked" onto its SELF boundary. It is
 * instantiated via use: as the concrete boundary "Audit" (contract_path
 * /audits/{id}). The reaction's reacting `boundary` is the component self-name
 * and must be rewritten to "Audit".
 *
 * Invariant: at RUNTIME, an OrderPlaced event must fire the component reaction so
 * that the reaction-emitted "Tracked" event lands on the concrete, aliased
 * "Audit" boundary/aggregate — i.e. the alias rewrite reaches the runtime target.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { Command } from '../../src/types.js';

const OPENAPI_YAML = `
openapi: "3.0.3"
info: { title: Component Reaction, version: "1.0.0" }
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/Order" } } }
      responses:
        "201": { description: Created, content: { application/json: { schema: { $ref: "#/components/schemas/Order" } } } }
  /audits/{id}:
    get:
      operationId: getAudit
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/Audit" } } } }
components:
  schemas:
    Order:
      type: object
      properties: { id: { type: string }, productId: { type: string } }
      required: [id, productId]
    Audit:
      type: object
      properties: { id: { type: string }, count: { type: integer }, note: { type: string } }
      required: [id, count]
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

const AUDIT_FIXED_ID = '00000000-0000-7000-8000-0000000000bb';

// Component declares a reaction that reacts to a sibling boundary (Order, mapped
// via bind) and emits onto SELF. The reacting `boundary` is the component
// self-name "Tracker" → rewritten to the concrete `as` name "Audit".
const TRACKER_COMPONENT_YAML = `
kind: component
name: Tracker
parameters: {}
event_catalog:
  - type: Tracked
    payload_template:
      id: "event.aggregateId"
      note: "'tracked'"
behaviors: []
reducers:
  - on: Tracked
    patches:
      - { op: increment, path: /count, by: 1 }
reactions:
  - name: track-order
    on: "OrderSrc:OrderPlaced"
    boundary: Tracker
    emit: Tracked
    intent: mutation
    target: '"${AUDIT_FIXED_ID}"'
`;

const USE_AUDIT_YAML = `
use:
  - component: Tracker
    as: Audit
    contract_path: /audits/{id}
    bind:
      OrderSrc: Order
`;

async function buildSystem(): Promise<BootedSystem> {
  const openapi = await loadOpenApi(OPENAPI_YAML);
  const compiledDsl = await compileDsl(
    [{ name: 'order', yaml: ORDER_DSL }],
    undefined,
    [{ name: 'tracker', yaml: TRACKER_COMPONENT_YAML }],
    [{ name: 'use-audit', yaml: USE_AUDIT_YAML }],
  );
  return bootSystem({ openapi, compiledDsl });
}

describe('RED TEAM combo8: use:-aliased component reaction reaches runtime target', () => {
  let sys: BootedSystem;

  beforeEach(async () => {
    sys = await buildSystem();
    // Seed the Audit aggregate so the mutation reaction has something to mutate.
    sys.graph.set(AUDIT_FIXED_ID, { id: AUDIT_FIXED_ID, count: 0 });
  });

  afterEach(() => resetSystem(sys));

  it('reaction declared on component self-boundary fires onto the aliased concrete boundary', async () => {
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

    // The reaction-emitted Tracked event must be present and on the concrete
    // aliased boundary "Audit".
    const tracked = result.events.find((e) => e.type === 'Tracked');
    expect(tracked).toBeDefined();
    expect(tracked!.boundary).toBe('Audit');
    expect(tracked!.aggregateId).toBe(AUDIT_FIXED_ID);

    // The Audit aggregate's count was incremented by the reaction reducer.
    const audit = sys.graph.get(AUDIT_FIXED_ID);
    expect(audit!['count']).toBe(1);
  });
});
