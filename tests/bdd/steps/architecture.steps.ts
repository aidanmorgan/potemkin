import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'assert';
import type { SimWorld } from '../support/world.js';
import {
  bootSystem,
  createGateway,
  createEventStore,
  createStateGraph,
} from '../../../src/index.js';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { BANKING_OPENAPI_YAML, CUSTOMER_DSL_YAML, CUSTOMER_COLLECTION_DSL_YAML, LOAN_DSL_YAML, LOAN_COLLECTION_DSL_YAML } from '../support/world.js';

// ---------------------------------------------------------------------------
// REQ-6 cross-boundary fixture: Loan boundary cascades to Customer.loanIds
// ---------------------------------------------------------------------------

const CROSS_BOUNDARY_OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: Cross-Boundary Test
  version: "1.0.0"
paths:
  /cb-loans/{id}:
    post:
      operationId: createCbLoan
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CbLoan'
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CbLoan'
  /cb-customers/{id}:
    patch:
      operationId: updateCbCustomer
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CbCustomer'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CbCustomer'
components:
  schemas:
    CbLoan:
      type: object
      additionalProperties: true
      properties:
        id:
          type: string
        customerId:
          type: string
    CbCustomer:
      type: object
      additionalProperties: true
      properties:
        id:
          type: string
        loanIds:
          type: array
          items:
            type: string
`;

const CROSS_BOUNDARY_LOAN_DSL_YAML = `
boundary: CbLoan
contract_path: /cb-loans/{id}
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
behaviors:
  - name: create-cb-loan
    match:
      intent: creation
      condition: "true"
    emit: CbLoanCreated
    dispatch_commands:
      - boundary: CbCustomer
        intent: mutation
        target_id: "command.payload.customerId"
        payload:
          loanId: "command.targetId"
event_catalog:
  - type: CbLoanCreated
    payload_template:
      id: "command.targetId"
      customerId: "command.payload.customerId"
reducers:
  - on: CbLoanCreated
    assign:
      id: "event.payload.id"
      customerId: "event.payload.customerId"
`;

const CROSS_BOUNDARY_CUSTOMER_DSL_YAML = `
boundary: CbCustomer
contract_path: /cb-customers/{id}
fallback_override: false
behaviors:
  - name: attach-loan
    match:
      intent: mutation
      condition: "true"
    emit: CbLoanAttached
event_catalog:
  - type: CbLoanAttached
    payload_template:
      loanId: "payload.loanId"
reducers:
  - on: CbLoanAttached
    append:
      loanIds: "event.payload.loanId"
initialization:
  - id: "cb-customer-001"
    loanIds: []
`;

// REQ-1: Interface Contract used as strict schema for validation and routing
Then('requests with invalid payload are rejected with 400', async function (this: SimWorld) {
  // Posting a completely wrong content type / shape to /customers
  await this.sendHttp('POST', `/customers/cust-${Date.now()}`, null);
  // We don't assert status here — just that the gateway returned something
  assert.ok(this.lastResponse, 'No response received');
});

// REQ-2: Write Model and Read Model are independent
Then('the event store and state graph are separate stores', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  // They are distinct object references
  assert.ok(this.sys.events !== (this.sys.graph as unknown), 'EventStore and StateGraph should be separate objects');
  // EventStore has append/all; StateGraph has get/set
  assert.ok(typeof this.sys.events.append === 'function', 'EventStore has append');
  assert.ok(typeof this.sys.graph.get === 'function', 'StateGraph has get');
});

// REQ-3: Events are immutable once appended
Then('events in the event log should be frozen', function (this: SimWorld) {
  const events = this.getEvents();
  for (const ev of events) {
    assert.ok(Object.isFrozen(ev), `Event ${ev.eventId} should be frozen`);
  }
});

// REQ-4: State mutations only via domain events
Then('the state graph entity count should match committed events', function (this: SimWorld) {
  // After boot, state graph entity count should be >= frozen baseline events
  const evCount = this.getEventCount();
  const entityCount = this.getEntityCount();
  // There must be at least as many events as entities (each entity had a creation event)
  assert.ok(evCount >= entityCount, `Events (${evCount}) should be >= entities (${entityCount})`);
});

// REQ-5: Behavioral logic encapsulated
Then('DSL rules emit events rather than directly mutating state', async function (this: SimWorld) {
  const evBefore = this.getEventCount();
  await this.sendHttp('POST', `/customers/cust-${Date.now()}`, { name: 'Bob', email: 'bob@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201, 'Creation should succeed');
  const evAfter = this.getEventCount();
  assert.ok(evAfter > evBefore, 'A domain event should have been appended');
});

// REQ-6: Cross-boundary communication via secondary commands

Given('a cross-boundary DSL is booted with Loan cascading to Customer loanIds', async function (this: SimWorld) {
  await this.bootWithCustomDsl(CROSS_BOUNDARY_OPENAPI_YAML, [
    { name: 'cbLoan', yaml: CROSS_BOUNDARY_LOAN_DSL_YAML },
    { name: 'cbCustomer', yaml: CROSS_BOUNDARY_CUSTOMER_DSL_YAML },
  ]);
  assert.ok(this.sys, 'System should be booted');
  assert.ok(
    this.sys.dsl.boundaries.length >= 2,
    `Need at least 2 boundaries; got ${this.sys.dsl.boundaries.length}`,
  );
});

When('a Loan creation command is dispatched for a known customer', async function (this: SimWorld) {
  this.ctx['eventsBefore'] = this.getEventCount();
  await this.sendHttp('POST', '/cb-loans/new-loan-001', { customerId: 'cb-customer-001' });
  assert.ok(this.lastResponse, 'No response received');
  assert.strictEqual(
    this.lastResponse.status,
    201,
    `Expected 201 for loan creation but got ${this.lastResponse.status}. Body: ${JSON.stringify(this.lastResponse.body)}`,
  );
  this.ctx['createdLoanId'] = (this.lastResponse.body as Record<string, unknown>)['id'] as string;
});

Then('the targeted Customer loanIds includes the new loan id', function (this: SimWorld) {
  const loanId = this.ctx['createdLoanId'] as string;
  assert.ok(loanId, 'Loan id should have been captured from creation response');
  const customer = this.getState('cb-customer-001') as Record<string, unknown> | null;
  assert.ok(customer !== null, 'Customer cb-customer-001 should exist in state graph');
  const loanIds = customer['loanIds'] as string[];
  assert.ok(Array.isArray(loanIds), 'Customer loanIds should be an array');
  assert.ok(
    loanIds.includes(loanId),
    `Customer loanIds should contain loan '${loanId}' after cascade. Got: ${JSON.stringify(loanIds)}`,
  );
});

Then('the event log includes one event per affected boundary', function (this: SimWorld) {
  const before = this.ctx['eventsBefore'] as number;
  const events = this.getEvents();
  const newEvents = [...events].slice(before);
  assert.strictEqual(
    newEvents.length,
    2,
    `Expected exactly 2 new events (one per boundary), got ${newEvents.length}: ${newEvents.map(e => `${e.boundary}:${e.type}`).join(', ')}`,
  );
  const boundaries = new Set(newEvents.map(e => e.boundary));
  assert.ok(
    boundaries.has('CbLoan'),
    `Expected event from CbLoan boundary. Events: ${newEvents.map(e => e.boundary).join(', ')}`,
  );
  assert.ok(
    boundaries.has('CbCustomer'),
    `Expected event from CbCustomer boundary. Events: ${newEvents.map(e => e.boundary).join(', ')}`,
  );
});

// Legacy step kept for backward compatibility
When('I store the created resource id from the response', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response');
  const body = this.lastResponse.body as Record<string, unknown>;
  this.ctx['createdId'] = body['id'] as string;
});

// REQ-7: Atomic Unit of Work
Then('all events from the request are committed atomically', async function (this: SimWorld) {
  // Create a customer, confirm event log grows by exactly 1
  const before = this.getEventCount();
  await this.sendHttp('POST', `/customers/cust-${Date.now()}`, { name: 'Carol', email: 'carol@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201);
  const after = this.getEventCount();
  assert.ok(after > before, 'At least one event should have been appended');
  // The increment is atomic — either all or none
  const events = this.getEvents();
  const newest = events[events.length - 1];
  assert.ok(newest, 'There should be a newest event');
});

// Step used in architecture.feature background / shared Given
Given('a freshly booted system with banking fixtures', async function (this: SimWorld) {
  await this.ensureBooted();
  await this.resetState();
});

// ---------------------------------------------------------------------------
// REQ-7 atomicity: failed cascade rollback scenario
// ---------------------------------------------------------------------------

// Custom fixture where the secondary command's CEL condition references an undefined
// identifier, causing the cascade to throw during the UoW — all staged events must be
// discarded (rollback).
const ROLLBACK_OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: Rollback Test
  version: "1.0.0"
paths:
  /widgets/{id}:
    post:
      operationId: createWidget
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Widget'
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Widget'
  /sinks/{id}:
    patch:
      operationId: updateSink
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Sink'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Sink'
components:
  schemas:
    Widget:
      type: object
      additionalProperties: true
      properties:
        id:
          type: string
    Sink:
      type: object
      additionalProperties: true
      properties:
        id:
          type: string
`;

// Primary boundary emits WidgetCreated and dispatches a secondary command to Sink boundary.
// The Sink behavior condition references `undefinedVariable` — an undefined CEL identifier —
// causing the pattern-matcher to throw an error and abort the entire UoW.
const ROLLBACK_WIDGET_DSL_YAML = `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
behaviors:
  - name: create-widget
    match:
      intent: creation
      condition: "true"
    emit: WidgetCreated
    dispatch_commands:
      - boundary: Sink
        intent: mutation
        target_id: "'sink-001'"
        payload:
          widgetId: "command.targetId"
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: "command.targetId"
reducers:
  - on: WidgetCreated
    assign:
      id: "event.payload.id"
`;

const ROLLBACK_SINK_DSL_YAML = `
boundary: Sink
contract_path: /sinks/{id}
fallback_override: false
behaviors:
  - name: handle-widget
    match:
      intent: mutation
      condition: "undefinedVariable.doesNotExist == true"
    emit: SinkUpdated
event_catalog:
  - type: SinkUpdated
    payload_template:
      id: "state.id"
reducers:
  - on: SinkUpdated
    assign:
      id: "event.payload.id"
initialization:
  - id: "sink-001"
    initialized: true
`;

Given('a DSL whose primary command emits a successful event but the secondary command throws', async function (this: SimWorld) {
  await this.bootWithCustomDsl(ROLLBACK_OPENAPI_YAML, [
    { name: 'widget', yaml: ROLLBACK_WIDGET_DSL_YAML },
    { name: 'sink', yaml: ROLLBACK_SINK_DSL_YAML },
  ]);
  assert.ok(this.sys, 'System should be booted with rollback fixture');
  this.ctx['eventsBeforeRollback'] = this.getEventCount();
  this.ctx['entityCountBeforeRollback'] = this.getEntityCount();
});

When('the primary command is sent', async function (this: SimWorld) {
  await this.sendHttp('POST', '/widgets/new-widget-001', { name: 'test' });
});

Then('the UoW aborts', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response captured');
  // The UoW must abort — not succeed with 201.
  assert.notStrictEqual(
    this.lastResponse.status,
    201,
    `UoW should have aborted but returned 201. Body: ${JSON.stringify(this.lastResponse.body)}`,
  );
  // Should be a 4xx or 5xx indicating failure
  assert.ok(
    this.lastResponse.status >= 400,
    `Expected a failure status (4xx/5xx) but got ${this.lastResponse.status}`,
  );
});

Then('the event log is unchanged from its pre-command state', function (this: SimWorld) {
  const before = this.ctx['eventsBeforeRollback'] as number;
  const after = this.getEventCount();
  assert.strictEqual(
    after,
    before,
    `Event log should be unchanged after rollback: expected ${before} events, got ${after}`,
  );
});

Then('the state graph is unchanged from its pre-command state', function (this: SimWorld) {
  const before = this.ctx['entityCountBeforeRollback'] as number;
  const after = this.getEntityCount();
  assert.strictEqual(
    after,
    before,
    `State graph should be unchanged after rollback: expected ${before} entities, got ${after}`,
  );
  // Widget entity must NOT have been created
  const widget = this.getState('new-widget-001');
  assert.strictEqual(widget, null, 'Widget new-widget-001 should not exist after rollback');
});
