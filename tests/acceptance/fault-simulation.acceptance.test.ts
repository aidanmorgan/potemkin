/**
 * fault-simulation.acceptance.test.ts
 *
 * Acceptance test: set `x-specmatic-fault` header → server returns the
 * canned status+body without touching state.
 */

import { createTestApp, type TestApp } from './_helpers/test-app.js';

describe('fault-simulation.acceptance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  it('x-specmatic-fault header returns the canned status', async () => {
    const fault = JSON.stringify({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } });

    await app.agent
      .post('/customers')
      .set('x-specmatic-fault', fault)
      .send({ name: 'Ghost', riskBand: 'LOW' })
      .expect(503);
  });

  it('x-specmatic-fault header returns the canned body', async () => {
    const fault = JSON.stringify({ status: 503, body: { error: 'SERVICE_UNAVAILABLE', detail: 'planned' } });

    const res = await app.agent
      .post('/customers')
      .set('x-specmatic-fault', fault)
      .send({ name: 'Ghost', riskBand: 'LOW' });

    expect(res.body).toEqual({ error: 'SERVICE_UNAVAILABLE', detail: 'planned' });
  });

  it('fault-simulated request does not create an entity in the state graph', async () => {
    const graphSizeBefore = app.sys.graph.size();
    const fault = JSON.stringify({ status: 503, body: {} });

    await app.agent
      .post('/customers')
      .set('x-specmatic-fault', fault)
      .send({ name: 'Ghost', riskBand: 'LOW' });

    expect(app.sys.graph.size()).toBe(graphSizeBefore);
  });

  it('fault-simulated GET request returns canned response without hitting the graph', async () => {
    const fault = JSON.stringify({ status: 429, body: { error: 'RATE_LIMITED' } });

    const res = await app.agent
      .get('/customers')
      .set('x-specmatic-fault', fault)
      .expect(429);

    expect(res.body).toEqual({ error: 'RATE_LIMITED' });
  });

  it('canned headers from the fault signal are forwarded to the response', async () => {
    const fault = JSON.stringify({
      status: 503,
      body: {},
      headers: { 'retry-after': '120' },
    });

    const res = await app.agent
      .get('/customers')
      .set('x-specmatic-fault', fault);

    expect(res.headers['retry-after']).toBe('120');
  });

  it('a request without the fault header is processed normally', async () => {
    await app.agent
      .post('/customers')
      .send({ name: 'Real Customer', riskBand: 'LOW' })
      .expect(201);
  });
});
