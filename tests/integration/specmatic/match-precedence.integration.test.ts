/**
 * match-precedence.integration.test.ts
 *
 * Tests the LIFO match ordering and precedence rules between dynamic stubs,
 * file-source stubs, and the CQRS fallback.
 */

import request from 'supertest';
import type { BootedSystem } from '../../../src/engine/boot.js';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';
import { expectation, postExpectation } from './_helpers/specmatic-format.js';

describe('match-precedence.integration', () => {
  let agent: ReturnType<typeof request>;
  let sys: BootedSystem;

  beforeEach(async () => {
    const fixture = await loadBankingFixture();
    sys = await bootSystem(fixture);
    const app = createGateway(sys);
    agent = request(app);
  });

  it('newest stub wins over older stubs for same path (LIFO)', async () => {
    // Register 3 stubs for the same path — each uses a valid Customer body
    // distinguished by the 'name' field
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/lifo-test' },
      { status: 200, body: { id: 'lifo-test', name: 'First', riskBand: 'LOW' } },
    )).expect(200);

    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/lifo-test' },
      { status: 200, body: { id: 'lifo-test', name: 'Second', riskBand: 'LOW' } },
    )).expect(200);

    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/lifo-test' },
      { status: 200, body: { id: 'lifo-test', name: 'Third', riskBand: 'LOW' } },
    )).expect(200);

    // The newest (Third) should match first per LIFO
    const res = await agent.get('/customers/lifo-test').expect(200);
    expect(res.body.name).toBe('Third');
  });

  it('dynamic stub wins over CQRS even when OpenAPI route matches', async () => {
    // The ACME customer exists in CQRS state — stub overrides it
    const ACME_ID = '00000000-0000-7000-8000-000000000001';
    const stubbedBody = { id: ACME_ID, name: 'Overridden By Stub', riskBand: 'HIGH' };

    // Confirm CQRS returns the real entity without stub
    const cqrsRes = await agent.get(`/customers/${ACME_ID}`).expect(200);
    expect(cqrsRes.body.name).toBe('Acme Coffee');

    // Register stub for same path
    await postExpectation(agent, expectation(
      { method: 'GET', path: `/customers/${ACME_ID}` },
      { status: 200, body: stubbedBody },
    )).expect(200);

    // Stub wins
    const stubRes = await agent.get(`/customers/${ACME_ID}`).expect(200);
    expect(stubRes.body.name).toBe('Overridden By Stub');
  });

  it('file-source stubs compete with dynamic stubs by insertion order', async () => {
    // Manually add a file-source stub directly to the store (bypassing HTTP validation)
    const filePath = '/fake/path/stub.json';
    const fileSourceStub = sys.expectations.add(
      { method: 'GET', path: '/customers/file-vs-dynamic' },
      { status: 200, body: { id: 'file-vs-dynamic', name: 'From File', riskBand: 'LOW' } },
      { source: 'file', filePath },
    );

    // Then add a dynamic stub after — dynamic is newer so it should win (LIFO)
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/file-vs-dynamic' },
      { status: 200, body: { id: 'file-vs-dynamic', name: 'From Dynamic', riskBand: 'LOW' } },
    )).expect(200);

    const res = await agent.get('/customers/file-vs-dynamic').expect(200);
    expect(res.body.name).toBe('From Dynamic');

    // Clean up
    sys.expectations.remove(fileSourceStub.id);
  });

  it('non-matching stub (wrong method) is skipped; CQRS handler takes over', async () => {
    // Register a stub for a different method. The stub route and response for
    // POST /customers uses a valid Customer body (status 201).
    // We add it directly to the store to bypass HTTP validation of the stub endpoint.
    sys.expectations.add(
      { method: 'POST', path: '/customers/method-skip' },
      { status: 201, body: { id: 'method-skip', name: 'Post Only', riskBand: 'LOW' } },
    );

    // GET request should fall through to CQRS → 404 (entity doesn't exist)
    await agent.get('/customers/method-skip').expect(404);
  });

  it('older stubs are still accessible after the newest is deleted', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/cascade-del' },
      { status: 200, body: { id: 'cascade-del', name: 'First Version', riskBand: 'LOW' } },
    )).expect(200);

    const secondRes = await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/cascade-del' },
      { status: 200, body: { id: 'cascade-del', name: 'Second Version', riskBand: 'LOW' } },
    )).expect(200);

    // Delete the newest
    await agent.delete(`/_specmatic/expectations/${secondRes.body.id}`).expect(200);

    // Now the older (First Version) should match
    const res = await agent.get('/customers/cascade-del').expect(200);
    expect(res.body.name).toBe('First Version');
  });
});
