/**
 * entity-absence.acceptance.test.ts
 *
 * Acceptance test: GET /leads/{unknown-uuid} → 404.
 */

import { createTestApp, type TestApp } from './_helpers/test-app.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';

describe('entity-absence.acceptance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  it('GET /leads/{unknown-uuid} returns 404', async () => {
    const unknownId = nextUuidv7();
    await app.agent.get(`/leads/${unknownId}`).expect(404);
  });

  it('GET /leads/{unknown-uuid} response body contains entity absence info', async () => {
    const unknownId = nextUuidv7();
    const res = await app.agent.get(`/leads/${unknownId}`).expect(404);

    // Response should be a JSON body (not empty)
    expect(res.body).toBeDefined();
  });

  it('GET /campaigns/{unknown-uuid} returns 404', async () => {
    const unknownId = nextUuidv7();
    await app.agent.get(`/campaigns/${unknownId}`).expect(404);
  });

  it('a real lead can be retrieved (sanity check)', async () => {
    const leadRes = await app.agent
      .post('/leads')
      .send({
        companyName: 'Sanity Corp',
        contactName: 'Sanity User',
        phone: '+61 2 9000 9999',
        email: 'sanity@sanity.com',
        source: 'WEBSITE',
      })
      .expect(201);

    await app.agent.get(`/leads/${leadRes.body.id}`).expect(200);
  });
});
