/**
 * 12 — Saga compensation: trigger a saga that fails mid-execution and verify
 * compensation events are emitted.
 *
 * The LeadConversionSaga in global.yaml triggers on LeadConverted, creates
 * an Opportunity, and compensates by reverting the lead's status on failure.
 *
 * We test the happy path (saga creates Opportunity) and the structural
 * integrity of the pipeline.  Full compensation requires injecting a failure
 * in the Opportunity creation step, which is not directly injectable in the
 * current engine without fault-sim — so we verify the saga runs to completion
 * on the happy path and document the compensation path as `it.todo`.
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

const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';
const AGENT_ID = '00000000-0000-7000-8000-000000000003';

async function fwd(
  engineUrl: string,
  method: string,
  path: string,
  body: unknown = null,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${engineUrl}/_engine/forward`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, path, headers, query: {}, body }),
  });
  return res.json() as Promise<{ status: number; body: Record<string, unknown> }>;
}

describeWithJava('12 — Saga: LeadConversionSaga creates Opportunity on convert', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  /**
   * BUG: LeadConversionSaga step uses `event.payload.agentId` and
   * `event.payload.campaignId` but the LeadConverted event's payload_template
   * only sets `convertedAt`.  agentId/campaignId evaluate to null, the
   * Opportunity creation fails silently (fire-and-forget saga).
   * Fix: update the saga step to use `state.assignedAgentId` or add agentId/campaignId
   * to the LeadConverted payload_template.
   */
  it('converting a qualified lead triggers the saga and creates an Opportunity [BUG: saga payload uses wrong event fields]', async () => {
    // Create fresh lead
    const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Saga Test Corp',
      contactName: 'Saga User',
      phone: '+61 2 9300 0001',
      email: 'saga@test.com',
      source: 'REFERRAL',
    });
    const leadId = createRes.body['id'] as string;

    // Log call (required for qualify)
    await fwd(app.engineUrl, 'POST', '/calls', {
      leadId,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'INTERESTED',
    });

    // Contact
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});

    // Qualify
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});

    // Convert — triggers LeadConversionSaga
    const convertRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/convert`, {
      value: 25000,
      probability: 60,
    });
    expect([200, 201]).toContain(convertRes.status);
    expect(convertRes.body['status']).toBe('CONVERTED');

    // Verify Opportunity was created by the saga
    const oppsRes = await fwd(app.engineUrl, 'GET', '/opportunities');
    expect(oppsRes.status).toBe(200);
    const opps = oppsRes.body as unknown as Array<Record<string, unknown>>;
    const sagaOpp = opps.find((o) => o['leadId'] === leadId);
    expect(sagaOpp).toBeDefined();
    expect(sagaOpp!['stage']).toBe('PROPOSED');
    expect(sagaOpp!['value']).toBe(25000);
  }, 60_000);

  it('saga Opportunity has correct leadId linking it to the converted Lead [BUG: same saga payload issue]', async () => {
    // Create + contact + qualify + convert a second lead
    const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Saga Link Corp',
      contactName: 'Saga Link User',
      phone: '+61 2 9300 0002',
      email: 'sagalink@test.com',
      source: 'PARTNER',
    });
    const leadId = createRes.body['id'] as string;

    await fwd(app.engineUrl, 'POST', '/calls', {
      leadId, agentId: AGENT_ID, campaignId: CAMPAIGN_ID, outcome: 'INTERESTED',
    });
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/convert`, { value: 10000 });

    const oppsRes = await fwd(app.engineUrl, 'GET', '/opportunities');
    const opps = oppsRes.body as unknown as Array<Record<string, unknown>>;
    const opp = opps.find((o) => o['leadId'] === leadId);
    expect(opp).toBeDefined();
    expect(opp!['leadId']).toBe(leadId);
  }, 60_000);

  // Compensation path requires fault injection — documented as failing/todo.
  it.todo('saga compensates and reverts Lead status when Opportunity creation fails');
});
