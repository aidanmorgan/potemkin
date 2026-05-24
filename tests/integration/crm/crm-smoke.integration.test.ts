/**
 * crm-smoke.integration.test.ts
 *
 * Integration smoke test for the The Nuisance Bureau CRM domain.
 * Boots the CRM fixture and exercises each major endpoint family:
 *  - POST /leads → 201
 *  - GET /leads/:seeded-id → 200, body matches seed
 *  - POST /calls with valid body → 201, lead.callIds appended
 *  - POST /leads/:id/qualify → 200, status transitions to QUALIFIED
 *  - PATCH /campaigns/:seeded-id/activate → 200
 *  - POST /leads/:id/dnc (without auth) → 401
 */

import request from 'supertest';
import { bootSystem } from '../../../src/engine/boot.js';
import { resetSystem } from '../../../src/engine/reset.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadCrmFixture } from '../../fixtures/index.js';
import type { BootedSystem } from '../../../src/engine/boot.js';

// Pre-seeded IDs from initialization data
const SEEDED_LEAD_NEW = '00000000-0000-7000-8000-000000000010';         // Apex Solutions, NEW
const SEEDED_LEAD_CONTACTED = '00000000-0000-7000-8000-000000000011';   // BlueSky Tech, CONTACTED (has callIds)
const SEEDED_LEAD_QUALIFIED = '00000000-0000-7000-8000-000000000012';   // Cornerstone Corp, QUALIFIED
const SEEDED_CAMPAIGN_ACTIVE = '00000000-0000-7000-8000-000000000001';  // Q1 Website Leads, ACTIVE
const SEEDED_CAMPAIGN_DRAFT = '00000000-0000-7000-8000-000000000002';   // Partner Referral Drive, DRAFT
const SEEDED_AGENT = '00000000-0000-7000-8000-000000000003';             // Alice Thompson

describe('CRM Smoke — integration', () => {
  let sys: BootedSystem;
  let agent: ReturnType<typeof request>;

  beforeAll(async () => {
    const fixture = await loadCrmFixture();
    sys = await bootSystem(fixture);
    const app = createGateway(sys);
    agent = request(app);
  });

  afterAll(() => {
    resetSystem(sys);
  });

  // ── POST /leads → 201 ──────────────────────────────────────────────────────

  it('POST /leads with valid body returns 201', async () => {
    const res = await agent
      .post('/leads')
      .send({
        companyName: 'Test Corp',
        contactName: 'Test User',
        phone: '+61 2 9000 9999',
        email: 'test@testcorp.com',
        source: 'WEBSITE',
      })
      .expect(201);

    expect(res.body).toHaveProperty('id');
    expect(res.body.status).toBe('NEW');
    expect(res.body.companyName).toBe('Test Corp');
  });

  // ── GET /leads/:id → 200, body matches seed ────────────────────────────────

  it('GET /leads/:seeded-id returns 200 with seed data', async () => {
    const res = await agent
      .get(`/leads/${SEEDED_LEAD_NEW}`)
      .expect(200);

    expect(res.body.id).toBe(SEEDED_LEAD_NEW);
    expect(res.body.companyName).toBe('Apex Solutions Ltd');
    expect(res.body.status).toBe('NEW');
    expect(res.body.source).toBe('WEBSITE');
  });

  // ── GET /leads → 200 list ──────────────────────────────────────────────────

  it('GET /leads returns 200 with array of leads', async () => {
    const res = await agent.get('/leads').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    // At minimum 5 seeded leads
    expect(res.body.length).toBeGreaterThanOrEqual(5);
  });

  // ── POST /calls with valid body → 201 ─────────────────────────────────────

  it('POST /calls returns 201 and creates a call record', async () => {
    const res = await agent
      .post('/calls')
      .send({
        leadId: SEEDED_LEAD_NEW,
        agentId: SEEDED_AGENT,
        campaignId: SEEDED_CAMPAIGN_ACTIVE,
        outcome: 'INTERESTED',
        durationSeconds: 120,
        notes: 'Prospect showed strong interest in Q2 offering',
      })
      .expect(201);

    expect(res.body).toHaveProperty('id');
    expect(res.body.outcome).toBe('INTERESTED');
    expect(res.body.leadId).toBe(SEEDED_LEAD_NEW);
  });

  // ── POST /calls appends callId to lead ────────────────────────────────────

  it('POST /calls appends the call ID to lead.callIds', async () => {
    // Log a call against the CONTACTED lead
    const callRes = await agent
      .post('/calls')
      .send({
        leadId: SEEDED_LEAD_CONTACTED,
        agentId: SEEDED_AGENT,
        campaignId: SEEDED_CAMPAIGN_ACTIVE,
        outcome: 'CALLBACK_SCHEDULED',
        durationSeconds: 45,
      })
      .expect(201);

    const callId = callRes.body.id as string;

    // Check that the lead now has the new callId in its callIds
    const leadRes = await agent
      .get(`/leads/${SEEDED_LEAD_CONTACTED}`)
      .expect(200);

    const callIds = leadRes.body.callIds as string[];
    expect(callIds).toContain(callId);
  });

  // ── POST /leads/:id/qualify → 200, status QUALIFIED ────────────────────────

  it('POST /leads/:id/qualify transitions status to QUALIFIED', async () => {
    // First contact the NEW lead so it becomes CONTACTED with a callId
    await agent
      .post(`/leads/${SEEDED_LEAD_NEW}/contact`)
      .send({ notes: 'Initial contact made' })
      .expect(200);

    // Log a call to give it a callId (required by qualify requires guard)
    const callRes = await agent
      .post('/calls')
      .send({
        leadId: SEEDED_LEAD_NEW,
        agentId: SEEDED_AGENT,
        campaignId: SEEDED_CAMPAIGN_ACTIVE,
        outcome: 'INTERESTED',
      })
      .expect(201);

    expect(callRes.body.id).toBeDefined();

    // Now qualify the lead
    const qualRes = await agent
      .post(`/leads/${SEEDED_LEAD_NEW}/qualify`)
      .expect(200);

    expect(qualRes.body.status).toBe('QUALIFIED');
  });

  // ── PATCH /campaigns/:id/activate → 200 ───────────────────────────────────

  it('PATCH /campaigns/:id/activate transitions DRAFT campaign to ACTIVE', async () => {
    const res = await agent
      .patch(`/campaigns/${SEEDED_CAMPAIGN_DRAFT}/activate`)
      .expect(200);

    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.id).toBe(SEEDED_CAMPAIGN_DRAFT);
  });

  // ── GET /campaigns/:id → 200 ──────────────────────────────────────────────

  it('GET /campaigns/:id returns seeded campaign', async () => {
    const res = await agent
      .get(`/campaigns/${SEEDED_CAMPAIGN_ACTIVE}`)
      .expect(200);

    expect(res.body.id).toBe(SEEDED_CAMPAIGN_ACTIVE);
    expect(res.body.name).toBe('Q1 Website Leads');
    expect(res.body.status).toBe('ACTIVE');
  });

  // ── GET /agents/:id → 200 ─────────────────────────────────────────────────

  it('GET /agents/:id returns seeded agent', async () => {
    const res = await agent
      .get(`/agents/${SEEDED_AGENT}`)
      .expect(200);

    expect(res.body.id).toBe(SEEDED_AGENT);
    expect(res.body.name).toBe('Alice Thompson');
    expect(res.body.currentStatus).toBe('AVAILABLE');
  });

  // ── POST /leads/:id/dnc without auth → 401 ────────────────────────────────

  it('POST /leads/:id/dnc without Authorization header returns 401', async () => {
    await agent
      .post(`/leads/${SEEDED_LEAD_QUALIFIED}/dnc`)
      .send({ reason: 'Requested removal' })
      .expect(401);
  });

  // ── POST /leads/:id/dnc with manager scope → 200 ──────────────────────────

  it('POST /leads/:id/dnc with manager scope returns 200', async () => {
    const res = await agent
      .post(`/leads/${SEEDED_LEAD_QUALIFIED}/dnc`)
      .set('Authorization', 'Bearer mgr001:manager')
      .send({ reason: 'Customer requested DNC' })
      .expect(200);

    expect(res.body.status).toBe('DNC');
  });

  // ── GET /opportunities → 200 ──────────────────────────────────────────────

  it('GET /opportunities returns 200 with empty list initially', async () => {
    const res = await agent.get('/opportunities').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // ── POST /agents → 201 ────────────────────────────────────────────────────

  it('POST /agents with valid body returns 201', async () => {
    const res = await agent
      .post('/agents')
      .send({
        name: 'Dana Park',
        email: 'dana@nuisance-bureau.com',
        dailyCallQuota: 30,
        skills: ['Enterprise'],
      })
      .expect(201);

    expect(res.body).toHaveProperty('id');
    expect(res.body.name).toBe('Dana Park');
    expect(res.body.currentStatus).toBe('AVAILABLE');
  });

  // ── POST /campaigns → 201 ─────────────────────────────────────────────────

  it('POST /campaigns with valid body returns 201', async () => {
    const res = await agent
      .post('/campaigns')
      .send({
        name: 'Cold Outreach Q2',
        targetSource: 'COLD_LIST',
        script: 'Hello, I am calling to discuss an exciting opportunity...',
        startedAt: '2025-04-01T00:00:00.000Z',
        endedAt: '2025-06-30T23:59:59.000Z',
        targetCalls: 300,
        targetConversions: 25,
      })
      .expect(201);

    expect(res.body).toHaveProperty('id');
    expect(res.body.status).toBe('DRAFT');
  });

  // ── POST /campaigns with invalid date range → 422 ─────────────────────────

  it('POST /campaigns with endedAt before startedAt returns 422', async () => {
    await agent
      .post('/campaigns')
      .send({
        name: 'Bad Campaign',
        targetSource: 'WEBSITE',
        script: 'Script text',
        startedAt: '2025-06-30T00:00:00.000Z',
        endedAt: '2025-01-01T00:00:00.000Z',
        targetCalls: 100,
        targetConversions: 10,
      })
      .expect(422);
  });
});
