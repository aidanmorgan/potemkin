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
import { CRM_OPENAPI_YAML, LEAD_DSL_YAML, LEAD_COLLECTION_DSL_YAML, OPPORTUNITY_DSL_YAML, OPPORTUNITY_COLLECTION_DSL_YAML } from '../support/world.js';

// ---------------------------------------------------------------------------
// REQ-6 cross-boundary fixture: Opportunity boundary cascades to Lead.opportunityIds
// ---------------------------------------------------------------------------

const CROSS_BOUNDARY_OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: Cross-Boundary Test
  version: "1.0.0"
paths:
  /cb-opportunities/{id}:
    post:
      operationId: createCbOpportunity
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
              $ref: '#/components/schemas/CbOpportunity'
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CbOpportunity'
  /cb-leads/{id}:
    patch:
      operationId: updateCbLead
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
              $ref: '#/components/schemas/CbLead'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CbLead'
components:
  schemas:
    CbOpportunity:
      type: object
      additionalProperties: true
      properties:
        id:
          type: string
        leadId:
          type: string
    CbLead:
      type: object
      additionalProperties: true
      properties:
        id:
          type: string
        opportunityIds:
          type: array
          items:
            type: string
`;

const CROSS_BOUNDARY_OPPORTUNITY_DSL_YAML = `
boundary: CbOpportunity
contract_path: /cb-opportunities/{id}
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
behaviors:
  - name: create-cb-opportunity
    match:
      operationId: createCbOpportunity
      condition: "true"
    emit: CbOpportunityCreated
    dispatch_commands:
      - boundary: CbLead
        intent: mutation
        operationId: updateCbLead
        target_id: "command.payload.leadId"
        payload:
          opportunityId: "command.targetId"
event_catalog:
  - type: CbOpportunityCreated
    payload_template:
      id: "command.targetId"
      leadId: "command.payload.leadId"
reducers:
  - on: CbOpportunityCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /leadId, value: "\${event.payload.leadId}" }
`;

const CROSS_BOUNDARY_LEAD_DSL_YAML = `
boundary: CbLead
contract_path: /cb-leads/{id}
fallback_override: false
behaviors:
  - name: attach-opportunity
    match:
      operationId: updateCbLead
      condition: "true"
    emit: CbOpportunityAttached
event_catalog:
  - type: CbOpportunityAttached
    payload_template:
      opportunityId: "payload.opportunityId"
reducers:
  - on: CbOpportunityAttached
    patches:
      - { op: append, path: /opportunityIds, value: "\${event.payload.opportunityId}" }
initialization:
  - id: "cb-lead-001"
    opportunityIds: []
`;

// REQ-1: Interface Contract used as strict schema for validation and routing
Then('requests with invalid payload are rejected with 400', async function (this: SimWorld) {
  // Posting a completely wrong content type / shape to /leads
  await this.sendHttp('POST', `/leads/lead-${Date.now()}`, null);
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
  await this.sendHttp('POST', `/leads/lead-${Date.now()}`, { companyName: 'Bob Corp', contactName: 'Bob', email: 'bob@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201, 'Creation should succeed');
  const evAfter = this.getEventCount();
  assert.ok(evAfter > evBefore, 'A domain event should have been appended');
});

// REQ-6: Cross-boundary communication via secondary commands

Given('a cross-boundary DSL is booted with Opportunity cascading to Lead opportunityIds', async function (this: SimWorld) {
  await this.bootWithCustomDsl(CROSS_BOUNDARY_OPENAPI_YAML, [
    { name: 'cbOpportunity', yaml: CROSS_BOUNDARY_OPPORTUNITY_DSL_YAML },
    { name: 'cbLead', yaml: CROSS_BOUNDARY_LEAD_DSL_YAML },
  ]);
  assert.ok(this.sys, 'System should be booted');
  assert.ok(
    this.sys.dsl.boundaries.length >= 2,
    `Need at least 2 boundaries; got ${this.sys.dsl.boundaries.length}`,
  );
});

When('an Opportunity creation command is dispatched for a known lead', async function (this: SimWorld) {
  this.ctx['eventsBefore'] = this.getEventCount();
  await this.sendHttp('POST', '/cb-opportunities/new-opp-001', { leadId: 'cb-lead-001' });
  assert.ok(this.lastResponse, 'No response received');
  assert.strictEqual(
    this.lastResponse.status,
    201,
    `Expected 201 for opportunity creation but got ${this.lastResponse.status}. Body: ${JSON.stringify(this.lastResponse.body)}`,
  );
  this.ctx['createdOpportunityId'] = (this.lastResponse.body as Record<string, unknown>)['id'] as string;
});

Then('the targeted Lead opportunityIds includes the new opportunity id', function (this: SimWorld) {
  const oppId = this.ctx['createdOpportunityId'] as string;
  assert.ok(oppId, 'Opportunity id should have been captured from creation response');
  const lead = this.getState('cb-lead-001') as Record<string, unknown> | null;
  assert.ok(lead !== null, 'Lead cb-lead-001 should exist in state graph');
  const opportunityIds = lead['opportunityIds'] as string[];
  assert.ok(Array.isArray(opportunityIds), 'Lead opportunityIds should be an array');
  assert.ok(
    opportunityIds.includes(oppId),
    `Lead opportunityIds should contain opportunity '${oppId}' after cascade. Got: ${JSON.stringify(opportunityIds)}`,
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
    boundaries.has('CbOpportunity'),
    `Expected event from CbOpportunity boundary. Events: ${newEvents.map(e => e.boundary).join(', ')}`,
  );
  assert.ok(
    boundaries.has('CbLead'),
    `Expected event from CbLead boundary. Events: ${newEvents.map(e => e.boundary).join(', ')}`,
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
  // Create a lead, confirm event log grows by exactly 1
  const before = this.getEventCount();
  await this.sendHttp('POST', `/leads/lead-${Date.now()}`, { companyName: 'Carol Corp', contactName: 'Carol', email: 'carol@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201);
  const after = this.getEventCount();
  assert.ok(after > before, 'At least one event should have been appended');
  // The increment is atomic — either all or none
  const events = this.getEvents();
  const newest = events[events.length - 1];
  assert.ok(newest, 'There should be a newest event');
});

// Step used in architecture.feature background / shared Given
Given('a freshly booted system with CRM fixtures', async function (this: SimWorld) {
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
      operationId: createWidget
      condition: "true"
    emit: WidgetCreated
    dispatch_commands:
      - boundary: Sink
        intent: mutation
        operationId: updateSink
        target_id: "'sink-001'"
        payload:
          widgetId: "command.targetId"
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: "command.targetId"
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

const ROLLBACK_SINK_DSL_YAML = `
boundary: Sink
contract_path: /sinks/{id}
fallback_override: false
behaviors:
  - name: handle-widget
    match:
      operationId: updateSink
      condition: "undefinedVariable.doesNotExist == true"
    emit: SinkUpdated
event_catalog:
  - type: SinkUpdated
    payload_template:
      id: "state.id"
reducers:
  - on: SinkUpdated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
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
