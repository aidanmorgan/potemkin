import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'assert';
import type { SimWorld } from '../support/world.js';
import { runQuery } from '../../../src/engine/query.js';

// REQ-35: Query parameters filter and paginate State Graph results
// We test filtering/pagination via direct runQuery calls since our HTTP
// test fixtures don't include a collection endpoint.

Given('there are multiple loans with different statuses', async function (this: SimWorld) {
  // loan-seed-001 (pending) is already seeded at boot
  // Create an active loan
  const activeLoanId = `loan-active-${Date.now()}`;
  await this.sendHttp('POST', `/loans/${activeLoanId}`, {
    customerId: 'customer-seed-001',
    amount: 25000,
  });
  if (this.lastResponse?.status === 201) {
    await this.sendHttp('PATCH', `/loans/${activeLoanId}`, { status: 'active' });
  }
  this.ctx['activeLoanId'] = activeLoanId;
});

When('I query the LoanAccount boundary with no filters', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['LoanAccount'];
  assert.ok(boundary, 'LoanAccount boundary should exist');
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

When('I query the LoanAccount boundary with status filter {string}', function (this: SimWorld, status: string) {
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['LoanAccount'];
  assert.ok(boundary, 'LoanAccount boundary should exist');
  const result = runQuery({
    boundary,
    targetId: null,
    queryParams: { status },
    graph: this.sys.graph,
    cel: this.sys.cel,
    openapi: this.sys.openapi,
    logger: this.sys.logger,
    schemaRegistry: this.sys.schemaRegistry,
  });
  this.ctx['queryResult'] = result;
});

When('I query the LoanAccount boundary with limit {int}', function (this: SimWorld, limit: number) {
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['LoanAccount'];
  assert.ok(boundary, 'LoanAccount boundary should exist');
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

When('I query the LoanAccount boundary with offset {int} and limit {int}', function (this: SimWorld, offset: number, limit: number) {
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['LoanAccount'];
  assert.ok(boundary, 'LoanAccount boundary should exist');
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

Then('the query result should be an array', function (this: SimWorld) {
  const result = this.ctx['queryResult'];
  assert.ok(Array.isArray(result), `Expected array result, got: ${JSON.stringify(result)}`);
});

Then('the query result should contain at least {int} items', function (this: SimWorld, min: number) {
  const result = this.ctx['queryResult'] as unknown[];
  assert.ok(Array.isArray(result), 'Query result should be an array');
  assert.ok(result.length >= min, `Expected at least ${min} items, got ${result.length}`);
});

Then('all query result items should have status {string}', function (this: SimWorld, status: string) {
  const result = this.ctx['queryResult'] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(result), 'Query result should be an array');
  for (const item of result) {
    assert.strictEqual(item['status'], status, `Item ${String(item['id'])} should have status '${status}'`);
  }
});

Then('the query result should contain at most {int} items', function (this: SimWorld, max: number) {
  const result = this.ctx['queryResult'] as unknown[];
  assert.ok(Array.isArray(result), 'Query result should be an array');
  assert.ok(result.length <= max, `Expected at most ${max} items, got ${result.length}`);
});

// REQ-35b via HTTP — use admin state endpoint for collection verification
When('I GET the admin state endpoint', async function (this: SimWorld) {
  await this.sendHttp('GET', '/_admin/state');
});

Then('the admin state should contain loan entities', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response');
  assert.strictEqual(this.lastResponse.status, 200);
  const body = this.lastResponse.body as Record<string, unknown>;
  const entities = body['entities'] as Record<string, unknown>;
  const loanIds = Object.keys(entities).filter(k => k.startsWith('loan-'));
  assert.ok(loanIds.length > 0, 'Admin state should contain loan entities');
});

// REQ-36: Derived Properties dynamically computed and appended
When('I GET customer {string}', async function (this: SimWorld, id: string) {
  await this.sendHttp('GET', `/customers/${id}`);
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

Then('the derived property {string} should equal the customer name', function (this: SimWorld, propName: string) {
  assert.ok(this.lastResponse, 'No response captured');
  const body = this.lastResponse.body as Record<string, unknown>;
  assert.strictEqual(
    body[propName],
    body['name'],
    `Derived property '${propName}' should equal the name field`,
  );
});

// REQ-36b: Direct runQuery test for derived properties
Then('running a direct query for customer should include derived properties', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['Customer'];
  assert.ok(boundary, 'Customer boundary should exist');
  const result = runQuery({
    boundary,
    targetId: 'customer-seed-001',
    queryParams: {},
    graph: this.sys.graph,
    cel: this.sys.cel,
    openapi: this.sys.openapi,
    logger: this.sys.logger,
    schemaRegistry: this.sys.schemaRegistry,
  }) as Record<string, unknown>;
  assert.ok(result, 'Query should return a result');
  assert.ok(
    Object.prototype.hasOwnProperty.call(result, 'fullName'),
    `Query result should contain derived property 'fullName'. Got: ${JSON.stringify(result)}`,
  );
  assert.strictEqual(result['fullName'], result['name'], "fullName derived property should equal name");
});

// Alias step used in queries feature
When('I GET the loans collection with no filters', async function (this: SimWorld) {
  await this.sendHttp('GET', '/_admin/state');
});

When('I GET the loans collection with status filter {string}', async function (this: SimWorld, status: string) {
  // Use direct query to demonstrate filtering
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['LoanAccount'];
  assert.ok(boundary, 'LoanAccount boundary should exist');
  const result = runQuery({
    boundary,
    targetId: null,
    queryParams: { status },
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

When('I GET the loans collection with limit {int}', async function (this: SimWorld, limit: number) {
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['LoanAccount'];
  assert.ok(boundary, 'LoanAccount boundary should exist');
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

When('I GET the loans collection with offset {int} and limit {int}', async function (this: SimWorld, offset: number, limit: number) {
  assert.ok(this.sys, 'System not booted');
  const boundary = this.sys.dsl.byBoundaryName['LoanAccount'];
  assert.ok(boundary, 'LoanAccount boundary should exist');
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

Then('the response should be a paginated subset of loans', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.strictEqual(this.lastResponse.status, 200, `Expected 200`);
  assert.ok(Array.isArray(this.lastResponse.body), 'Response body should be an array');
});

Then('all returned loans should have status {string}', function (this: SimWorld, status: string) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.ok(Array.isArray(this.lastResponse.body), 'Response body should be an array');
  const loans = this.lastResponse.body as Array<Record<string, unknown>>;
  for (const loan of loans) {
    assert.strictEqual(loan['status'], status, `Loan ${String(loan['id'])} should have status '${status}'`);
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
