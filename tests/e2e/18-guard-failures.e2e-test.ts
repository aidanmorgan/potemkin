/**
 * 18 — Guard Failures via full Specmatic stack.
 *
 * Verifies that the DSL's requires guards correctly reject commands when
 * preconditions are not met, exercised through the full Specmatic+plugin+Node
 * pipeline. For each guard scenario the test inspects the graph node state
 * before and after via /_admin/ endpoints.
 *
 * DSL files under test:
 *   lead-qualify.yaml, lead-contact.yaml, lead.yaml, campaign.yaml,
 *   campaign-activate.yaml, opportunity.yaml, opportunity-advance.yaml,
 *   opportunity-close.yaml, agent.yaml, call.yaml
 */

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd,
  getGraphNode,
  getEntityCount,
  getEventsByAggregate,
  getAllEntities,
} from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

function javaAvailable(): boolean {
  try { execSync('java -version', { stdio: 'pipe' }); return true; } catch { return false; }
}
const describeWithJava = javaAvailable() ? describe : describe.skip;

const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';
const AGENT_ID = '00000000-0000-7000-8000-000000000003';
const APEX_LEAD_NEW = '00000000-0000-7000-8000-000000000010';
const CORNERSTONE_LEAD_QUALIFIED = '00000000-0000-7000-8000-000000000012';

describeWithJava('18 — Guard Failures (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ---- 1. Lead qualify guards ----

  describe('Lead qualify guards (lead-qualify.yaml / lead.yaml requires)', () => {
    it('cannot qualify a NEW lead: status != CONTACTED', async () => {
      // Inspect graph node BEFORE: status is NEW
      const nodeBefore = await getGraphNode(app.engineUrl, APEX_LEAD_NEW);
      expect(nodeBefore!['status']).toBe('NEW');

      // Attempt to qualify
      const res = await fwd(app.engineUrl, 'POST', `/leads/${APEX_LEAD_NEW}/qualify`, {});
      expect(res.status).toBe(422);
      const details = (res.body as JsonObject)['details'] as Record<string, unknown> | undefined;
      expect(details?.['code']).toBe('LEAD_NOT_CONTACTED');

      // Verify graph was NOT mutated
      const nodeAfter = await getGraphNode(app.engineUrl, APEX_LEAD_NEW);
      expect(nodeAfter!['status']).toBe('NEW');
    }, 60_000);

    it('cannot qualify a CONTACTED lead with empty callIds', async () => {
      // Create a fresh lead and contact it (status == CONTACTED) but no calls
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Empty Calls Corp',
        contactName: 'EC User',
        phone: '+61 2 9500 0001',
        email: 'empty-calls@test.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(createRes.status);
      const leadId = (createRes.body as JsonObject)['id'] as string;

      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});

      // Inspect graph node BEFORE: status is CONTACTED but callIds is empty
      const nodeBefore = await getGraphNode(app.engineUrl, leadId);
      expect(nodeBefore!['status']).toBe('CONTACTED');
      expect(nodeBefore!['callIds']).toEqual([]);

      // Attempt to qualify
      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
      expect(res.status).toBe(422);
      const details = (res.body as JsonObject)['details'] as Record<string, unknown> | undefined;
      expect(details?.['code']).toBe('NO_CALLS_RECORDED');

      // Verify graph was NOT mutated
      const nodeAfter = await getGraphNode(app.engineUrl, leadId);
      expect(nodeAfter!['status']).toBe('CONTACTED');
    }, 60_000);

    it('both guards pass after logging a call: qualify succeeds', async () => {
      // Create a lead, log a call, then contact it
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Guard Pass Corp',
        contactName: 'GP User',
        phone: '+61 2 9500 0002',
        email: 'guard-pass@test.com',
        source: 'PARTNER',
      });
      expect([200, 201]).toContain(createRes.status);
      const leadId = (createRes.body as JsonObject)['id'] as string;

      // Log a call first (so callIds is populated via dispatch_commands)
      await fwd(app.engineUrl, 'POST', '/calls', {
        leadId,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED',
      });

      // Contact the lead (transition to CONTACTED)
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});

      // Inspect graph node BEFORE qualify
      const nodeBefore = await getGraphNode(app.engineUrl, leadId);
      expect(nodeBefore!['status']).toBe('CONTACTED');
      expect((nodeBefore!['callIds'] as string[]).length).toBeGreaterThan(0);

      // Qualify succeeds
      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
      expect(res.status).toBe(200);

      // Verify graph was mutated to QUALIFIED
      const nodeAfter = await getGraphNode(app.engineUrl, leadId);
      expect(nodeAfter!['status']).toBe('QUALIFIED');
    }, 60_000);
  });

  // ---- 2. Lead contact guards ----

  describe('Lead contact guards (lead-contact.yaml / lead.yaml requires)', () => {
    it('cannot contact a DNC lead', async () => {
      // Create a fresh lead and mark it DNC (requires manager auth)
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'DNC Guard Corp',
        contactName: 'DNC User',
        phone: '+61 2 9500 0010',
        email: 'dnc-guard@test.com',
        source: 'COLD_LIST',
      });
      expect([200, 201]).toContain(createRes.status);
      const leadId = (createRes.body as JsonObject)['id'] as string;

      // Mark as DNC with manager auth
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/dnc`, {
        reason: 'Customer requested removal',
      }, { 'Authorization': 'Bearer mgr1:manager' });

      // Inspect graph node BEFORE: status is DNC
      const nodeBefore = await getGraphNode(app.engineUrl, leadId);
      expect(nodeBefore!['status']).toBe('DNC');

      // Attempt to contact
      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
      expect(res.status).toBe(422);
      const details = (res.body as JsonObject)['details'] as Record<string, unknown> | undefined;
      expect(details?.['code']).toBe('LEAD_IS_DNC');

      // Verify graph was NOT mutated
      const nodeAfter = await getGraphNode(app.engineUrl, leadId);
      expect(nodeAfter!['status']).toBe('DNC');
    }, 60_000);

    it('cannot contact a CONVERTED lead', async () => {
      // Cornerstone is seeded as QUALIFIED -- convert it
      await fwd(app.engineUrl, 'POST', `/leads/${CORNERSTONE_LEAD_QUALIFIED}/convert`, {
        value: 75000,
      });

      // Inspect graph node BEFORE: status is CONVERTED
      const nodeBefore = await getGraphNode(app.engineUrl, CORNERSTONE_LEAD_QUALIFIED);
      expect(nodeBefore!['status']).toBe('CONVERTED');

      // Attempt to contact
      const res = await fwd(app.engineUrl, 'POST', `/leads/${CORNERSTONE_LEAD_QUALIFIED}/contact`, {});
      expect(res.status).toBe(422);
      const details = (res.body as JsonObject)['details'] as Record<string, unknown> | undefined;
      expect(details?.['code']).toBe('LEAD_ALREADY_CONVERTED');

      // Verify graph was NOT mutated
      const nodeAfter = await getGraphNode(app.engineUrl, CORNERSTONE_LEAD_QUALIFIED);
      expect(nodeAfter!['status']).toBe('CONVERTED');
    }, 60_000);
  });

  // ---- 3. Campaign guards ----

  describe('Campaign guards (campaign.yaml / campaign-activate.yaml requires)', () => {
    it('cannot activate an ACTIVE campaign', async () => {
      // CAMPAIGN_ID is seeded as ACTIVE
      const nodeBefore = await getGraphNode(app.engineUrl, CAMPAIGN_ID);
      expect(nodeBefore!['status']).toBe('ACTIVE');

      // Attempt to activate
      const res = await fwd(app.engineUrl, 'PATCH', `/campaigns/${CAMPAIGN_ID}/activate`, {});
      expect(res.status).toBe(422);
      const details = (res.body as JsonObject)['details'] as Record<string, unknown> | undefined;
      expect(details?.['code']).toBe('CAMPAIGN_NOT_ACTIVATABLE');

      // Verify graph was NOT mutated
      const nodeAfter = await getGraphNode(app.engineUrl, CAMPAIGN_ID);
      expect(nodeAfter!['status']).toBe('ACTIVE');
    }, 60_000);

    it('cannot create a campaign with endedAt before startedAt', async () => {
      const countBefore = await getEntityCount(app.engineUrl);

      // Attempt to create with invalid date range
      const res = await fwd(app.engineUrl, 'POST', '/campaigns', {
        name: 'Invalid Dates Campaign',
        targetSource: 'WEBSITE',
        script: 'Test script',
        startedAt: '2025-12-01T00:00:00.000Z',
        endedAt: '2025-01-01T00:00:00.000Z',
        targetCalls: 100,
        targetConversions: 10,
      });
      expect(res.status).toBe(422);
      const details = (res.body as JsonObject)['details'] as Record<string, unknown> | undefined;
      expect(details?.['code']).toBe('INVALID_DATE_RANGE');

      // Verify graph was NOT mutated
      const countAfter = await getEntityCount(app.engineUrl);
      expect(countAfter).toBe(countBefore);
    }, 60_000);
  });

  // ---- 4. Opportunity guards ----

  describe('Opportunity guards (opportunity-advance.yaml / opportunity-close.yaml requires)', () => {
    let oppId: string;
    let secondOppId: string;

    async function createOppViaLeadLifecycle(company: string, value: number): Promise<string> {
      const lr = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: company, contactName: 'O', phone: '+61 0',
        email: `${company.toLowerCase().replace(/\s/g, '')}@t.com`, source: 'REFERRAL',
      });
      const lid = (lr.body as JsonObject)['id'] as string;
      await fwd(app.engineUrl, 'POST', '/calls', { leadId: lid, agentId: AGENT_ID, campaignId: CAMPAIGN_ID, outcome: 'INTERESTED' });
      await fwd(app.engineUrl, 'POST', `/leads/${lid}/contact`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${lid}/qualify`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${lid}/convert`, { value, probability: 60 });
      const opps = await fwd(app.engineUrl, 'GET', '/opportunities');
      return ((opps.body as JsonObject[]).find(o => o['leadId'] === lid)!['id'] as string);
    }

    beforeAll(async () => {
      oppId = await createOppViaLeadLifecycle('Guard Opp A', 50000);
      secondOppId = await createOppViaLeadLifecycle('Guard Opp B', 30000);
    });

    it('cannot advance a NEGOTIATING opportunity (already at max advance stage)', async () => {
      // First advance: PROPOSED -> NEGOTIATING (should succeed)
      const advRes = await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppId}/advance`, {});
      expect(advRes.status).toBe(200);

      // Inspect graph node BEFORE second advance: stage is NEGOTIATING
      const nodeBefore = await getGraphNode(app.engineUrl, oppId);
      expect(nodeBefore!['stage']).toBe('NEGOTIATING');

      // Attempt second advance
      const res = await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppId}/advance`, {});
      expect(res.status).toBe(422);
      const details = (res.body as JsonObject)['details'] as Record<string, unknown> | undefined;
      expect(details?.['code']).toBe('ALREADY_NEGOTIATING');

      // Verify graph was NOT mutated
      const nodeAfter = await getGraphNode(app.engineUrl, oppId);
      expect(nodeAfter!['stage']).toBe('NEGOTIATING');
    }, 60_000);

    it('cannot advance a WON opportunity', async () => {
      // Close the opportunity as WON (it's currently NEGOTIATING)
      const closeRes = await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppId}/close`, { outcome: 'WON' });
      expect(closeRes.status).toBe(200);

      // Inspect graph node BEFORE: stage is WON
      const nodeBefore = await getGraphNode(app.engineUrl, oppId);
      expect(nodeBefore!['stage']).toBe('WON');

      // Attempt to advance
      const res = await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppId}/advance`, {});
      expect(res.status).toBe(422);
      const details = (res.body as JsonObject)['details'] as Record<string, unknown> | undefined;
      expect(details?.['code']).toBe('OPPORTUNITY_CLOSED');

      // Verify graph was NOT mutated
      const nodeAfter = await getGraphNode(app.engineUrl, oppId);
      expect(nodeAfter!['stage']).toBe('WON');
    }, 60_000);

    it('cannot win a LOST opportunity', async () => {
      // Close second opportunity as LOST
      const closeRes = await fwd(app.engineUrl, 'PATCH', `/opportunities/${secondOppId}/close`, {
        outcome: 'LOST',
        closureReason: 'Budget cut',
      });
      expect(closeRes.status).toBe(200);

      // Inspect graph node BEFORE: stage is LOST
      const nodeBefore = await getGraphNode(app.engineUrl, secondOppId);
      expect(nodeBefore!['stage']).toBe('LOST');

      // Attempt to close as WON
      const res = await fwd(app.engineUrl, 'PATCH', `/opportunities/${secondOppId}/close`, { outcome: 'WON' });
      expect(res.status).toBe(422);
      const details = (res.body as JsonObject)['details'] as Record<string, unknown> | undefined;
      expect(details?.['code']).toBe('CANNOT_WIN');

      // Verify graph was NOT mutated
      const nodeAfter = await getGraphNode(app.engineUrl, secondOppId);
      expect(nodeAfter!['stage']).toBe('LOST');
    }, 60_000);
  });

  // ---- 5. Agent guards ----

  describe('Agent guards (agent.yaml requires)', () => {
    it('cannot create an agent with zero dailyCallQuota', async () => {
      const countBefore = await getEntityCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', '/agents', {
        name: 'Zero Quota Agent', email: 'zq@nb.com', dailyCallQuota: 0, skills: [],
      });
      expect(res.status).toBe(422);
      const details = (res.body as JsonObject)['details'] as Record<string, unknown> | undefined;
      expect(details?.['code']).toBe('INVALID_QUOTA');

      const countAfter = await getEntityCount(app.engineUrl);
      expect(countAfter).toBe(countBefore);
    }, 60_000);
  });

  // ---- 6. Call guards ----

  describe('Call guards (call.yaml requires)', () => {
    it('cannot log a call without an outcome', async () => {
      const countBefore = await getEntityCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId: APEX_LEAD_NEW, agentId: AGENT_ID, campaignId: CAMPAIGN_ID, outcome: null,
      });
      expect(res.status).toBe(422);
      const details = (res.body as JsonObject)['details'] as Record<string, unknown> | undefined;
      expect(details?.['code']).toBe('MISSING_OUTCOME');

      const countAfter = await getEntityCount(app.engineUrl);
      expect(countAfter).toBe(countBefore);
    }, 60_000);

    it('cannot log a call without a leadId', async () => {
      const countBefore = await getEntityCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId: null, agentId: AGENT_ID, campaignId: CAMPAIGN_ID, outcome: 'INTERESTED',
      });
      expect(res.status).toBe(422);
      const details = (res.body as JsonObject)['details'] as Record<string, unknown> | undefined;
      expect(details?.['code']).toBe('MISSING_LEAD');

      const countAfter = await getEntityCount(app.engineUrl);
      expect(countAfter).toBe(countBefore);
    }, 60_000);
  });
});
