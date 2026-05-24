/**
 * contract-violation.acceptance.test.ts
 *
 * Acceptance test: POST /leads with missing required fields → 400 CONTRACT_VIOLATION.
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

  it('POST /leads with missing source returns 400', async () => {
    await app.agent
      .post('/leads')
      .send({
        companyName: 'No Source Corp',
        contactName: 'No Source User',
        phone: '+61 2 9000 1111',
        email: 'nosource@corp.com',
        // missing required `source`
      })
      .expect(400);
  });

  it('POST /leads with missing source returns CONTRACT_VIOLATION error code', async () => {
    const res = await app.agent
      .post('/leads')
      .send({
        companyName: 'No Source Corp',
        contactName: 'No Source User',
        phone: '+61 2 9000 1111',
        email: 'nosource@corp.com',
      })
      .expect(400);

    expect(res.body).toMatchObject({ error: 'CONTRACT_VIOLATION' });
  });

  it('POST /leads with missing companyName returns 400', async () => {
    await app.agent
      .post('/leads')
      .send({
        contactName: 'No Company User',
        phone: '+61 2 9000 2222',
        email: 'nocompany@corp.com',
        source: 'WEBSITE',
      })
      .expect(400);
  });

  it('POST /leads with empty body returns 400', async () => {
    await app.agent
      .post('/leads')
      .send({})
      .expect(400);
  });

  it('POST /calls with missing outcome returns 400', async () => {
    await app.agent
      .post('/calls')
      .send({
        leadId: '00000000-0000-7000-8000-000000000010',
        agentId: '00000000-0000-7000-8000-000000000003',
        campaignId: '00000000-0000-7000-8000-000000000001',
        // missing required `outcome`
      })
      .expect(400);
  });

  it('POST /calls with missing leadId returns 400', async () => {
    await app.agent
      .post('/calls')
      .send({
        agentId: '00000000-0000-7000-8000-000000000003',
        campaignId: '00000000-0000-7000-8000-000000000001',
        outcome: 'INTERESTED',
        // missing required `leadId`
      })
      .expect(400);
  });

  it('POST /leads with invalid source enum returns 400', async () => {
    await app.agent
      .post('/leads')
      .send({
        companyName: 'Bad Source Corp',
        contactName: 'Bad Source User',
        phone: '+61 2 9000 3333',
        email: 'badsource@corp.com',
        source: 'INVALID_SOURCE',
      })
      .expect(400);
  });
});
