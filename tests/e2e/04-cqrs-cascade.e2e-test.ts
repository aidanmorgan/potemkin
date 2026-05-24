/**
 * 04 — CQRS cascade: POST /calls cascades to Lead (callId appended).
 *
 * Logs a call via the engine's forwarding endpoint, then verifies that:
 *  1. The call entity is created.
 *  2. The Lead entity's callIds array is updated with the new callId
 *     (CQRS secondary command dispatch).
 */

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';

function javaAvailable(): boolean {
  try {
    execSync('java -version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const describeWithJava = javaAvailable() ? describe : describe.skip;

// Seeded IDs from CRM fixtures
const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';
const AGENT_ID = '00000000-0000-7000-8000-000000000003';

async function postForward(engineUrl: string, method: string, path: string, body: unknown) {
  const res = await fetch(`${engineUrl}/_engine/forward`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, path, headers: {}, query: {}, body }),
  });
  return res.json() as Promise<{ status: number; body: unknown; headers: Record<string, string> }>;
}

describeWithJava('04 — CQRS cascade: POST /calls appends callId to Lead', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('POST /calls creates a Call entity', async () => {
    const result = await postForward(app.engineUrl, 'POST', '/calls', {
      leadId: APEX_LEAD_ID,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'INTERESTED',
    });
    expect([200, 201]).toContain(result.status);
    const callBody = result.body as Record<string, unknown>;
    expect(typeof callBody['id']).toBe('string');
  }, 60_000);

  it('after POST /calls, Lead callIds contains the new callId', async () => {
    // Log a call against the seeded Apex lead
    const callResult = await postForward(app.engineUrl, 'POST', '/calls', {
      leadId: APEX_LEAD_ID,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'CALLBACK_SCHEDULED',
    });
    expect([200, 201]).toContain(callResult.status);
    const callId = (callResult.body as Record<string, unknown>)['id'] as string;
    expect(typeof callId).toBe('string');

    // Read back the lead state — callIds should include the new callId
    const leadResult = await postForward(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`, null);
    expect(leadResult.status).toBe(200);
    const lead = leadResult.body as Record<string, unknown>;
    const callIds = lead['callIds'] as string[];
    expect(Array.isArray(callIds)).toBe(true);
    expect(callIds).toContain(callId);
  }, 60_000);

  it('multiple calls accumulate in Lead callIds', async () => {
    // First call
    const call1 = await postForward(app.engineUrl, 'POST', '/calls', {
      leadId: APEX_LEAD_ID,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'NO_ANSWER',
    });
    expect([200, 201]).toContain(call1.status);

    // Second call
    const call2 = await postForward(app.engineUrl, 'POST', '/calls', {
      leadId: APEX_LEAD_ID,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'INTERESTED',
    });
    expect([200, 201]).toContain(call2.status);

    const callId1 = (call1.body as Record<string, unknown>)['id'] as string;
    const callId2 = (call2.body as Record<string, unknown>)['id'] as string;

    // Both callIds should be present in the lead
    const leadResult = await postForward(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`, null);
    const lead = leadResult.body as Record<string, unknown>;
    const callIds = lead['callIds'] as string[];
    expect(callIds).toContain(callId1);
    expect(callIds).toContain(callId2);
  }, 60_000);
});
