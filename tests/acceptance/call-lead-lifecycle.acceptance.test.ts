/**
 * call-lead-lifecycle.acceptance.test.ts
 *
 * Acceptance test (HTTP-driven):
 *  - POST /calls → 201 (verifies cross-boundary cascade: callId appended to Lead)
 *  - POST /leads/{id}/contact → 200, status updated to CONTACTED
 *  - POST /leads/{id}/qualify → 200, status updated to QUALIFIED (requires CONTACTED + call)
 */

import { createTestApp, type TestApp } from './_helpers/test-app.js';

// Apex Solutions (NEW, no calls) - good starting point for lifecycle tests
const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';
// BlueSky Tech (CONTACTED, has call) - ready to qualify
const BLUESKY_LEAD_ID = '00000000-0000-7000-8000-000000000011';
// Q1 Website Leads campaign
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';
// Alice Thompson agent
const AGENT_ID = '00000000-0000-7000-8000-000000000003';

describe('call-lead-lifecycle.acceptance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  it('POST /calls returns 201 with call body', async () => {
    const res = await app.agent
      .post('/calls')
      .send({
        leadId: APEX_LEAD_ID,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED',
      })
      .expect(201);

    expect(typeof res.body.id).toBe('string');
    expect(res.body.leadId).toBe(APEX_LEAD_ID);
    expect(res.body.outcome).toBe('INTERESTED');
  });

  it('POST /calls causes cascade: lead callIds contains the new call id', async () => {
    const callRes = await app.agent
      .post('/calls')
      .send({
        leadId: APEX_LEAD_ID,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'CALLBACK_SCHEDULED',
      })
      .expect(201);

    const callId = callRes.body.id;

    // Verify the lead was updated via cascade
    const leadRes = await app.agent.get(`/leads/${APEX_LEAD_ID}`).expect(200);
    const callIds = leadRes.body.callIds as string[];
    expect(callIds).toContain(callId);
  });

  it('POST /leads/{id}/contact returns 200 and updates lead status to CONTACTED', async () => {
    // Apex is NEW — can be contacted
    const res = await app.agent
      .post(`/leads/${APEX_LEAD_ID}/contact`)
      .send({ notes: 'Initial contact made' })
      .expect(200);

    expect(res.body.status).toBe('CONTACTED');
  });

  it('POST /leads/{id}/qualify returns 200 and updates status to QUALIFIED', async () => {
    // BlueSky is CONTACTED and already has a call — can be qualified
    const res = await app.agent
      .post(`/leads/${BLUESKY_LEAD_ID}/qualify`)
      .send({})
      .expect(200);

    expect(res.body.status).toBe('QUALIFIED');
  });

  it('POST /leads/{id}/disqualify returns 200 and updates status to DISQUALIFIED', async () => {
    // BlueSky is CONTACTED — can be disqualified
    const res = await app.agent
      .post(`/leads/${BLUESKY_LEAD_ID}/disqualify`)
      .send({ reason: 'Not a good fit' })
      .expect(200);

    expect(res.body.status).toBe('DISQUALIFIED');
  });

  it('POST /leads/{id}/contact on a NEW lead returns 200', async () => {
    // Apex is NEW — valid transition
    const res = await app.agent
      .post(`/leads/${APEX_LEAD_ID}/contact`)
      .send({})
      .expect(200);

    expect(res.body.id).toBe(APEX_LEAD_ID);
    expect(res.body.status).toBe('CONTACTED');
  });

  it('multiple calls to same lead accumulate in callIds', async () => {
    // Log two calls to the same lead
    const call1 = await app.agent
      .post('/calls')
      .send({
        leadId: APEX_LEAD_ID,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'NO_ANSWER',
      })
      .expect(201);

    const call2 = await app.agent
      .post('/calls')
      .send({
        leadId: APEX_LEAD_ID,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'CALLBACK_SCHEDULED',
      })
      .expect(201);

    const leadRes = await app.agent.get(`/leads/${APEX_LEAD_ID}`).expect(200);
    const callIds = leadRes.body.callIds as string[];
    expect(callIds).toContain(call1.body.id);
    expect(callIds).toContain(call2.body.id);
    expect(callIds.length).toBeGreaterThanOrEqual(2);
  });
});
