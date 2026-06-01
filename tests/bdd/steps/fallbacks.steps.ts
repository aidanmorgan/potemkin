import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'assert';
import type { SimWorld } from '../support/world.js';

// ---------------------------------------------------------------------------
// Strict fallback test fixture — a boundary with fallback_override:true and
// NO mutation behaviors. Any mutation must be handled via System.GenericUpdateEvent.
// ---------------------------------------------------------------------------

const FALLBACK_ONLY_OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: Fallback-Only Test
  version: "1.0.0"
paths:
  /items/{id}:
    patch:
      operationId: updateItem
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
              $ref: '#/components/schemas/Item'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Item'
components:
  schemas:
    Item:
      type: object
      additionalProperties: true
      properties:
        id:
          type: string
        label:
          type: string
`;

const FALLBACK_ONLY_DSL_YAML = `
boundary: Item
contract_path: /items/{id}
fallback_override: true
behaviors: []
event_catalog: []
reducers: []
initialization:
  - id: "item-seed-001"
    label: "original-label"
`;

When('I GET an entity with no specific query rule and fallback enabled', async function (this: SimWorld) {
  // Lead boundary has fallback_override: true
  // GET /leads/lead-seed-001 — Lead DSL has no 'query' behavior rule
  // but fallback is enabled so it should return the entity from the state graph
  await this.sendHttp('GET', '/leads/lead-seed-001');
});

Then('the response should return the entity from the state graph', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response captured');
  // Should succeed with 200 and the entity body
  assert.strictEqual(this.lastResponse.status, 200, `Expected 200 but got ${this.lastResponse.status}. Body: ${JSON.stringify(this.lastResponse.body)}`);
  const body = this.lastResponse.body as Record<string, unknown>;
  assert.ok(body['id'] || body['companyName'], 'Response body should contain entity data');
});

Given('a boundary with fallback_override true and no mutation behaviors is booted', async function (this: SimWorld) {
  await this.bootWithCustomDsl(FALLBACK_ONLY_OPENAPI_YAML, [
    { name: 'item', yaml: FALLBACK_ONLY_DSL_YAML },
  ]);
});

Given('a seed entity exists in the fallback boundary', function (this: SimWorld) {
  const entity = this.getState('item-seed-001');
  assert.ok(entity !== null, 'Seed entity item-seed-001 should exist after boot');
  assert.strictEqual(
    (entity as Record<string, unknown>)['label'],
    'original-label',
    'Seed entity should have label "original-label"',
  );
});

When('I PATCH the seed entity with a payload on the fallback boundary', async function (this: SimWorld) {
  this.ctx['eventsBefore'] = this.getEventCount();
  await this.sendHttp('PATCH', '/items/item-seed-001', { label: 'updated-label', extra: 'bonus' });
});

Then('the fallback response status is 200', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.strictEqual(
    this.lastResponse.status,
    200,
    `Expected 200 (fallback GenericUpdateEvent applied) but got ${this.lastResponse.status}. Body: ${JSON.stringify(this.lastResponse.body)}`,
  );
});

Then('the event count grew by exactly 1', function (this: SimWorld) {
  const before = this.ctx['eventsBefore'] as number;
  const after = this.getEventCount();
  assert.strictEqual(
    after,
    before + 1,
    `Expected event count to grow by 1 (from ${before} to ${before + 1}) but it is now ${after}`,
  );
});

Then('the new event type is System.GenericUpdateEvent', function (this: SimWorld) {
  const before = this.ctx['eventsBefore'] as number;
  const events = this.getEvents();
  const newEvent = events[before];
  assert.ok(newEvent, 'There should be a new event appended');
  assert.strictEqual(
    newEvent.type,
    'System.GenericUpdateEvent',
    `Expected new event type to be 'System.GenericUpdateEvent' but got '${newEvent.type}'`,
  );
});

Then('the seed entity state has the payload deep-merged in', function (this: SimWorld) {
  const entity = this.getState('item-seed-001') as Record<string, unknown> | null;
  assert.ok(entity !== null, 'Entity item-seed-001 should still exist after mutation');
  assert.strictEqual(
    entity['label'],
    'updated-label',
    `Expected entity.label to be 'updated-label' after deep-merge, got '${String(entity['label'])}'`,
  );
  assert.strictEqual(
    entity['extra'],
    'bonus',
    `Expected entity.extra to be 'bonus' after deep-merge, got '${String(entity['extra'])}'`,
  );
});

// Direct fallback test via mutation with specific behavior
When('I PATCH lead {string} to update the companyName to {string}', async function (this: SimWorld, id: string, companyName: string) {
  const before = this.getEventCount();
  this.ctx['eventsBefore'] = before;
  await this.sendHttp('PATCH', `/leads/${id}`, { companyName });
});

Then('the state graph entity {string} should have companyName {string}', function (this: SimWorld, id: string, expectedName: string) {
  const entity = this.getState(id);
  assert.ok(entity !== null, `Entity '${id}' should exist`);
  const e = entity as Record<string, unknown>;
  assert.strictEqual(e['companyName'], expectedName, `Entity companyName should be '${expectedName}' but was '${String(e['companyName'])}'`);
});
