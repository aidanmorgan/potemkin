/**
 * lead-lifecycle.acceptance.test.ts
 *
 * Acceptance test (HTTP-driven):
 *  - POST /leads → 201
 *  - GET /leads/{id} → 200 with full body
 *  - GET /leads?status=NEW → array filtered
 */

import { createTestApp, type TestApp } from './_helpers/test-app.js';

describe('lead-lifecycle.acceptance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  it('POST /leads returns 201 with the created lead body', async () => {
    const res = await app.agent
      .post('/leads')
      .send({
        companyName: 'New Lead Corp',
        contactName: 'New Lead User',
        phone: '+61 2 9000 1111',
        email: 'newlead@corp.com',
        source: 'WEBSITE',
      })
      .expect(201);

    expect(res.body).toMatchObject({
      companyName: 'New Lead Corp',
      source: 'WEBSITE',
      status: 'NEW',
    });
    expect(typeof res.body.id).toBe('string');
    expect(res.body.id.length).toBeGreaterThan(0);
  });

  it('GET /leads/{id} returns 200 with full lead body', async () => {
    // Create first, then retrieve
    const createRes = await app.agent
      .post('/leads')
      .send({
        companyName: 'Acme CRM Corp',
        contactName: 'CRM User',
        phone: '+61 2 9000 2222',
        email: 'acme@crmcorp.com',
        source: 'REFERRAL',
      })
      .expect(201);

    const id = createRes.body.id;

    const getRes = await app.agent.get(`/leads/${id}`).expect(200);

    expect(getRes.body.id).toBe(id);
    expect(getRes.body.companyName).toBe('Acme CRM Corp');
    expect(getRes.body.source).toBe('REFERRAL');
  });

  it('GET /leads/{id} returns all required fields', async () => {
    const createRes = await app.agent
      .post('/leads')
      .send({
        companyName: 'Full Lead Corp',
        contactName: 'Full User',
        phone: '+61 2 9000 3333',
        email: 'full@leadcorp.com',
        source: 'PARTNER',
      })
      .expect(201);

    const getRes = await app.agent.get(`/leads/${createRes.body.id}`).expect(200);

    // Required fields per CRM Lead schema
    expect(typeof getRes.body.id).toBe('string');
    expect(typeof getRes.body.companyName).toBe('string');
    expect(typeof getRes.body.contactName).toBe('string');
    expect(typeof getRes.body.phone).toBe('string');
    expect(typeof getRes.body.email).toBe('string');
    expect(typeof getRes.body.source).toBe('string');
    expect(typeof getRes.body.status).toBe('string');
  });

  it('GET /leads?status=NEW returns only NEW leads', async () => {
    // Add a lead (will be NEW by default)
    await app.agent
      .post('/leads')
      .send({
        companyName: 'New Status Corp',
        contactName: 'Status User',
        phone: '+61 2 9000 4444',
        email: 'newstatus@corp.com',
        source: 'COLD_LIST',
      })
      .expect(201);

    const res = await app.agent.get('/leads?status=NEW').expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    for (const lead of res.body) {
      expect(lead.status).toBe('NEW');
    }
  });

  it('GET /leads without filter returns all leads', async () => {
    // Baseline already has 5 seeded leads
    const res = await app.agent.get('/leads').expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(5);
  });

  it('POST /leads response includes an ETag header', async () => {
    const res = await app.agent
      .post('/leads')
      .send({
        companyName: 'ETag Lead Corp',
        contactName: 'ETag User',
        phone: '+61 2 9000 5555',
        email: 'etag@leadcorp.com',
        source: 'WEBSITE',
      })
      .expect(201);

    // ETag should be set for creation operations that produce events
    expect(res.headers['etag']).toBeDefined();
  });
});
