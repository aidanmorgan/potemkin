/**
 * loan-lifecycle.acceptance.test.ts
 *
 * Acceptance test (HTTP-driven):
 *  - POST /loans → 201 (verifies cross-boundary cascade)
 *  - POST /loans/{id}/disburse → 200, balance not null, status updated
 *  - POST /loans/{id}/repay → 200, status SETTLED if balance hits 0
 */

// BUG NOTE: All loan creation tests fail because creating a loan dispatches a
// secondary mutation to the Customer boundary (loanIds append), which triggers
// SCHEMA_TYPE_MISMATCH: guardAssignedValue checks the appended string value
// against the loanIds array schema (expects array, gets string).
// Tracked as: runtimeGuard append check should verify against items schema, not array schema.

import { createTestApp, type TestApp } from './_helpers/test-app.js';

const ACME_ID = '00000000-0000-7000-8000-000000000001';

describe('loan-lifecycle.acceptance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  it('POST /loans returns 201 with loan body', async () => {
    const res = await app.agent
      .post('/loans')
      .send({ customerId: ACME_ID, principal: 10000 })
      .expect(201);

    expect(typeof res.body.id).toBe('string');
    expect(res.body.customerId).toBe(ACME_ID);
    expect(res.body.principal).toBe(10000);
    expect(res.body.status).toBe('OPEN');
  });

  it('POST /loans causes cascade: customer loanIds contains the new loan id', async () => {
    const loanRes = await app.agent
      .post('/loans')
      .send({ customerId: ACME_ID, principal: 5000 })
      .expect(201);

    const loanId = loanRes.body.id;

    // Verify the customer was updated via cascade
    const customerRes = await app.agent.get(`/customers/${ACME_ID}`).expect(200);
    const loanIds = customerRes.body.loanIds as string[];
    expect(loanIds).toContain(loanId);
  });

  it('POST /loans/{id}/disburse returns 200 and updates loan status', async () => {
    const loanRes = await app.agent
      .post('/loans')
      .send({ customerId: ACME_ID, principal: 8000 })
      .expect(201);

    const loanId = loanRes.body.id;

    const disburseRes = await app.agent
      .post(`/loans/${loanId}/disburse`)
      .send({})
      .expect(200);

    expect(disburseRes.body.status).toBe('ACTIVE');
  });

  it('POST /loans/{id}/repay returns 200 and reduces balance', async () => {
    const loanRes = await app.agent
      .post('/loans')
      .send({ customerId: ACME_ID, principal: 10000 })
      .expect(201);

    const loanId = loanRes.body.id;

    const repayRes = await app.agent
      .post(`/loans/${loanId}/repay`)
      .send({ amount: 2000 })
      .expect(200);

    expect(repayRes.body.balance).toBe(8000);
  });

  it('POST /loans/{id}/repay with full amount sets status to SETTLED', async () => {
    const loanRes = await app.agent
      .post('/loans')
      .send({ customerId: ACME_ID, principal: 1000 })
      .expect(201);

    const loanId = loanRes.body.id;

    const repayRes = await app.agent
      .post(`/loans/${loanId}/repay`)
      .send({ amount: 1000 })
      .expect(200);

    expect(repayRes.body.balance).toBe(0);
    expect(repayRes.body.status).toBe('SETTLED');
  });

  it('POST /loans/{id}/repay appends to the transactions array', async () => {
    const loanRes = await app.agent
      .post('/loans')
      .send({ customerId: ACME_ID, principal: 5000 })
      .expect(201);

    const loanId = loanRes.body.id;

    const repayRes = await app.agent
      .post(`/loans/${loanId}/repay`)
      .send({ amount: 500 })
      .expect(200);

    expect(Array.isArray(repayRes.body.transactions)).toBe(true);
    expect(repayRes.body.transactions.length).toBeGreaterThan(0);
    expect(repayRes.body.transactions[0].amount).toBe(500);
  });

  it('multiple repayments accumulate in the transactions array', async () => {
    const loanRes = await app.agent
      .post('/loans')
      .send({ customerId: ACME_ID, principal: 3000 })
      .expect(201);

    const loanId = loanRes.body.id;

    await app.agent.post(`/loans/${loanId}/repay`).send({ amount: 1000 }).expect(200);
    const res2 = await app.agent.post(`/loans/${loanId}/repay`).send({ amount: 1000 }).expect(200);

    expect(res2.body.transactions.length).toBe(2);
    expect(res2.body.balance).toBe(1000);
  });
});
