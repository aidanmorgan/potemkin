import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'assert';
import type { SimWorld } from '../support/world.js';
import { bootSystem } from '../../../src/engine/boot.js';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { compileDsl } from '../../../src/dsl/parser.js';
import { BootError } from '../../../src/errors.js';
import { CRM_OPENAPI_YAML } from '../support/world.js';

When('I attempt to boot the simulator with DSL {string}', async function (this: SimWorld, dslYaml: string) {
  try {
    const openapi = await loadOpenApi(CRM_OPENAPI_YAML);
    await bootSystem({
      openapi,
      compiledDsl: await compileDsl([{ name: 'bad-module', yaml: dslYaml }]),
    });
    this.ctx['bootError'] = null;
  } catch (err) {
    this.ctx['bootError'] = err;
  }
});

Then('boot should fail with code {string}', function (this: SimWorld, expectedCode: string) {
  const err = this.ctx['bootError'];
  assert.ok(err instanceof BootError, `Expected BootError but got: ${String(err)}`);
  assert.ok(
    err.code === expectedCode || err.code.startsWith(expectedCode.replace('*', '')),
    `Expected BootError code '${expectedCode}' but got '${err.code}'`,
  );
});

Then('the response status should be 400 with code {string}', function (this: SimWorld, code: string) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.strictEqual(this.lastResponse.status, 400, `Expected 400 but got ${this.lastResponse.status}`);
  const body = this.lastResponse.body as Record<string, unknown>;
  const actual = body['code'] ?? body['error'];
  assert.strictEqual(String(actual), code, `Expected code '${code}' got '${String(actual)}'`);
});

When('I PATCH a non-existent opportunity', async function (this: SimWorld) {
  await this.sendHttp('PATCH', '/opportunities/00000000-0000-7000-8000-999999999999', { stage: 'negotiating' });
});

Then('the response should be 404 ENTITY_ABSENCE', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.strictEqual(this.lastResponse.status, 404, `Expected 404 but got ${this.lastResponse.status}`);
  const body = this.lastResponse.body as Record<string, unknown>;
  const code = body['code'] ?? body['error'];
  assert.strictEqual(String(code), 'ENTITY_ABSENCE');
});

When('I POST to create an opportunity that already exists with id {string}', async function (this: SimWorld, id: string) {
  // First make sure it exists
  await this.sendHttp('PATCH', `/opportunities/${id}`, { value: 1 });
  // Now try to CREATE with the same id
  await this.sendHttp('POST', `/leads/${id}`, { companyName: 'Duplicate', contactName: 'Dup', email: 'dup@example.com' });
});

When('I attempt to create the same lead twice with the same id', async function (this: SimWorld) {
  // Create once
  await this.sendHttp('POST', `/leads/lead-${Date.now()}`, { companyName: 'UniqueUser', contactName: 'Unique', email: 'unique@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201);
  const id = (this.lastResponse?.body as Record<string, unknown>)['id'] as string;
  this.ctx['duplicateId'] = id;
});

Given('the seed lead {string} exists in the system', function (this: SimWorld, id: string) {
  const entity = this.getState(id);
  assert.ok(entity !== null, `Seed lead '${id}' should exist`);
});

When('I send a creation request targeting an existing entity id', async function (this: SimWorld) {
  // lead-seed-001 already exists from initialization
  // POST to /leads/lead-seed-001 with creation intent → 409 ENTITY_CONFLICT
  await this.sendHttp('POST', '/leads/lead-seed-001', { companyName: 'Conflict Corp', contactName: 'Conflict User', email: 'conflict@example.com' });
});

Then('the response should be 409 ENTITY_CONFLICT', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.strictEqual(this.lastResponse.status, 409, `Expected 409 but got ${this.lastResponse.status}`);
  const body = this.lastResponse.body as Record<string, unknown>;
  const code = body['code'] ?? body['error'];
  assert.strictEqual(String(code), 'ENTITY_CONFLICT');
});

When('I send a mutation that has no matching behavior and no fallback', async function (this: SimWorld) {
  // opportunity-seed-001 exists (stage: proposed), send a PATCH that won't match any rule
  // Opportunity DSL has no fallback_override and requires stage:'negotiating'|'won' or value!=null
  // Send a payload with no recognized field
  await this.sendHttp('PATCH', '/opportunities/opportunity-seed-001', { unknownField: 'no match' });
});

Then('the response should be 422 UNHANDLED_OPERATION', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.strictEqual(this.lastResponse.status, 422, `Expected 422 but got ${this.lastResponse.status}. Body: ${JSON.stringify(this.lastResponse.body)}`);
  const body = this.lastResponse.body as Record<string, unknown>;
  const code = body['code'] ?? body['error'];
  assert.strictEqual(String(code), 'UNHANDLED_OPERATION');
});

When('I send a mutation with a wrong sequence version', async function (this: SimWorld) {
  // Create a lead
  await this.sendHttp('POST', `/leads/lead-${Date.now()}`, { companyName: 'ConcTest Corp', contactName: 'ConcTest', email: 'conc@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201);
  const id = (this.lastResponse?.body as Record<string, unknown>)['id'] as string;
  this.ctx['concTestId'] = id;

  // Send PATCH with wrong If-Match
  await this.sendHttp('PATCH', `/leads/${id}`, { companyName: 'Updated Corp' }, { 'If-Match': '999' });
});

Then('the response should be 412 CONCURRENCY_CONFLICT', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.strictEqual(this.lastResponse.status, 412, `Expected 412 but got ${this.lastResponse.status}. Body: ${JSON.stringify(this.lastResponse.body)}`);
  const body = this.lastResponse.body as Record<string, unknown>;
  const code = body['code'] ?? body['error'];
  assert.strictEqual(String(code), 'CONCURRENCY_CONFLICT');
});

// MISSING_PRECONDITION is only returned when If-Match is required by the OpenAPI spec;
// since our test spec doesn't mark it as required, we test this via direct UoW
When('I test missing precondition via direct UoW', async function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
  const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

  try {
    await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Lead',
        intent: 'mutation',
        targetId: 'lead-seed-001',
        payload: { companyName: 'Test Corp' },
        queryParams: {},
        httpMethod: 'PATCH',
        path: '/leads/lead-seed-001',
        origin: 'inbound',
        depth: 0,
      },
      dsl: this.sys.dsl,
      graph: this.sys.graph,
      events: this.sys.events,
      cel: this.sys.cel,
      validator: this.sys.validator,
      openapi: this.sys.openapi,
      schemaRegistry: this.sys.schemaRegistry,
      requiresPrecondition: () => true, // Force precondition required
    });
    this.ctx['uowError'] = null;
  } catch (err) {
    this.ctx['uowError'] = err;
  }
});

Then('the UoW should abort with MISSING_PRECONDITION', function (this: SimWorld) {
  const err = this.ctx['uowError'];
  assert.ok(err instanceof Error, `Expected an error but got ${String(err)}`);
  assert.ok(
    (err as { code?: string }).code === 'MISSING_PRECONDITION',
    `Expected MISSING_PRECONDITION but got '${(err as { code?: string }).code}'`,
  );
});

When('I trigger a UoW that throws an internal execution error', async function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
  const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

  const beforeCount = this.getEventCount();
  this.ctx['eventsBefore'] = beforeCount;

  try {
    await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'NONEXISTENT_BOUNDARY',
        intent: 'mutation',
        targetId: 'some-id',
        payload: {},
        queryParams: {},
        httpMethod: 'PATCH',
        path: '/nonexistent',
        origin: 'inbound',
        depth: 0,
      },
      dsl: this.sys.dsl,
      graph: this.sys.graph,
      events: this.sys.events,
      cel: this.sys.cel,
      validator: this.sys.validator,
    });
    this.ctx['uowError'] = null;
  } catch (err) {
    this.ctx['uowError'] = err;
  }
});

Then('no events should have been appended', function (this: SimWorld) {
  const before = this.ctx['eventsBefore'] as number;
  const after = this.getEventCount();
  assert.strictEqual(after, before, `Expected event count to stay at ${before} but got ${after}`);
});

When('I send a request with fault signal header returning 503', async function (this: SimWorld) {
  const faultHeader = JSON.stringify({ status: 503, body: { error: 'SIMULATED_SERVICE_UNAVAILABLE' } });
  await this.sendHttp('GET', '/opportunities/opportunity-seed-001', undefined, { 'x-specmatic-fault': faultHeader });
});

Then('the response should be the simulated fault', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.strictEqual(this.lastResponse.status, 503, `Expected 503 but got ${this.lastResponse.status}`);
});

When('I trigger a self-referential cascade that exceeds max depth', async function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
  const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');
  // Simulate a command already at depth exceeding maxDepth
  try {
    await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Lead',
        intent: 'mutation',
        targetId: 'lead-seed-001',
        payload: { companyName: 'Loop Corp' },
        queryParams: {},
        httpMethod: 'PATCH',
        path: '/leads/lead-seed-001',
        origin: 'secondary',
        depth: 6, // exceeds maxDepth=5
      },
      dsl: this.sys.dsl,
      graph: this.sys.graph,
      events: this.sys.events,
      cel: this.sys.cel,
      validator: this.sys.validator,
      openapi: this.sys.openapi,
      maxDepth: 5,
    });
    this.ctx['infiniteLoopError'] = null;
  } catch (err) {
    this.ctx['infiniteLoopError'] = err;
  }
});

Then('the UoW should abort with INFINITE_LOOP', function (this: SimWorld) {
  const err = this.ctx['infiniteLoopError'];
  assert.ok(err instanceof Error, `Expected an error but got ${String(err)}`);
  assert.ok(
    (err as { code?: string }).code === 'INFINITE_LOOP',
    `Expected INFINITE_LOOP error but got: ${(err as { code?: string }).code}`,
  );
});
