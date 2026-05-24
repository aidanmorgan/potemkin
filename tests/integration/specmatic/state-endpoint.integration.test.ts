/**
 * state-endpoint.integration.test.ts
 *
 * Tests for T2 /_specmatic/state endpoints:
 *  - GET /_specmatic/state returns Specmatic-style empty-state shape
 *  - POST /_specmatic/state is a no-op that accepts any body
 *  - Also tests POST /_specmatic/expectations/clear alias
 */

import request from 'supertest';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';
import { expectation, postExpectation } from './_helpers/specmatic-format.js';

describe('state-endpoint.integration', () => {
  let agent: ReturnType<typeof request>;

  beforeEach(async () => {
    const fixture = await loadBankingFixture();
    const sys = await bootSystem(fixture);
    const app = createGateway(sys);
    agent = request(app);
  });

  // ── GET /_specmatic/state ────────────────────────────────────────────────────

  it('GET /_specmatic/state returns 200', async () => {
    await agent.get('/_specmatic/state').expect(200);
  });

  it('GET /_specmatic/state sets X-Specmatic-Result: success', async () => {
    const res = await agent.get('/_specmatic/state').expect(200);
    expect(res.headers['x-specmatic-result']).toBe('success');
  });

  it('GET /_specmatic/state returns canonical empty-state shape with scenarios array', async () => {
    const res = await agent.get('/_specmatic/state').expect(200);
    expect(Array.isArray(res.body.scenarios)).toBe(true);
    expect(res.body.scenarios).toEqual([]);
  });

  it('GET /_specmatic/state returns state object', async () => {
    const res = await agent.get('/_specmatic/state').expect(200);
    expect(typeof res.body.state).toBe('object');
    expect(res.body.state).toEqual({});
  });

  it('GET /_specmatic/state returns expectations count matching current store size', async () => {
    const res1 = await agent.get('/_specmatic/state').expect(200);
    const countBefore = res1.body.expectations as number;

    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/state-count' },
      { status: 200, body: { id: 'state-count', name: 'SC', riskBand: 'LOW' } },
    )).expect(200);

    const res2 = await agent.get('/_specmatic/state').expect(200);
    expect(res2.body.expectations).toBe(countBefore + 1);
    expect(res2.body.stubs).toBe(countBefore + 1);
  });

  // ── POST /_specmatic/state ────────────────────────────────────────────────────

  it('POST /_specmatic/state returns 200', async () => {
    await agent
      .post('/_specmatic/state')
      .set('Content-Type', 'application/json')
      .send({ someState: 'value' })
      .expect(200);
  });

  it('POST /_specmatic/state sets X-Specmatic-Result: success', async () => {
    const res = await agent
      .post('/_specmatic/state')
      .set('Content-Type', 'application/json')
      .send({ key: 'value' })
      .expect(200);
    expect(res.headers['x-specmatic-result']).toBe('success');
  });

  it('POST /_specmatic/state is a no-op — does not affect expectations', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/state-noop' },
      { status: 200, body: { id: 'state-noop', name: 'NoOp', riskBand: 'LOW' } },
    )).expect(200);

    await agent
      .post('/_specmatic/state')
      .set('Content-Type', 'application/json')
      .send({ clearAll: true })
      .expect(200);

    // Stub should still be active after POST /state
    const res = await agent.get('/customers/state-noop').expect(200);
    expect(res.body.id).toBe('state-noop');
  });

  it('POST /_specmatic/state accepts empty body', async () => {
    await agent
      .post('/_specmatic/state')
      .set('Content-Type', 'application/json')
      .send({})
      .expect(200);
  });

  it('POST /_specmatic/state accepts no body', async () => {
    await agent
      .post('/_specmatic/state')
      .expect(200);
  });

  // ── POST /_specmatic/expectations/clear (alias) ──────────────────────────────

  it('POST /_specmatic/expectations/clear returns 200', async () => {
    await agent
      .post('/_specmatic/expectations/clear')
      .expect(200);
  });

  it('POST /_specmatic/expectations/clear sets X-Specmatic-Result: success', async () => {
    const res = await agent
      .post('/_specmatic/expectations/clear')
      .expect(200);
    expect(res.headers['x-specmatic-result']).toBe('success');
  });

  it('POST /_specmatic/expectations/clear removes all expectations', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/clear-test' },
      { status: 200, body: { id: 'clear-test', name: 'CT', riskBand: 'LOW' } },
    )).expect(200);

    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/clear-test-2' },
      { status: 200, body: { id: 'clear-test-2', name: 'CT2', riskBand: 'LOW' } },
    )).expect(200);

    // POST clear alias
    const clearRes = await agent.post('/_specmatic/expectations/clear').expect(200);
    expect(typeof clearRes.body.cleared).toBe('number');
    expect(clearRes.body.cleared).toBeGreaterThanOrEqual(2);

    // Verify stubs gone
    const listRes = await agent.get('/_specmatic/expectations').expect(200);
    expect(listRes.body).toEqual([]);
  });

  it('POST /_specmatic/expectations/clear returns cleared count', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/count-clear' },
      { status: 200, body: { id: 'count-clear', name: 'CC', riskBand: 'LOW' } },
    )).expect(200);

    const res = await agent.post('/_specmatic/expectations/clear').expect(200);
    expect(res.body.cleared).toBe(1);
  });

  it('POST /_specmatic/expectations/clear on empty store returns cleared: 0', async () => {
    const res = await agent.post('/_specmatic/expectations/clear').expect(200);
    expect(res.body.cleared).toBe(0);
  });
});
