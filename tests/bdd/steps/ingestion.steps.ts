import { When, Then } from '@cucumber/cucumber';
import assert from 'assert';
import type { SimWorld } from '../support/world.js';
import type { JsonObject } from '../../../src/types.js';

// REQ-12: Invalid request payload rejected with contract-violation
When('I send a POST to {string} with an invalid body', async function (this: SimWorld, path: string) {
  // Send a wrong type for 'companyName' (schema says string, we send a number) — this triggers AJV validation
  await this.sendHttp('POST', path, { companyName: 12345, email: 'test@example.com' } as unknown as JsonObject);
});

Then('the response should be a contract violation error', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response captured');
  // 400 or the code CONTRACT_VIOLATION
  const isContractViolation =
    this.lastResponse.status === 400 ||
    (this.lastResponse.body as Record<string, unknown>)['code'] === 'CONTRACT_VIOLATION' ||
    (this.lastResponse.body as Record<string, unknown>)['error'] === 'CONTRACT_VIOLATION';
  assert.ok(
    isContractViolation,
    `Expected contract violation, got status=${this.lastResponse.status}, body=${JSON.stringify(this.lastResponse.body)}`,
  );
});

// REQ-13: Identity resolution - creation vs mutation intent
Then('a POST with identity.creation configured should produce a creation command', async function (this: SimWorld) {
  const before = this.getEventCount();
  const newId = `lead-${Date.now()}`;
  await this.sendHttp('POST', `/leads/${newId}`, { companyName: 'Dave Corp', contactName: 'Dave', email: 'dave@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201, 'POST should return 201 for creation');
  const after = this.getEventCount();
  assert.ok(after > before, 'A creation event should have been appended');
});

Then('the created resource should have a generated id', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response captured');
  const body = this.lastResponse.body as Record<string, unknown>;
  assert.ok(body['id'], 'Response should include a generated id');
  const id = body['id'] as string;
  assert.ok(id.length > 0, 'Generated id should not be empty');
});

// REQ-14: Request translated into standardised Command
Then('a PATCH to an existing resource should be treated as mutation', async function (this: SimWorld) {
  // First create
  const newId = `lead-eve-${Date.now()}`;
  await this.sendHttp('POST', `/leads/${newId}`, { companyName: 'Eve Corp', contactName: 'Eve', email: 'eve@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201);
  const id = (this.lastResponse?.body as Record<string, unknown>)['id'] as string;

  // Then mutate
  await this.sendHttp('PATCH', `/leads/${id}`, { companyName: 'Eve Corp Updated' });
  assert.strictEqual(this.lastResponse?.status, 200, 'PATCH should return 200 for mutation');
});

// REQ-15: Command routed to specific boundary
Then('the command should reach the correct boundary', async function (this: SimWorld) {
  // POST to /leads/{id} → Lead boundary
  const newId = `lead-frank-${Date.now()}`;
  await this.sendHttp('POST', `/leads/${newId}`, { companyName: 'Frank & Co', contactName: 'Frank', email: 'frank@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201);
  const body = this.lastResponse?.body as Record<string, unknown>;
  // Created entity should be a Lead with the right fields
  assert.ok(body['id'], 'Should have id');
  assert.strictEqual(body['companyName'], 'Frank & Co', 'Should have correct companyName from Lead boundary');
});

When('I create a lead with name {string} and email {string}', async function (this: SimWorld, name: string, email: string) {
  const newId = `lead-${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
  await this.sendHttp('POST', `/leads/${newId}`, { companyName: name, contactName: name, email });
});

Then('the lead should be persisted in the state graph', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response captured');
  const body = this.lastResponse.body as Record<string, unknown>;
  const id = body['id'] as string;
  const entity = this.getState(id);
  assert.ok(entity !== null, `Lead ${id} should be in state graph`);
});
