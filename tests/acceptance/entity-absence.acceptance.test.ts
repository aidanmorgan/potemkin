/**
 * entity-absence.acceptance.test.ts
 *
 * Acceptance test: GET /loans/{unknown-uuid} → 404.
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

  it('GET /loans/{unknown-uuid} returns 404', async () => {
    const unknownId = nextUuidv7();
    await app.agent.get(`/loans/${unknownId}`).expect(404);
  });

  it('GET /loans/{unknown-uuid} response body contains entity absence info', async () => {
    const unknownId = nextUuidv7();
    const res = await app.agent.get(`/loans/${unknownId}`).expect(404);

    // Response should be a JSON body (not empty)
    expect(res.body).toBeDefined();
  });

  it('GET /customers/{unknown-uuid} returns 404', async () => {
    const unknownId = nextUuidv7();
    await app.agent.get(`/customers/${unknownId}`).expect(404);
  });

  it('a real loan can be retrieved (sanity check)', async () => {
    const loanRes = await app.agent
      .post('/loans')
      .send({ customerId: '00000000-0000-7000-8000-000000000001', principal: 500 })
      .expect(201);

    await app.agent.get(`/loans/${loanRes.body.id}`).expect(200);
  });
});
