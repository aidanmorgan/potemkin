import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'assert';
import type { SimWorld } from '../support/world.js';
import type { JsonObject } from '../../../src/types.js';

// ---------------------------------------------------------------------------
// Background / boot steps
// ---------------------------------------------------------------------------

Given('the CRM simulator is booted', async function (this: SimWorld) {
  await this.ensureBooted();
});

Given('the system state is reset to baseline', async function (this: SimWorld) {
  await this.resetState();
});

// ---------------------------------------------------------------------------
// HTTP request steps
// ---------------------------------------------------------------------------

When('I send {string} with body {string}', async function (this: SimWorld, requestLine: string, bodyStr: string) {
  const [method, path] = requestLine.split(' ');
  const body = JSON.parse(bodyStr) as JsonObject;
  await this.sendHttp(method, path, body);
});

When('I send {string}', async function (this: SimWorld, requestLine: string) {
  const [method, path] = requestLine.split(' ');
  await this.sendHttp(method, path);
});

When(
  'I send {string} with body {string} and header {string}: {string}',
  async function (this: SimWorld, requestLine: string, bodyStr: string, headerName: string, headerValue: string) {
    const [method, path] = requestLine.split(' ');
    const body = JSON.parse(bodyStr) as JsonObject;
    await this.sendHttp(method, path, body, { [headerName]: headerValue });
  },
);

When(
  'I send {string} with header {string}: {string}',
  async function (this: SimWorld, requestLine: string, headerName: string, headerValue: string) {
    const [method, path] = requestLine.split(' ');
    await this.sendHttp(method, path, undefined, { [headerName]: headerValue });
  },
);

// ---------------------------------------------------------------------------
// Response assertion steps
// ---------------------------------------------------------------------------

Then('the response status should be {int}', function (this: SimWorld, expectedStatus: number) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.strictEqual(
    this.lastResponse.status,
    expectedStatus,
    `Expected status ${expectedStatus} but got ${this.lastResponse.status}. Body: ${JSON.stringify(this.lastResponse.body)}`,
  );
});

Then('the response body code should be {string}', function (this: SimWorld, expectedCode: string) {
  assert.ok(this.lastResponse, 'No response captured');
  const body = this.lastResponse.body as Record<string, unknown>;
  const code = body['code'] ?? body['error'];
  assert.strictEqual(
    code,
    expectedCode,
    `Expected code '${expectedCode}' but got '${String(code)}'. Body: ${JSON.stringify(body)}`,
  );
});

Then('the response body should contain field {string}', function (this: SimWorld, field: string) {
  assert.ok(this.lastResponse, 'No response captured');
  const body = this.lastResponse.body as Record<string, unknown>;
  assert.ok(
    Object.prototype.hasOwnProperty.call(body, field) || body[field] !== undefined,
    `Expected field '${field}' in response body. Got: ${JSON.stringify(body)}`,
  );
});

Then('the response body field {string} should equal {string}', function (this: SimWorld, field: string, expected: string) {
  assert.ok(this.lastResponse, 'No response captured');
  const body = this.lastResponse.body as Record<string, unknown>;
  const actual = body[field];
  assert.strictEqual(String(actual), expected, `Field '${field}': expected '${expected}' got '${String(actual)}'`);
});

Then('the response header {string} should be present', function (this: SimWorld, headerName: string) {
  assert.ok(this.lastResponse, 'No response captured');
  const val = this.lastResponse.headers[headerName.toLowerCase()];
  assert.ok(val !== undefined && val !== '', `Expected header '${headerName}' to be present`);
});

Then('the response body should be an array', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.ok(Array.isArray(this.lastResponse.body), `Expected array body, got: ${JSON.stringify(this.lastResponse.body)}`);
});

Then('the response body array length should be {int}', function (this: SimWorld, expected: number) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.ok(Array.isArray(this.lastResponse.body));
  assert.strictEqual((this.lastResponse.body as unknown[]).length, expected);
});

Then('the response body array length should be at least {int}', function (this: SimWorld, min: number) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.ok(Array.isArray(this.lastResponse.body));
  assert.ok(
    (this.lastResponse.body as unknown[]).length >= min,
    `Expected at least ${min} items but got ${(this.lastResponse.body as unknown[]).length}`,
  );
});

// ---------------------------------------------------------------------------
// Event-store assertion steps
// ---------------------------------------------------------------------------

Then('the event log should have at least {int} event(s)', function (this: SimWorld, min: number) {
  const count = this.getEventCount();
  assert.ok(count >= min, `Expected at least ${min} events but got ${count}`);
});

Then('the event log should be empty', function (this: SimWorld) {
  const count = this.getEventCount();
  assert.strictEqual(count, 0, `Expected empty event log but has ${count} events`);
});

Then('the state graph should have at least {int} entity(ies)', function (this: SimWorld, min: number) {
  const count = this.getEntityCount();
  assert.ok(count >= min, `Expected at least ${min} entities but got ${count}`);
});

Then('the state graph should be empty', function (this: SimWorld) {
  const count = this.getEntityCount();
  assert.strictEqual(count, 0, `Expected empty state graph but has ${count} entities`);
});

Then('entity {string} should exist in the state graph', function (this: SimWorld, id: string) {
  const entity = this.getState(id);
  assert.ok(entity !== null, `Expected entity '${id}' to exist in state graph`);
});

Then('entity {string} should not exist in the state graph', function (this: SimWorld, id: string) {
  const entity = this.getState(id);
  assert.strictEqual(entity, null, `Expected entity '${id}' to be absent from state graph`);
});
