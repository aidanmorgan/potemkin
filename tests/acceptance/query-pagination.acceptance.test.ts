/**
 * query-pagination.acceptance.test.ts
 *
 * Acceptance test:
 *  - POST several customers.
 *  - GET /customers?limit=2&offset=1 returns the right slice.
 */

import { createTestApp, type TestApp } from './_helpers/test-app.js';

describe('query-pagination.acceptance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  async function createCustomers(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const res = await app.agent
        .post('/customers')
        .send({ name: `Pagination Customer ${i}`, riskBand: 'LOW' })
        .expect(201);
      ids.push(res.body.id);
    }
    return ids;
  }

  it('GET /customers returns all customers without pagination params', async () => {
    await createCustomers(3);

    const res = await app.agent.get('/customers').expect(200);
    // 2 baseline + 3 added = 5
    expect(res.body.length).toBe(5);
  });

  it('GET /customers?limit=2 returns at most 2 customers', async () => {
    await createCustomers(3);

    const res = await app.agent.get('/customers?limit=2').expect(200);
    expect(res.body.length).toBe(2);
  });

  it('GET /customers?offset=1 returns all but the first customer', async () => {
    await createCustomers(3);

    const allRes = await app.agent.get('/customers').expect(200);
    const pagedRes = await app.agent.get('/customers?offset=1').expect(200);

    expect(pagedRes.body.length).toBe(allRes.body.length - 1);
  });

  it('GET /customers?limit=2&offset=1 returns the correct slice', async () => {
    await createCustomers(3);

    const allRes = await app.agent.get('/customers').expect(200);
    const pagedRes = await app.agent.get('/customers?limit=2&offset=1').expect(200);

    expect(pagedRes.body.length).toBe(2);
    // The slice should match allRes.body[1] and allRes.body[2]
    expect(pagedRes.body[0]).toEqual(allRes.body[1]);
    expect(pagedRes.body[1]).toEqual(allRes.body[2]);
  });

  it('GET /customers?limit=0 returns empty array', async () => {
    await createCustomers(3);

    const res = await app.agent.get('/customers?limit=0').expect(200);
    expect(res.body.length).toBe(0);
  });

  it('GET /customers?offset beyond total returns empty array', async () => {
    // Only 2 baseline customers
    const res = await app.agent.get('/customers?offset=100').expect(200);
    expect(res.body.length).toBe(0);
  });

  it('GET /customers?limit=2&offset=1 combined with riskBand filter works', async () => {
    // Add 4 LOW customers
    await createCustomers(4);

    // All LOW (baseline Acme + 4 new) = 5 LOW customers
    const filteredRes = await app.agent.get('/customers?riskBand=LOW&limit=2&offset=1').expect(200);
    expect(filteredRes.body.length).toBe(2);
    for (const c of filteredRes.body) {
      expect(c.riskBand).toBe('LOW');
    }
  });
});
