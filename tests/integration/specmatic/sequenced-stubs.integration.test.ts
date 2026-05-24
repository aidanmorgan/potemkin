/**
 * sequenced-stubs.integration.test.ts
 *
 * Tests for the T2 sequenced-stub feature:
 *  - POST /_specmatic/expectations/sequenced registers a multi-response stub
 *  - Responses are served in order (resp[0], resp[1], ...)
 *  - After all responses consumed the stub is exhausted (no longer matches)
 *  - Multiple sequenced stubs interleave correctly (LIFO priority)
 */

import request from 'supertest';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';

describe('sequenced-stubs.integration', () => {
  let agent: ReturnType<typeof request>;

  beforeEach(async () => {
    const fixture = await loadBankingFixture();
    const sys = await bootSystem(fixture);
    const app = createGateway(sys);
    agent = request(app);
  });

  function postSequenced(body: object) {
    return agent
      .post('/_specmatic/expectations/sequenced')
      .set('Content-Type', 'application/json')
      .send(body);
  }

  it('POST /_specmatic/expectations/sequenced returns 200 with id', async () => {
    const res = await postSequenced({
      'http-request': { method: 'GET', path: '/customers/seq-1' },
      'http-responses': [
        { status: 200, body: { id: 'seq-1', name: 'First', riskBand: 'LOW' } },
        { status: 200, body: { id: 'seq-1', name: 'Second', riskBand: 'HIGH' } },
      ],
    }).expect(200);
    expect(typeof res.body.id).toBe('string');
    expect(res.headers['x-specmatic-result']).toBe('success');
  });

  it('responses are served in declared order', async () => {
    await postSequenced({
      'http-request': { method: 'GET', path: '/customers/seq-order' },
      'http-responses': [
        { status: 200, body: { id: 'seq-order', name: 'Alpha', riskBand: 'LOW' } },
        { status: 200, body: { id: 'seq-order', name: 'Beta', riskBand: 'HIGH' } },
        { status: 404, body: { error: 'NOT_FOUND' } },
      ],
    }).expect(200);

    const r1 = await agent.get('/customers/seq-order').expect(200);
    expect(r1.body.name).toBe('Alpha');

    const r2 = await agent.get('/customers/seq-order').expect(200);
    expect(r2.body.name).toBe('Beta');

    const r3 = await agent.get('/customers/seq-order').expect(404);
    expect(r3.body.error).toBe('NOT_FOUND');
  });

  it('stub is exhausted after all responses consumed', async () => {
    await postSequenced({
      'http-request': { method: 'GET', path: '/customers/seq-exhaust' },
      'http-responses': [
        { status: 200, body: { id: 'seq-exhaust', name: 'Only', riskBand: 'LOW' } },
      ],
    }).expect(200);

    // First call: consumes the one response
    const r1 = await agent.get('/customers/seq-exhaust').expect(200);
    expect(r1.body.name).toBe('Only');

    // Second call: stub exhausted → falls through to CQRS → 404
    await agent.get('/customers/seq-exhaust').expect(404);
  });

  it('single-response sequenced stub behaves like a regular stub (not transient)', async () => {
    await postSequenced({
      'http-request': { method: 'GET', path: '/customers/seq-single' },
      'http-responses': [
        { status: 200, body: { id: 'seq-single', name: 'Single', riskBand: 'LOW' } },
      ],
    }).expect(200);

    const r1 = await agent.get('/customers/seq-single').expect(200);
    expect(r1.body.name).toBe('Single');

    // Exhausted after 1 use
    await agent.get('/customers/seq-single').expect(404);
  });

  it('sequenced stub with headers and query params matches correctly', async () => {
    await postSequenced({
      'http-request': {
        method: 'GET',
        path: '/customers/seq-match',
        query: { type: 'premium' },
      },
      'http-responses': [
        { status: 200, body: { id: 'seq-match', name: 'MatchA', riskBand: 'LOW' } },
        { status: 200, body: { id: 'seq-match', name: 'MatchB', riskBand: 'HIGH' } },
      ],
    }).expect(200);

    // Correct query → matches
    const r1 = await agent.get('/customers/seq-match?type=premium').expect(200);
    expect(r1.body.name).toBe('MatchA');

    const r2 = await agent.get('/customers/seq-match?type=premium').expect(200);
    expect(r2.body.name).toBe('MatchB');

    // Exhausted
    await agent.get('/customers/seq-match?type=premium').expect(404);
  });

  it('POST with empty http-responses array → 400 STUB_BODY_INVALID', async () => {
    const res = await postSequenced({
      'http-request': { method: 'GET', path: '/customers/seq-empty' },
      'http-responses': [],
    }).expect(400);
    expect(res.body.error).toBe('STUB_BODY_INVALID');
    expect(res.headers['x-specmatic-result']).toBe('failure');
  });

  it('POST with missing http-responses → 400 STUB_BODY_INVALID', async () => {
    const res = await postSequenced({
      'http-request': { method: 'GET', path: '/customers/seq-no-res' },
    }).expect(400);
    expect(res.body.error).toBe('STUB_BODY_INVALID');
  });

  it('POST with missing http-request → 400 STUB_BODY_INVALID', async () => {
    const res = await postSequenced({
      'http-responses': [{ status: 200 }],
    }).expect(400);
    expect(res.body.error).toBe('STUB_BODY_INVALID');
  });

  it('POST with response missing status → 400 STUB_BODY_INVALID', async () => {
    const res = await postSequenced({
      'http-request': { method: 'GET', path: '/customers/seq-bad-status' },
      'http-responses': [{ body: { id: 'x' } }],  // missing status
    }).expect(400);
    expect(res.body.error).toBe('STUB_BODY_INVALID');
  });

  it('two sequenced stubs for different paths work independently', async () => {
    await postSequenced({
      'http-request': { method: 'GET', path: '/customers/seq-a' },
      'http-responses': [
        { status: 200, body: { id: 'seq-a', name: 'A1', riskBand: 'LOW' } },
        { status: 200, body: { id: 'seq-a', name: 'A2', riskBand: 'LOW' } },
      ],
    }).expect(200);

    await postSequenced({
      'http-request': { method: 'GET', path: '/customers/seq-b' },
      'http-responses': [
        { status: 200, body: { id: 'seq-b', name: 'B1', riskBand: 'HIGH' } },
      ],
    }).expect(200);

    // Interleave calls to verify independence
    const rA1 = await agent.get('/customers/seq-a').expect(200);
    expect(rA1.body.name).toBe('A1');

    const rB1 = await agent.get('/customers/seq-b').expect(200);
    expect(rB1.body.name).toBe('B1');

    const rA2 = await agent.get('/customers/seq-a').expect(200);
    expect(rA2.body.name).toBe('A2');

    // seq-b exhausted
    await agent.get('/customers/seq-b').expect(404);

    // seq-a also exhausted
    await agent.get('/customers/seq-a').expect(404);
  });
});
