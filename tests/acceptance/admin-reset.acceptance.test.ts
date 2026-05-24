/**
 * admin-reset.acceptance.test.ts
 *
 * Acceptance test:
 *  - POST /_admin/reset returns 204 and restores baseline.
 *  - GET /_admin/state matches post-boot snapshot.
 */

import { createTestApp, type TestApp } from './_helpers/test-app.js';

// Seeded CRM lead IDs
const APEX_ID = '00000000-0000-7000-8000-000000000010';
const BLUESKY_ID = '00000000-0000-7000-8000-000000000011';

describe('admin-reset.acceptance', () => {
  let app: TestApp;
  let baselineStateSnapshot: string;

  beforeAll(async () => {
    app = await createTestApp();
    // Capture the post-boot state as our reference baseline
    const stateRes = await app.agent.get('/_admin/state').expect(200);
    baselineStateSnapshot = JSON.stringify(stateRes.body);
  });

  afterEach(() => {
    app.reset();
  });

  it('POST /_admin/reset returns 204 No Content', async () => {
    await app.agent.post('/_admin/reset').expect(204);
  });

  it('POST /_admin/reset with no body returns 204', async () => {
    // Mutate first
    await app.agent
      .post('/leads')
      .send({
        companyName: 'Temp Lead',
        contactName: 'Temp User',
        phone: '+61 2 9000 9999',
        email: 'temp@temp.com',
        source: 'COLD_LIST',
      })
      .expect(201);

    await app.agent.post('/_admin/reset').expect(204);
  });

  it('GET /_admin/state after reset matches the post-boot baseline', async () => {
    // Mutate state
    await app.agent
      .post('/leads')
      .send({
        companyName: 'Extra Lead',
        contactName: 'Extra User',
        phone: '+61 2 9000 8888',
        email: 'extra@extra.com',
        source: 'WEBSITE',
      })
      .expect(201);

    // Reset
    await app.agent.post('/_admin/reset').expect(204);

    // Snapshot after reset should match baseline
    const stateRes = await app.agent.get('/_admin/state').expect(200);
    const afterReset = JSON.stringify(stateRes.body);

    // Sort the entity keys so comparison is stable
    const normalize = (s: string) => {
      const obj = JSON.parse(s) as { entities: Record<string, unknown> };
      const sortedEntities = Object.fromEntries(
        Object.entries(obj.entities).sort(([a], [b]) => a.localeCompare(b)),
      );
      return JSON.stringify({ entities: sortedEntities });
    };

    expect(normalize(afterReset)).toBe(normalize(baselineStateSnapshot));
  });

  it('seeded leads are present after reset', async () => {
    await app.agent
      .post('/leads')
      .send({
        companyName: 'Temp Lead',
        contactName: 'Temp User',
        phone: '+61 2 9000 7777',
        email: 'temp2@temp.com',
        source: 'COLD_LIST',
      })
      .expect(201);
    await app.agent.post('/_admin/reset').expect(204);

    await app.agent.get(`/leads/${APEX_ID}`).expect(200);
    await app.agent.get(`/leads/${BLUESKY_ID}`).expect(200);
  });

  it('entities created before reset are gone after reset', async () => {
    const createRes = await app.agent
      .post('/leads')
      .send({
        companyName: 'Temporary Lead',
        contactName: 'Temporary User',
        phone: '+61 2 9000 6666',
        email: 'temporary@temp.com',
        source: 'PARTNER',
      })
      .expect(201);

    const tempId = createRes.body.id;

    await app.agent.post('/_admin/reset').expect(204);

    await app.agent.get(`/leads/${tempId}`).expect(404);
  });

  it('GET /_admin/state returns entities keyed by id', async () => {
    const stateRes = await app.agent.get('/_admin/state').expect(200);

    expect(stateRes.body).toHaveProperty('entities');
    expect(typeof stateRes.body.entities).toBe('object');
    expect(stateRes.body.entities[APEX_ID]).toBeDefined();
    expect(stateRes.body.entities[BLUESKY_ID]).toBeDefined();
  });
});
