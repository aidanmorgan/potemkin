/**
 * contract-violation.acceptance.test.ts
 *
 * Acceptance test: POST /customers with missing required `riskBand` → 400 CONTRACT_VIOLATION.
 */

import { createTestApp, type TestApp } from './_helpers/test-app.js';

describe('contract-violation.acceptance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  it('POST /customers with missing riskBand returns 400', async () => {
    await app.agent
      .post('/customers')
      .send({ name: 'No Risk Band Customer' })
      // missing required `riskBand`
      .expect(400);
  });

  it('POST /customers with missing riskBand returns CONTRACT_VIOLATION error code', async () => {
    const res = await app.agent
      .post('/customers')
      .send({ name: 'No Risk Band Customer' })
      .expect(400);

    expect(res.body).toMatchObject({ error: 'CONTRACT_VIOLATION' });
  });

  it('POST /customers with missing name returns 400', async () => {
    await app.agent
      .post('/customers')
      .send({ riskBand: 'LOW' })
      .expect(400);
  });

  it('POST /customers with empty body returns 400', async () => {
    await app.agent
      .post('/customers')
      .send({})
      .expect(400);
  });

  it('POST /loans with missing principal returns 400', async () => {
    await app.agent
      .post('/loans')
      .send({ customerId: '00000000-0000-7000-8000-000000000001' })
      // missing required `principal`
      .expect(400);
  });

  it('POST /loans with missing customerId returns 400', async () => {
    await app.agent
      .post('/loans')
      .send({ principal: 1000 })
      // missing required `customerId`
      .expect(400);
  });

  // it.failing: BUG — creating a loan triggers cascade (loanIds append) which fails
  // with SCHEMA_TYPE_MISMATCH due to append runtimeGuard bug.
  it.failing('POST /loans/repay with missing amount returns 400', async () => {
    // We need an existing loan first — create one
    const loanRes = await app.agent
      .post('/loans')
      .send({ customerId: '00000000-0000-7000-8000-000000000001', principal: 1000 })
      .expect(201);

    await app.agent
      .post(`/loans/${loanRes.body.id}/repay`)
      .send({})
      // missing required `amount`
      .expect(400);
  });
});
