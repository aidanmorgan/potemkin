/**
 * query-pagination.acceptance.test.ts
 *
 * Acceptance test:
 *  - POST several leads.
 *  - GET /leads?limit=2&offset=1 returns the right slice.
 */

import { createTestApp, type TestApp } from './_helpers/test-app.js';

// CRM baseline has 5 seeded leads
const BASELINE_LEAD_COUNT = 5;

describe('query-pagination.acceptance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  async function createLeads(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const res = await app.agent
        .post('/leads')
        .send({
          companyName: `Pagination Corp ${i}`,
          contactName: `Pagination User ${i}`,
          phone: `+61 2 9000 ${String(i).padStart(4, '0')}`,
          email: `pagination${i}@corp.com`,
          source: 'COLD_LIST',
        })
        .expect(201);
      ids.push(res.body.id);
    }
    return ids;
  }

  it('GET /leads returns all leads without pagination params', async () => {
    await createLeads(3);

    const res = await app.agent.get('/leads').expect(200);
    // 5 baseline + 3 added = 8
    expect(res.body.length).toBe(BASELINE_LEAD_COUNT + 3);
  });

  it('GET /leads?limit=2 returns at most 2 leads', async () => {
    await createLeads(3);

    const res = await app.agent.get('/leads?limit=2').expect(200);
    expect(res.body.items.length).toBe(2);
  });

  it('GET /leads?offset=1 returns all but the first lead', async () => {
    await createLeads(3);

    const allRes = await app.agent.get('/leads').expect(200);
    const pagedRes = await app.agent.get('/leads?offset=1').expect(200);

    expect(pagedRes.body.length).toBe(allRes.body.length - 1);
  });

  it('GET /leads?limit=2&offset=1 returns the correct slice', async () => {
    await createLeads(3);

    const allRes = await app.agent.get('/leads').expect(200);
    const pagedRes = await app.agent.get('/leads?limit=2&offset=1').expect(200);

    expect(pagedRes.body.items.length).toBe(2);
    // The slice should match allRes.body[1] and allRes.body[2]
    expect(pagedRes.body.items[0]).toEqual(allRes.body[1]);
    expect(pagedRes.body.items[1]).toEqual(allRes.body[2]);
  });

  it('GET /leads?limit=1 returns exactly 1 lead', async () => {
    await createLeads(3);

    const res = await app.agent.get('/leads?limit=1').expect(200);
    expect(res.body.items.length).toBe(1);
  });

  it('GET /leads?offset beyond total returns empty array', async () => {
    // Only 5 baseline leads
    const res = await app.agent.get('/leads?offset=100').expect(200);
    expect(res.body.length).toBe(0);
  });

  it('GET /leads?limit=2&offset=1 combined with status filter works', async () => {
    // Add 4 NEW leads (all default to NEW status)
    await createLeads(4);

    // Baseline has 2 NEW leads (Apex and Echo) + 4 new = 6 total NEW
    const filteredRes = await app.agent.get('/leads?status=NEW&limit=2&offset=1').expect(200);
    expect(filteredRes.body.items.length).toBe(2);
    for (const lead of filteredRes.body.items) {
      expect(lead.status).toBe('NEW');
    }
  });
});
