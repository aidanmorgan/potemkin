/**
 * 10 — Full CRM happy-path flow:
 *   create lead → log call → qualify → convert → opportunity → close WON
 *   → verify derived CampaignDashboard projection updated.
 *
 * All state transitions are driven through the engine's /_engine/forward
 * endpoint to avoid Specmatic contract matching complexity while still
 * exercising the complete CQRS/ES pipeline.
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

// Seeded IDs
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';
const AGENT_ID = '00000000-0000-7000-8000-000000000003';

async function fwd(
  engineUrl: string,
  method: string,
  path: string,
  body: unknown = null,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }> {
  const res = await fetch(`${engineUrl}/_engine/forward`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, path, headers, query: {}, body }),
  });
  return res.json() as Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }>;
}

describeWithJava('10 — Full CRM happy-path flow', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('complete Lead lifecycle: create → contact → qualify → convert → close WON', async () => {
    // Step 1: Create lead with an assigned agent + campaign so the conversion
    // saga produces a fully-attributed Opportunity.
    const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Happy Path Corp',
      contactName: 'Happy User',
      phone: '+61 2 9100 0001',
      email: 'happy@path.test',
      source: 'REFERRAL',
      assignedAgentId: AGENT_ID,
      assignedCampaignId: CAMPAIGN_ID,
    });
    expect([200, 201]).toContain(createRes.status);
    const leadId = createRes.body['id'] as string;
    expect(typeof leadId).toBe('string');

    // Step 2: Log a call (needed to qualify)
    const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
      leadId,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'INTERESTED',
    });
    expect([200, 201]).toContain(callRes.status);

    // Step 3: Contact the lead (transition to CONTACTED)
    const contactRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
    expect([200, 201]).toContain(contactRes.status);
    expect((contactRes.body as Record<string, unknown>)['status']).toBe('CONTACTED');

    // Step 4: Qualify the lead
    const qualifyRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
    expect([200, 201]).toContain(qualifyRes.status);
    expect((qualifyRes.body as Record<string, unknown>)['status']).toBe('QUALIFIED');

    // Step 5: Convert the lead (creates Opportunity via LeadConversionSaga)
    const convertRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/convert`, {
      value: 50000,
      probability: 75,
    });
    expect([200, 201]).toContain(convertRes.status);
    expect((convertRes.body as Record<string, unknown>)['status']).toBe('CONVERTED');

    // Step 6: Find the Opportunity the conversion saga created. The
    // agentId/campaignId assertions fail if the LeadConverted payload no
    // longer carries the lead's assigned agent + campaign.
    const oppsRes = await fwd(app.engineUrl, 'GET', '/opportunities');
    expect(oppsRes.status).toBe(200);
    const opps = oppsRes.body as unknown as Array<Record<string, unknown>>;
    const opp = opps.find((o) => o['leadId'] === leadId);
    expect(opp).toBeDefined();
    expect(opp!['agentId']).toBe(AGENT_ID);
    expect(opp!['campaignId']).toBe(CAMPAIGN_ID);
    expect(opp!['value']).toBe(50000);
    const oppId = opp!['id'] as string;

    // Step 7: Advance opportunity to NEGOTIATING
    const advanceRes = await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppId}/advance`, {});
    expect([200, 201]).toContain(advanceRes.status);

    // Step 8: Close opportunity WON
    const closeRes = await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppId}/close`, {
      outcome: 'WON',
      value: 50000,
    });
    expect([200, 201]).toContain(closeRes.status);
    expect((closeRes.body as Record<string, unknown>)['stage']).toBe('WON');
  }, 60_000);

  it('derived CampaignDashboard projection records a new lead under its campaign', async () => {
    // Create a lead assigned to a known campaign so the CampaignDashboard
    // projection (keyed on the lead's campaign) gains/increments an entry.
    const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Projection Test Corp',
      contactName: 'Projection User',
      phone: '+61 2 9100 0002',
      email: 'proj@test.com',
      source: 'COLD_LIST',
      assignedCampaignId: CAMPAIGN_ID,
    });
    expect([200, 201]).toContain(createRes.status);

    // The CampaignDashboard derived projection must record an entry keyed on
    // the lead's campaign, carrying the totalLeads slot the LeadCreated reduce
    // owns. This proves the LeadCreated event keyed to the campaign (it fails
    // if the LeadCreated payload no longer carries assignedCampaignId, leaving
    // the projection without a campaign entry).
    const projRes = await fetch(`${app.engineUrl}/_admin/derived/CampaignDashboard`);
    expect(projRes.status).toBe(200);
    const projBody = await projRes.json() as Record<string, Record<string, unknown>>;
    expect(projBody[CAMPAIGN_ID]).toBeDefined();
    // The totalLeads reduce uses a ${...} counter expression; it must produce a
    // real finite number (>=1 for the lead(s) created on this campaign), not null/NaN.
    const totalLeads = projBody[CAMPAIGN_ID]!['totalLeads'];
    expect(typeof totalLeads === 'number' && Number.isFinite(totalLeads) && totalLeads >= 1).toBe(true);
  }, 60_000);
});
