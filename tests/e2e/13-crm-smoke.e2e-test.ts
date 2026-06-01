/**
 * 13 — CRM Smoke: exercises all 5 boundaries via the full Specmatic+plugin+Node
 * stack using the YAML DSL fixtures.
 *
 * All behavior is defined in the CRM YAML files (tests/fixtures/crm/dsl/).
 * This test only sends HTTP requests and verifies responses + graph state
 * via admin endpoints.
 */

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { fwd, getGraphNode, getEntityCount } from './_harness/crm-e2e-helpers';

function javaAvailable(): boolean {
  try { execSync('java -version', { stdio: 'pipe' }); return true; } catch { return false; }
}

const describeWithJava = javaAvailable() ? describe : describe.skip;

const SEEDED_LEAD_NEW = '00000000-0000-7000-8000-000000000010';
const SEEDED_CAMPAIGN_ACTIVE = '00000000-0000-7000-8000-000000000001';
const SEEDED_AGENT = '00000000-0000-7000-8000-000000000003';

describeWithJava('13 — CRM Smoke (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  it('POST /leads creates a lead visible in graph', async () => {
    const res = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'E2E Smoke Corp', contactName: 'Smoke User',
      phone: '+61 2 9999 0001', email: 'smoke@e2e.test', source: 'WEBSITE',
    });
    expect([200, 201]).toContain(res.status);
    const id = (res.body as Record<string, unknown>)['id'] as string;

    const node = await getGraphNode(app.engineUrl, id);
    expect(node).not.toBeNull();
    expect(node!['companyName']).toBe('E2E Smoke Corp');
    expect(node!['status']).toBe('NEW');
  }, 60_000);

  it('GET /leads/{seeded-id} returns seeded lead from YAML initialization', async () => {
    const res = await fwd(app.engineUrl, 'GET', `/leads/${SEEDED_LEAD_NEW}`);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)['companyName']).toBe('Apex Solutions Ltd');

    const node = await getGraphNode(app.engineUrl, SEEDED_LEAD_NEW);
    expect(node!['source']).toBe('WEBSITE');
  }, 60_000);

  it('GET /leads returns all seeded leads', async () => {
    const res = await fwd(app.engineUrl, 'GET', '/leads');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown[]).length).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it('POST /calls creates a call and cascades to lead callIds', async () => {
    const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
      leadId: SEEDED_LEAD_NEW, agentId: SEEDED_AGENT,
      campaignId: SEEDED_CAMPAIGN_ACTIVE, outcome: 'INTERESTED',
    });
    expect([200, 201]).toContain(callRes.status);
    const callId = (callRes.body as Record<string, unknown>)['id'] as string;

    const lead = await getGraphNode(app.engineUrl, SEEDED_LEAD_NEW);
    expect((lead!['callIds'] as string[])).toContain(callId);
  }, 60_000);

  it('GET /campaigns/{seeded-id} returns seeded campaign', async () => {
    const res = await fwd(app.engineUrl, 'GET', `/campaigns/${SEEDED_CAMPAIGN_ACTIVE}`);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)['name']).toBe('Q1 Website Leads');
  }, 60_000);

  it('GET /agents/{seeded-id} returns seeded agent', async () => {
    const res = await fwd(app.engineUrl, 'GET', `/agents/${SEEDED_AGENT}`);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)['name']).toBe('Alice Thompson');
  }, 60_000);

  it('POST /leads/{id}/contact transitions lead to CONTACTED', async () => {
    await fwd(app.engineUrl, 'POST', `/leads/${SEEDED_LEAD_NEW}/contact`, {});
    const node = await getGraphNode(app.engineUrl, SEEDED_LEAD_NEW);
    expect(node!['status']).toBe('CONTACTED');
  }, 60_000);

  it('graph has expected entity count from YAML initialization', async () => {
    const count = await getEntityCount(app.engineUrl);
    expect(count).toBeGreaterThanOrEqual(10); // 5 leads + 2 campaigns + 3 agents
  }, 60_000);
});
