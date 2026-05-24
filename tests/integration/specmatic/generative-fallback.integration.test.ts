/**
 * generative-fallback.integration.test.ts
 *
 * Tests that with no stubs registered the CQRS pipeline handles requests normally,
 * and after clearing all stubs the behavior reverts to stub-free operation.
 */

import request from 'supertest';
import type { BootedSystem } from '../../../src/engine/boot.js';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';
import { expectation, postExpectation } from './_helpers/specmatic-format.js';

describe('generative-fallback.integration', () => {
  let agent: ReturnType<typeof request>;
  let sys: BootedSystem;
  const ACME_ID = '00000000-0000-7000-8000-000000000001';

  beforeEach(async () => {
    const fixture = await loadBankingFixture();
    sys = await bootSystem(fixture);
    const app = createGateway(sys);
    agent = request(app);
  });

  it('with NO stubs, a CQRS-routed request works normally (GET existing entity)', async () => {
    expect(sys.expectations.size()).toBe(0);
    const res = await agent.get(`/customers/${ACME_ID}`).expect(200);
    expect(res.body.name).toBe('Acme Coffee');
  });

  it('with NO stubs, POST /customers creates a real entity in the state graph', async () => {
    const graphSizeBefore = sys.graph.size();
    await agent
      .post('/customers')
      .send({ name: 'New Customer', riskBand: 'LOW' })
      .expect(201);
    expect(sys.graph.size()).toBe(graphSizeBefore + 1);
  });

  it('after clearing all stubs, behavior is identical to no-stubs (CQRS query works)', async () => {
    // Add a stub for the ACME path using a valid Customer schema body
    await postExpectation(agent, expectation(
      { method: 'GET', path: `/customers/${ACME_ID}` },
      { status: 200, body: { id: ACME_ID, name: 'Stubbed Acme', riskBand: 'HIGH' } },
    )).expect(200);

    // Verify stub is active
    const stubRes = await agent.get(`/customers/${ACME_ID}`).expect(200);
    expect(stubRes.body.name).toBe('Stubbed Acme');

    // Clear all stubs
    await agent.delete('/_specmatic/expectations').expect(200);

    // Now CQRS takes over again
    const cqrsRes = await agent.get(`/customers/${ACME_ID}`).expect(200);
    expect(cqrsRes.body.name).toBe('Acme Coffee');
  });

  it('a request that matches no stub AND no OpenAPI route → 404 catch-all', async () => {
    // /nonexistent-path is not in the OpenAPI spec
    await agent.get('/nonexistent-path').expect(404);
  });

  it('after clearing, state graph mutation still works normally', async () => {
    // Add and clear a stub — response body is a valid Customer for POST /customers → 201
    await postExpectation(agent, expectation(
      { method: 'POST', path: '/customers' },
      { status: 201, body: { id: 'stub-cust', name: 'Stub', riskBand: 'LOW' } },
    )).expect(200);
    await agent.delete('/_specmatic/expectations').expect(200);

    // CQRS creation should work
    const graphSizeBefore = sys.graph.size();
    await agent
      .post('/customers')
      .send({ name: 'Post-Clear Customer', riskBand: 'MED' })
      .expect(201);
    expect(sys.graph.size()).toBe(graphSizeBefore + 1);
  });
});
