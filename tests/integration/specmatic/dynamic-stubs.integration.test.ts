/**
 * dynamic-stubs.integration.test.ts
 *
 * Tests that dynamic stubs intercept real HTTP requests, return the canned response,
 * and that the CQRS state graph is NOT mutated by stub-matched requests.
 */

import request from 'supertest';
import type { BootedSystem } from '../../../src/engine/boot.js';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';
import { expectation, postExpectation } from './_helpers/specmatic-format.js';

describe('dynamic-stubs.integration', () => {
  let agent: ReturnType<typeof request>;
  let sys: BootedSystem;

  beforeEach(async () => {
    const fixture = await loadBankingFixture();
    sys = await bootSystem(fixture);
    const app = createGateway(sys);
    agent = request(app);
  });

  it('GET /customers/:id returns stub canned response instead of CQRS response', async () => {
    const stubBody = { id: 'cust-1', name: 'Stubbed Customer', riskBand: 'HIGH' };

    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/cust-1' },
      { status: 200, body: stubBody },
    )).expect(200);

    const res = await agent.get('/customers/cust-1').expect(200);
    expect(res.body).toEqual(stubBody);
  });

  it('stub-matched response sets X-Specmatic-Result: success header', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/hdr-test' },
      { status: 200, body: { id: 'hdr-test', name: 'H', riskBand: 'LOW' } },
    )).expect(200);

    const res = await agent.get('/customers/hdr-test').expect(200);
    expect(res.headers['x-specmatic-result']).toBe('success');
  });

  it('stub-matched response sets X-Specmatic-Expectation-Id header', async () => {
    const postRes = await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/id-hdr-test' },
      { status: 200, body: { id: 'id-hdr-test', name: 'H', riskBand: 'LOW' } },
    )).expect(200);
    const expectationId = postRes.body.id as string;

    const res = await agent.get('/customers/id-hdr-test').expect(200);
    expect(res.headers['x-specmatic-expectation-id']).toBe(expectationId);
  });

  it('stub does not mutate the underlying state graph', async () => {
    const graphSizeBefore = sys.graph.size();
    const eventCountBefore = sys.events.size();

    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/no-mutation' },
      { status: 200, body: { id: 'no-mutation', name: 'N', riskBand: 'LOW' } },
    )).expect(200);

    await agent.get('/customers/no-mutation').expect(200);

    expect(sys.graph.size()).toBe(graphSizeBefore);
    expect(sys.events.size()).toBe(eventCountBefore);
  });

  it('after stub deletion the same path returns the CQRS response (404 for unknown entity)', async () => {
    const postRes = await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/cust-del-fallback' },
      { status: 200, body: { id: 'cust-del-fallback', name: 'Will Delete', riskBand: 'LOW' } },
    )).expect(200);
    const id = postRes.body.id as string;

    // Stub is active
    await agent.get('/customers/cust-del-fallback').expect(200);

    // Delete the stub
    await agent.delete(`/_specmatic/expectations/${id}`).expect(200);

    // Now falls through to CQRS — entity doesn't exist → 404
    await agent.get('/customers/cust-del-fallback').expect(404);
  });
});
