/**
 * dispatch_commands actor propagation.
 *
 * Secondary commands built from a dispatch_commands spec must carry the
 * originating actor field. When the secondary boundary has `audit_fields: true`,
 * the resulting entity's `updatedBy` must equal the originating caller's id.
 *
 * This test drives a real dispatch_commands cascade through executeUnitOfWork:
 *   - Primary boundary (Order): behaviour emits OrderCreated and dispatches a
 *     secondary creation command into the secondary Audit boundary.
 *   - Secondary boundary (Audit): has `audit_fields: true`.
 *   - The inbound command carries `actor: { id: 'alice', scopes: [] }`.
 *
 * After the cascade, the secondary (Audit) entity in the state graph must have
 * `updatedBy === 'alice'`.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { Command } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Inline DSL — minimal pair of boundaries for the cascade
// ---------------------------------------------------------------------------

const ORDER_DSL = `
boundary: Order
contract_path: /orders/{id}
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: OrderCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: create-order
    match:
      operationId: createOrder
      condition: "true"
    emit: OrderCreated
    dispatch_commands:
      - boundary: Audit
        intent: creation
        operationId: createAudit
        target_id: "command.targetId + '-audit'"
        with: {}
reducers:
  - on: OrderCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

// audit_fields: true means projecting any event on this boundary stamps
// updatedBy = event.request.actorId.
const AUDIT_DSL = `
boundary: Audit
contract_path: /audits/{id}
fallback_override: false
audit_fields: true
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: AuditCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: create-audit
    match:
      operationId: createAudit
      condition: "true"
    emit: AuditCreated
reducers:
  - on: AuditCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

const OPENAPI_YAML = `
openapi: "3.0.3"
info: { title: DispatchActorPropagation, version: "1.0.0" }
paths:
  /orders/{id}:
    post:
      operationId: createOrder
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Order" }
      responses:
        "201":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Order" }
  /audits/{id}:
    post:
      operationId: createAudit
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Audit" }
      responses:
        "201":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Audit" }
components:
  schemas:
    Order:
      type: object
      additionalProperties: true
      properties:
        id: { type: string }
      required: [id]
    Audit:
      type: object
      additionalProperties: true
      properties:
        id: { type: string }
      required: [id]
`;

// ---------------------------------------------------------------------------

describe('dispatch_commands actor propagation — cascaded entity updatedBy', () => {
  let sys: BootedSystem;

  beforeEach(async () => {
    const openapi = await loadOpenApi(OPENAPI_YAML);
    const compiledDsl = await compileDsl([
      { name: 'order', yaml: ORDER_DSL },
      { name: 'audit', yaml: AUDIT_DSL },
    ]);
    sys = await bootSystem({ openapi, compiledDsl });
  });

  afterEach(() => {
    resetSystem(sys);
  });

  it('cascaded Audit entity updatedBy equals the originating actor id', async () => {
    const orderId = nextUuidv7();
    const auditId = `${orderId}-audit`;
    const actorId = 'alice';

    const cmd: Command = {
      commandId: nextUuidv7(),
      boundary: 'Order',
      intent: 'creation',
      targetId: orderId,
      payload: {},
      queryParams: {},
      httpMethod: 'POST',
      path: `/orders/${orderId}`,
      operationId: 'createOrder',
      origin: 'inbound',
      depth: 0,
      actor: { id: actorId, scopes: [] },
    };

    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      openapi: sys.openapi,
    });

    // Primary creation succeeded.
    expect(result.status).toBe(201);

    // Both events must have been emitted: OrderCreated (primary) + AuditCreated (secondary).
    const eventTypes = result.events.map((e) => e.type);
    expect(eventTypes).toContain('OrderCreated');
    expect(eventTypes).toContain('AuditCreated');

    // The cascaded Audit entity must have updatedBy stamped with the originating actor id.
    // Without the actor spread in patternMatcher.ts the secondary command carries no actor,
    // event.request.actorId is absent, and projection sets updatedBy = null — failing here.
    const auditEntity = sys.graph.get(auditId);
    expect(auditEntity).not.toBeNull();
    expect(auditEntity!['updatedBy']).toBe(actorId);
  });
});
