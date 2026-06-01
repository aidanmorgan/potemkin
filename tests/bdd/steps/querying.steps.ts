import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'assert';
import type { SimWorld } from '../support/world.js';
import { runQuery } from '../../../src/engine/query.js';

// We test filtering/pagination via direct runQuery calls since our HTTP
// test fixtures don't include a collection endpoint.

Given('there are multiple opportunities with different stages', async function (this: SimWorld) {
  // opportunity-seed-001 (proposed) is already seeded at boot
  // Create a negotiating opportunity
  const negotiatingOppId = `opp-negotiating-${Date.now()}`;
  await this.sendHttp('POST', `/opportunities/${negotiatingOppId}`, {
    leadId: 'lead-seed-001',
    value: 25000,
  });
  if (this.lastResponse?.status === 201) {
    await this.sendHttp('PATCH', `/opportunities/${negotiatingOppId}`, { stage: 'negotiating' });
  }
  this.ctx['negotiatingOppId'] = negotiatingOppId;
});

When('I query the Opportunity boundary with no filters', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['Opportunity'];
  assert.ok(boundary, 'Opportunity boundary should exist');
  const result = runQuery({
    boundary,
    targetId: null,
    queryParams: {},
    graph: this.sys.graph,
    cel: this.sys.cel,
    openapi: this.sys.openapi,
    logger: this.sys.logger,
    schemaRegistry: this.sys.schemaRegistry,
  });
  this.ctx['queryResult'] = result;
});

When('I query the Opportunity boundary with stage filter {string}', function (this: SimWorld, stage: string) {
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['Opportunity'];
  assert.ok(boundary, 'Opportunity boundary should exist');
  const result = runQuery({
    boundary,
    targetId: null,
    queryParams: { stage },
    graph: this.sys.graph,
    cel: this.sys.cel,
    openapi: this.sys.openapi,
    logger: this.sys.logger,
    schemaRegistry: this.sys.schemaRegistry,
  });
  this.ctx['queryResult'] = result;
});

When('I query the Opportunity boundary with limit {int}', function (this: SimWorld, limit: number) {
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['Opportunity'];
  assert.ok(boundary, 'Opportunity boundary should exist');
  const result = runQuery({
    boundary,
    targetId: null,
    queryParams: { limit: String(limit) },
    graph: this.sys.graph,
    cel: this.sys.cel,
    openapi: this.sys.openapi,
    logger: this.sys.logger,
    schemaRegistry: this.sys.schemaRegistry,
  });
  this.ctx['queryResult'] = result;
});

When('I query the Opportunity boundary with offset {int} and limit {int}', function (this: SimWorld, offset: number, limit: number) {
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['Opportunity'];
  assert.ok(boundary, 'Opportunity boundary should exist');
  const result = runQuery({
    boundary,
    targetId: null,
    queryParams: { offset: String(offset), limit: String(limit) },
    graph: this.sys.graph,
    cel: this.sys.cel,
    openapi: this.sys.openapi,
    logger: this.sys.logger,
    schemaRegistry: this.sys.schemaRegistry,
  });
  this.ctx['queryResult'] = result;
});

// A collection query returns a bare array when unpaginated, or a pagination
// envelope { items, totalCount, offset, limit, hasMore } when `?limit` is set.
// Both carry the collection; this normalizes to the underlying item array.
function queryItems(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object' && Array.isArray((result as { items?: unknown }).items)) {
    return (result as { items: unknown[] }).items;
  }
  assert.fail(`Expected an array or pagination envelope, got: ${JSON.stringify(result)}`);
}

Then('the query result should be an array', function (this: SimWorld) {
  // Passes for a bare array or a pagination envelope (whose items is an array).
  queryItems(this.ctx['queryResult']);
});

Then('the query result should contain at least {int} items', function (this: SimWorld, min: number) {
  const items = queryItems(this.ctx['queryResult']);
  assert.ok(items.length >= min, `Expected at least ${min} items, got ${items.length}`);
});

Then('all query result items should have stage {string}', function (this: SimWorld, stage: string) {
  const items = queryItems(this.ctx['queryResult']) as Array<Record<string, unknown>>;
  for (const item of items) {
    assert.strictEqual(item['stage'], stage, `Item ${String(item['id'])} should have stage '${stage}'`);
  }
});

Then('the query result should contain at most {int} items', function (this: SimWorld, max: number) {
  const items = queryItems(this.ctx['queryResult']);
  assert.ok(items.length <= max, `Expected at most ${max} items, got ${items.length}`);
});

When('I GET the admin state endpoint', async function (this: SimWorld) {
  await this.sendHttp('GET', '/_admin/state');
});

Then('the admin state should contain opportunity entities', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response');
  assert.strictEqual(this.lastResponse.status, 200);
  const body = this.lastResponse.body as Record<string, unknown>;
  const entities = body['entities'] as Record<string, unknown>;
  const oppIds = Object.keys(entities).filter(k => k.startsWith('opportunity-'));
  assert.ok(oppIds.length > 0, 'Admin state should contain opportunity entities');
});

When('I GET lead {string}', async function (this: SimWorld, id: string) {
  await this.sendHttp('GET', `/leads/${id}`);
});

Then('the response should contain the derived property {string}', function (this: SimWorld, propName: string) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.strictEqual(this.lastResponse.status, 200, `Expected 200 but got ${this.lastResponse.status}. Body: ${JSON.stringify(this.lastResponse.body)}`);
  const body = this.lastResponse.body as Record<string, unknown>;
  assert.ok(
    Object.prototype.hasOwnProperty.call(body, propName),
    `Response should contain derived property '${propName}'. Got: ${JSON.stringify(body)}`,
  );
});

Then('the derived property {string} should equal the lead contactName', function (this: SimWorld, propName: string) {
  assert.ok(this.lastResponse, 'No response captured');
  const body = this.lastResponse.body as Record<string, unknown>;
  assert.strictEqual(
    body[propName],
    body['contactName'],
    `Derived property '${propName}' should equal the contactName field`,
  );
});

Then('running a direct query for lead should include derived properties', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['Lead'];
  assert.ok(boundary, 'Lead boundary should exist');
  const result = runQuery({
    boundary,
    targetId: 'lead-seed-001',
    queryParams: {},
    graph: this.sys.graph,
    cel: this.sys.cel,
    openapi: this.sys.openapi,
    logger: this.sys.logger,
    schemaRegistry: this.sys.schemaRegistry,
  }) as Record<string, unknown>;
  assert.ok(result, 'Query should return a result');
  assert.ok(
    Object.prototype.hasOwnProperty.call(result, 'fullContact'),
    `Query result should contain derived property 'fullContact'. Got: ${JSON.stringify(result)}`,
  );
  assert.strictEqual(result['fullContact'], result['contactName'], "fullContact derived property should equal contactName");
});

// Alias steps used in queries feature
When('I GET the opportunities collection with no filters', async function (this: SimWorld) {
  await this.sendHttp('GET', '/_admin/state');
});

When('I GET the opportunities collection with stage filter {string}', async function (this: SimWorld, stage: string) {
  // Use direct query to demonstrate filtering
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['Opportunity'];
  assert.ok(boundary, 'Opportunity boundary should exist');
  const result = runQuery({
    boundary,
    targetId: null,
    queryParams: { stage },
    graph: this.sys.graph,
    cel: this.sys.cel,
    openapi: this.sys.openapi,
    schemaRegistry: this.sys.schemaRegistry,
  });
  this.ctx['queryResult'] = result;
  this.lastResponse = {
    status: 200,
    body: result,
    headers: {},
  };
});

When('I GET the opportunities collection with limit {int}', async function (this: SimWorld, limit: number) {
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['Opportunity'];
  assert.ok(boundary, 'Opportunity boundary should exist');
  const result = runQuery({
    boundary,
    targetId: null,
    queryParams: { limit: String(limit) },
    graph: this.sys.graph,
    cel: this.sys.cel,
    openapi: this.sys.openapi,
    schemaRegistry: this.sys.schemaRegistry,
  });
  this.lastResponse = { status: 200, body: result, headers: {} };
});

When('I GET the opportunities collection with offset {int} and limit {int}', async function (this: SimWorld, offset: number, limit: number) {
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['Opportunity'];
  assert.ok(boundary, 'Opportunity boundary should exist');
  const result = runQuery({
    boundary,
    targetId: null,
    queryParams: { offset: String(offset), limit: String(limit) },
    graph: this.sys.graph,
    cel: this.sys.cel,
    openapi: this.sys.openapi,
    schemaRegistry: this.sys.schemaRegistry,
  });
  this.lastResponse = { status: 200, body: result, headers: {} };
});

Then('the response should be a paginated subset of opportunities', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.strictEqual(this.lastResponse.status, 200, `Expected 200`);
  assert.ok(Array.isArray(this.lastResponse.body), 'Response body should be an array');
});

Then('all returned opportunities should have stage {string}', function (this: SimWorld, stage: string) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.ok(Array.isArray(this.lastResponse.body), 'Response body should be an array');
  const opps = this.lastResponse.body as Array<Record<string, unknown>>;
  for (const opp of opps) {
    assert.strictEqual(opp['stage'], stage, `Opportunity ${String(opp['id'])} should have stage '${stage}'`);
  }
});

Then('the response array should contain at most {int} items', function (this: SimWorld, maxItems: number) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.ok(Array.isArray(this.lastResponse.body), 'Response body should be an array');
  const items = this.lastResponse.body as unknown[];
  assert.ok(
    items.length <= maxItems,
    `Expected at most ${maxItems} items but got ${items.length}`,
  );
});
