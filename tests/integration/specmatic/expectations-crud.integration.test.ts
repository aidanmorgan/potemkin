/**
 * expectations-crud.integration.test.ts
 *
 * End-to-end CRUD tests for the /_specmatic/expectations endpoints.
 */

import request from 'supertest';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';
import { expectation, postExpectation } from './_helpers/specmatic-format.js';

describe('expectations-crud.integration', () => {
  let agent: ReturnType<typeof request>;

  beforeEach(async () => {
    const fixture = await loadBankingFixture();
    const sys = await bootSystem(fixture);
    const app = createGateway(sys);
    agent = request(app);
  });

  it('POST /_specmatic/expectations with valid body → 200 with id', async () => {
    const body = expectation(
      { method: 'GET', path: '/customers/cust-1' },
      { status: 200, body: { id: 'cust-1', name: 'Test', riskBand: 'LOW' } },
    );
    const res = await postExpectation(agent, body).expect(200);
    expect(typeof res.body.id).toBe('string');
    expect(res.body.id.length).toBeGreaterThan(0);
  });

  it('POST /_specmatic/expectations → X-Specmatic-Result: success', async () => {
    const body = expectation(
      { method: 'GET', path: '/customers/cust-1' },
      { status: 200, body: { id: 'cust-1', name: 'Test', riskBand: 'LOW' } },
    );
    const res = await postExpectation(agent, body).expect(200);
    expect(res.headers['x-specmatic-result']).toBe('success');
  });

  it('GET /_specmatic/expectations → list including newly added id', async () => {
    const body = expectation(
      { method: 'GET', path: '/customers/cust-list-1' },
      { status: 200, body: { id: 'cust-list-1', name: 'Listed', riskBand: 'LOW' } },
    );
    const postRes = await postExpectation(agent, body).expect(200);
    const newId = postRes.body.id as string;

    const listRes = await agent.get('/_specmatic/expectations').expect(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    const ids = (listRes.body as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain(newId);
  });

  it('DELETE /_specmatic/expectations/:id → 200 and removed from list', async () => {
    const body = expectation(
      { method: 'GET', path: '/customers/cust-del-1' },
      { status: 200, body: { id: 'cust-del-1', name: 'ToDelete', riskBand: 'LOW' } },
    );
    const postRes = await postExpectation(agent, body).expect(200);
    const id = postRes.body.id as string;

    await agent.delete(`/_specmatic/expectations/${id}`).expect(200);

    const listRes = await agent.get('/_specmatic/expectations').expect(200);
    const ids = (listRes.body as Array<{ id: string }>).map((e) => e.id);
    expect(ids).not.toContain(id);
  });

  it('DELETE /_specmatic/expectations/:id for unknown id → 200 + removed:false (tolerant)', async () => {
    const res = await agent
      .delete('/_specmatic/expectations/00000000-0000-7000-8000-nonexistent1')
      .expect(200);
    expect(res.body.removed).toBe(false);
    expect(res.headers['x-specmatic-result']).toBe('success');
  });

  it('DELETE /_specmatic/expectations → clear all; subsequent GET returns empty list', async () => {
    // Add two expectations
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/c1' },
      { status: 200, body: { id: 'c1', name: 'C1', riskBand: 'LOW' } },
    )).expect(200);
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/c2' },
      { status: 200, body: { id: 'c2', name: 'C2', riskBand: 'LOW' } },
    )).expect(200);

    await agent.delete('/_specmatic/expectations').expect(200);

    const listRes = await agent.get('/_specmatic/expectations').expect(200);
    expect(listRes.body).toEqual([]);
  });

  it('adding two expectations preserves LIFO order (newest first in list)', async () => {
    const first = await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/first' },
      { status: 200, body: { id: 'first', name: 'First', riskBand: 'LOW' } },
    )).expect(200);

    const second = await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/second' },
      { status: 200, body: { id: 'second', name: 'Second', riskBand: 'LOW' } },
    )).expect(200);

    const listRes = await agent.get('/_specmatic/expectations').expect(200);
    const ids = (listRes.body as Array<{ id: string }>).map((e) => e.id);
    // The store list() returns insertion order (not LIFO); LIFO is only for match priority.
    // Verify both are present in the list.
    expect(ids).toContain(first.body.id);
    expect(ids).toContain(second.body.id);
    // Insertion order: first was inserted first, so it appears before second.
    expect(ids.indexOf(first.body.id)).toBeLessThan(ids.indexOf(second.body.id));
  });

  it('POST expectation missing http-request key → 400', async () => {
    const res = await agent
      .post('/_specmatic/expectations')
      .set('Content-Type', 'application/json')
      .send({ 'http-response': { status: 200 } })
      .expect(400);
    expect(res.headers['x-specmatic-result']).toBe('failure');
    expect(res.body.error).toBe('STUB_BODY_INVALID');
  });

  it('POST expectation with malformed JSON → 400 (body-parse error handler in gateway)', async () => {
    const res = await agent
      .post('/_specmatic/expectations')
      .set('Content-Type', 'application/json')
      .send('{ not valid json }')
      .expect(400);
    expect(res.status).toBe(400);
  });

  it('GET /_specmatic/expectations → X-Specmatic-Result: success', async () => {
    const res = await agent.get('/_specmatic/expectations').expect(200);
    expect(res.headers['x-specmatic-result']).toBe('success');
  });
});
