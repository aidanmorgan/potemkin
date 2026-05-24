/**
 * cqrs-coexistence.integration.test.ts
 *
 * The critical end-to-end test: stubs and CQRS coexist without interfering.
 *
 * Scenario:
 *  1. Boot engine with banking fixture.
 *  2. Register a stub for GET /loans/loan-x returning a CQRS-impossible value.
 *  3. Verify GET /loans/loan-x returns the stub's body.
 *  4. POST /loans with a real principal → CQRS creates a loan normally.
 *  5. GET /loans/loan-x again → still returns the stub (not the created loan).
 *  6. DELETE /_specmatic/expectations (clear all stubs).
 *  7. GET /loans/loan-x → 404 (no CQRS entity for "loan-x").
 */

import request from 'supertest';
import type { BootedSystem } from '../../../src/engine/boot.js';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';
import { expectation, postExpectation } from './_helpers/specmatic-format.js';

const ACME_ID = '00000000-0000-7000-8000-000000000001';

describe('cqrs-coexistence.integration', () => {
  let agent: ReturnType<typeof request>;
  let sys: BootedSystem;

  beforeEach(async () => {
    const fixture = await loadBankingFixture();
    sys = await bootSystem(fixture);
    const app = createGateway(sys);
    agent = request(app);
  });

  it('full coexistence scenario: stub → CQRS mutation → stub still active → clear → CQRS 404', async () => {
    // Step 1: Register stub for GET /loans/loan-x with a CQRS-impossible value
    const stubbedLoan = { id: 'loan-x', balance: 999999, customerId: ACME_ID, principal: 999999, status: 'STUB' };
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/loans/loan-x' },
      { status: 200, body: stubbedLoan },
    )).expect(200);

    // Step 2: GET /loans/loan-x returns the stub's body (not CQRS, which has no such entity)
    const stubRes1 = await agent.get('/loans/loan-x').expect(200);
    expect(stubRes1.body).toEqual(stubbedLoan);
    expect(stubRes1.headers['x-specmatic-result']).toBe('success');

    // Step 3: POST /loans creates a real CQRS loan for Acme Coffee
    const graphSizeBefore = sys.graph.size();
    const createRes = await agent
      .post('/loans')
      .send({ customerId: ACME_ID, principal: 5000 })
      .expect(201);
    const newLoanId = createRes.body.id as string;
    expect(typeof newLoanId).toBe('string');
    expect(sys.graph.size()).toBe(graphSizeBefore + 1);

    // Step 4: GET /loans/loan-x still returns the stub (not the just-created loan)
    const stubRes2 = await agent.get('/loans/loan-x').expect(200);
    expect(stubRes2.body).toEqual(stubbedLoan);
    expect(stubRes2.body.id).toBe('loan-x');
    expect(stubRes2.body.id).not.toBe(newLoanId);

    // Step 5: Confirm the real loan is accessible via CQRS (no stub for it)
    const realLoanRes = await agent.get(`/loans/${newLoanId}`).expect(200);
    expect(realLoanRes.body.id).toBe(newLoanId);
    expect(realLoanRes.body.principal).toBe(5000);

    // Step 6: Clear all stubs
    await agent.delete('/_specmatic/expectations').expect(200);
    expect(sys.expectations.size()).toBe(0);

    // Step 7: GET /loans/loan-x now falls through to CQRS → 404 (no such entity)
    await agent.get('/loans/loan-x').expect(404);
  });

  it('stub does not mutate state graph or event store', async () => {
    const graphSizeBefore = sys.graph.size();
    const eventCountBefore = sys.events.size();

    await postExpectation(agent, expectation(
      { method: 'GET', path: '/loans/no-mutation-stub' },
      { status: 200, body: { id: 'no-mutation-stub', balance: 0, customerId: ACME_ID, principal: 0, status: 'STUB' } },
    )).expect(200);

    // Make multiple stub-matched requests
    for (let i = 0; i < 3; i++) {
      await agent.get('/loans/no-mutation-stub').expect(200);
    }

    expect(sys.graph.size()).toBe(graphSizeBefore);
    expect(sys.events.size()).toBe(eventCountBefore);
  });

  it('CQRS mutations are unaffected by unrelated stubs', async () => {
    // Register a stub for an unrelated path
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/loans/unrelated-stub' },
      { status: 200, body: { id: 'unrelated', balance: 0, customerId: ACME_ID, principal: 0, status: 'STUB' } },
    )).expect(200);

    // CQRS creation still works
    const res = await agent
      .post('/loans')
      .send({ customerId: ACME_ID, principal: 1000 })
      .expect(201);
    expect(res.body.principal).toBe(1000);
    expect(res.body.status).toBe('OPEN');

    // Real loan accessible via CQRS
    await agent.get(`/loans/${res.body.id}`).expect(200);
  });

  it('X-Specmatic-Expectation-Id is set for stub-matched /loans/{id} response', async () => {
    const postRes = await postExpectation(agent, expectation(
      { method: 'GET', path: '/loans/expect-id-test' },
      { status: 200, body: { id: 'expect-id-test', balance: 100, customerId: ACME_ID, principal: 100, status: 'ACTIVE' } },
    )).expect(200);
    const expectationId = postRes.body.id as string;

    const res = await agent.get('/loans/expect-id-test').expect(200);
    expect(res.headers['x-specmatic-expectation-id']).toBe(expectationId);
  });

  it('CQRS customer list endpoint is unaffected by loan stubs', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/loans/some-stub-loan' },
      { status: 200, body: { id: 'some-stub-loan', balance: 0, customerId: ACME_ID, principal: 0, status: 'STUB' } },
    )).expect(200);

    // Customer list should still work via CQRS
    const res = await agent.get('/customers').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });

  it('multiple stubs for /loans paths do not interfere with each other or CQRS', async () => {
    // Register stubs for two different /loans/{id} paths
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/loans/stub-loan-a' },
      { status: 200, body: { id: 'stub-loan-a', balance: 111, customerId: ACME_ID, principal: 111, status: 'A' } },
    )).expect(200);
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/loans/stub-loan-b' },
      { status: 200, body: { id: 'stub-loan-b', balance: 222, customerId: ACME_ID, principal: 222, status: 'B' } },
    )).expect(200);

    const resA = await agent.get('/loans/stub-loan-a').expect(200);
    expect(resA.body.id).toBe('stub-loan-a');

    const resB = await agent.get('/loans/stub-loan-b').expect(200);
    expect(resB.body.id).toBe('stub-loan-b');

    // CQRS entity still works
    const cqrsLoan = await agent
      .post('/loans')
      .send({ customerId: ACME_ID, principal: 3000 })
      .expect(201);
    await agent.get(`/loans/${cqrsLoan.body.id}`).expect(200);
  });
});
