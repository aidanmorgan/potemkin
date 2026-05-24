/**
 * transient-http-stub.integration.test.ts
 *
 * Tests for /_specmatic/http-stub (transient stubs that are evicted after first use).
 */

import request from 'supertest';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';
import { expectation, postTransientStub } from './_helpers/specmatic-format.js';

describe('transient-http-stub.integration', () => {
  let agent: ReturnType<typeof request>;

  beforeEach(async () => {
    const fixture = await loadBankingFixture();
    const sys = await bootSystem(fixture);
    const app = createGateway(sys);
    agent = request(app);
  });

  it('POST /_specmatic/http-stub registers a transient stub → 200 with id', async () => {
    const res = await postTransientStub(agent, expectation(
      { method: 'GET', path: '/customers/transient-1' },
      { status: 200, body: { id: 'transient-1', name: 'Transient', riskBand: 'LOW' } },
    )).expect(200);
    expect(typeof res.body.id).toBe('string');
    expect(res.body.transient).toBe(true);
  });

  it('first request to a transient stub returns the canned response', async () => {
    await postTransientStub(agent, expectation(
      { method: 'GET', path: '/customers/transient-once' },
      { status: 200, body: { id: 'transient-once', name: 'Once Only', riskBand: 'LOW' } },
    )).expect(200);

    const res = await agent.get('/customers/transient-once').expect(200);
    expect(res.body).toEqual({ id: 'transient-once', name: 'Once Only', riskBand: 'LOW' });
  });

  it('second request after transient stub eviction returns CQRS fallback (404)', async () => {
    await postTransientStub(agent, expectation(
      { method: 'GET', path: '/customers/transient-evict' },
      { status: 200, body: { id: 'transient-evict', name: 'Evictable', riskBand: 'LOW' } },
    )).expect(200);

    // First request — stub matches and is consumed
    await agent.get('/customers/transient-evict').expect(200);

    // Second request — stub is gone; falls through to CQRS which returns 404
    await agent.get('/customers/transient-evict').expect(404);
  });

  it('DELETE /_specmatic/http-stub/:id removes transient stub before it is used', async () => {
    const postRes = await postTransientStub(agent, expectation(
      { method: 'GET', path: '/customers/transient-pre-delete' },
      { status: 200, body: { id: 'transient-pre-delete', name: 'Pre-Delete', riskBand: 'LOW' } },
    )).expect(200);
    const stubId = postRes.body.id as string;

    // Delete before any request uses it
    const delRes = await agent.delete(`/_specmatic/http-stub/${stubId}`).expect(200);
    expect(delRes.body.removed).toBe(true);

    // Now the path falls through to CQRS → 404
    await agent.get('/customers/transient-pre-delete').expect(404);
  });

  it('DELETE /_specmatic/http-stub/:id on a non-transient expectation also succeeds (tolerant)', async () => {
    // Register a normal (non-transient) expectation via /_specmatic/expectations
    const postRes = await agent
      .post('/_specmatic/expectations')
      .set('Content-Type', 'application/json')
      .send(expectation(
        { method: 'GET', path: '/customers/non-transient-via-stub-del' },
        { status: 200, body: { id: 'ntvsd', name: 'NT', riskBand: 'LOW' } },
      ))
      .expect(200);
    const id = postRes.body.id as string;

    // Delete via the http-stub endpoint — spec says no 404 in that case
    const delRes = await agent.delete(`/_specmatic/http-stub/${id}`).expect(200);
    expect(delRes.headers['x-specmatic-result']).toBe('success');
    expect(delRes.body.id).toBe(id);
  });

  it('DELETE /_specmatic/http-stub/:id on unknown id → 200 (tolerant, removed: false)', async () => {
    const delRes = await agent
      .delete('/_specmatic/http-stub/00000000-0000-7000-8000-nonexistent1')
      .expect(200);
    expect(delRes.headers['x-specmatic-result']).toBe('success');
    expect(delRes.body.removed).toBe(false);
  });
});
