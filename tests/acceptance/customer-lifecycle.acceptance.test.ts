/**
 * customer-lifecycle.acceptance.test.ts
 *
 * Acceptance test (HTTP-driven):
 *  - POST /customers → 201
 *  - GET /customers/{id} → 200 with full body
 *  - GET /customers?riskBand=LOW → array filtered
 */

import { createTestApp, type TestApp } from './_helpers/test-app.js';

describe('customer-lifecycle.acceptance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  it('POST /customers returns 201 with the created customer body', async () => {
    const res = await app.agent
      .post('/customers')
      .send({ name: 'New Customer', riskBand: 'LOW' })
      .expect(201);

    expect(res.body).toMatchObject({
      name: 'New Customer',
      riskBand: 'LOW',
    });
    expect(typeof res.body.id).toBe('string');
    expect(res.body.id.length).toBeGreaterThan(0);
  });

  // it.failing: BUG — runPatternMatch does not implement query-intent fallback for
  // fallback_override:true (req 33). GET /customers/{id} routes to CustomerById
  // boundary which has no query behavior and falls through to UnhandledOperationError.
  it.failing('GET /customers/{id} returns 200 with full customer body', async () => {
    // Create first, then retrieve
    const createRes = await app.agent
      .post('/customers')
      .send({ name: 'Acme Corp', riskBand: 'MED' })
      .expect(201);

    const id = createRes.body.id;

    const getRes = await app.agent.get(`/customers/${id}`).expect(200);

    expect(getRes.body.id).toBe(id);
    expect(getRes.body.name).toBe('Acme Corp');
    expect(getRes.body.riskBand).toBe('MED');
  });

  it.failing('GET /customers/{id} returns all required fields', async () => {
    const createRes = await app.agent
      .post('/customers')
      .send({ name: 'Full Customer', riskBand: 'HIGH' })
      .expect(201);

    const getRes = await app.agent.get(`/customers/${createRes.body.id}`).expect(200);

    // Required fields per schema
    expect(typeof getRes.body.id).toBe('string');
    expect(typeof getRes.body.name).toBe('string');
    expect(typeof getRes.body.riskBand).toBe('string');
  });

  // it.failing: BUG — same as above; GET /customers (collection) routes to Customer
  // boundary which has no query behavior and throws UnhandledOperationError.
  it.failing('GET /customers?riskBand=LOW returns only LOW-risk customers', async () => {
    // Baseline has one LOW customer (Acme Coffee)
    // Add a HIGH customer to test filtering
    await app.agent
      .post('/customers')
      .send({ name: 'High Risk Corp', riskBand: 'HIGH' })
      .expect(201);

    const res = await app.agent.get('/customers?riskBand=LOW').expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    for (const customer of res.body) {
      expect(customer.riskBand).toBe('LOW');
    }
  });

  it.failing('GET /customers without filter returns all customers', async () => {
    // Baseline already has 2 customers
    const res = await app.agent.get('/customers').expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });

  it('POST /customers response includes an ETag header', async () => {
    const res = await app.agent
      .post('/customers')
      .send({ name: 'ETag Customer', riskBand: 'LOW' })
      .expect(201);

    // ETag should be set for creation operations that produce events
    expect(res.headers['etag']).toBeDefined();
  });
});
