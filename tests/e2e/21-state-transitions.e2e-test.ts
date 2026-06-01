/**
 * 21 — State Transitions Exhaustive: ALL valid and invalid transitions via
 * the full Specmatic+plugin+Node stack.
 *
 * Verifies every defined state transition in the CRM DSL YAML fixtures by
 * sending requests through the full Specmatic stack and inspecting state via
 * /_admin/ endpoints.
 *
 * For each invalid transition: verify 422, graph node state unchanged.
 * For each valid transition: verify 200, graph node state updated, event emitted.
 *
 * Covers:
 *   Lead: NEW->CONTACTED, NEW->QUALIFIED (invalid), NEW->CONVERTED (invalid),
 *         CONTACTED->QUALIFIED (with/without calls), QUALIFIED->CONVERTED,
 *         CONTACTED->DISQUALIFIED, DNC->CONTACTED (invalid), CONVERTED->CONTACTED (invalid)
 *   Campaign: DRAFT->ACTIVE, ACTIVE->PAUSED, PAUSED->ACTIVE, ACTIVE->COMPLETED,
 *             COMPLETED->ACTIVE (invalid), DRAFT->COMPLETED (invalid)
 *   Opportunity: PROPOSED->NEGOTIATING, PROPOSED->LOST, NEGOTIATING->WON,
 *                WON->NEGOTIATING (invalid), LOST->WON (invalid)
 *
 * DSL files under test:
 *   lead.yaml, lead-contact.yaml, lead-qualify.yaml, lead-convert.yaml,
 *   lead-disqualify.yaml, lead-dnc.yaml
 *   campaign.yaml, campaign-activate.yaml, campaign-pause.yaml, campaign-complete.yaml
 *   opportunity.yaml, opportunity-advance.yaml, opportunity-close.yaml
 *   global.yaml (LeadConversionSaga)
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd, getGraphNode, getEventsByAggregate,
  javaAvailable,
} from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

const CAMPAIGN_ACTIVE_ID = '00000000-0000-7000-8000-000000000001';
const CAMPAIGN_DRAFT_ID = '00000000-0000-7000-8000-000000000002';
const AGENT_ID = '00000000-0000-7000-8000-000000000003';
const CORNERSTONE_LEAD_QUALIFIED = '00000000-0000-7000-8000-000000000012';

describeWithJava('21 — State Transitions Exhaustive (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ─── Helper: create a fresh lead ──────────────────────────────────────────

  let leadCounter = 0;
  async function createFreshLead(source = 'WEBSITE'): Promise<string> {
    leadCounter++;
    const res = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: `Trans Lead ${leadCounter}`,
      contactName: `TL${leadCounter}`,
      phone: `+61 2 6000 ${String(leadCounter).padStart(4, '0')}`,
      email: `trans-lead-${leadCounter}@test.com`,
      source,
    });
    expect([200, 201]).toContain(res.status);
    return (res.body as JsonObject)['id'] as string;
  }

  // ─── Helper: progress lead to QUALIFIED state ─────────────────────────────

  async function progressToQualified(leadId: string): Promise<void> {
    const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
      leadId, agentId: AGENT_ID, campaignId: CAMPAIGN_ACTIVE_ID, outcome: 'INTERESTED',
    });
    expect([200, 201]).toContain(callRes.status);
    const contactRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
    expect(contactRes.status).toBe(200);
    const qualifyRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
    expect(qualifyRes.status).toBe(200);
  }

  // ─── Helper: create opportunity via lead lifecycle + saga ─────────────────

  async function createOpportunity(company: string, value: number): Promise<string> {
    const leadId = await createFreshLead('REFERRAL');
    const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
      leadId, agentId: AGENT_ID, campaignId: CAMPAIGN_ACTIVE_ID, outcome: 'INTERESTED',
    });
    expect([200, 201]).toContain(callRes.status);
    const contactRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
    expect(contactRes.status).toBe(200);
    const qualifyRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
    expect(qualifyRes.status).toBe(200);
    const convertRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/convert`, {
      value, probability: 50,
    });
    expect(convertRes.status).toBe(200);

    // Find the opportunity created by the saga for this lead
    const oppsRes = await fwd(app.engineUrl, 'GET', '/opportunities');
    expect(oppsRes.status).toBe(200);
    const opps = oppsRes.body as JsonObject[];
    const opp = opps.find(o => o['leadId'] === leadId);
    expect(opp).toBeDefined();
    return opp!['id'] as string;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LEAD TRANSITIONS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Lead transitions', () => {
    // 1. NEW -> CONTACTED (valid)
    it('NEW -> CONTACTED via POST /leads/{id}/contact is valid', async () => {
      const leadId = await createFreshLead();
      const nodeBefore = await getGraphNode(app.engineUrl, leadId);
      expect(nodeBefore!['status']).toBe('NEW');
      const eventsBefore = await getEventsByAggregate(app.engineUrl, leadId);

      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node!['status']).toBe('CONTACTED');

      const eventsAfter = await getEventsByAggregate(app.engineUrl, leadId);
      expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
      expect(eventsAfter.some(e => e.type === 'LeadContacted')).toBe(true);
    }, 60_000);

    // 2. NEW -> QUALIFIED (invalid)
    it('NEW -> QUALIFIED via POST /leads/{id}/qualify is invalid (422)', async () => {
      const leadId = await createFreshLead();
      const eventsBefore = await getEventsByAggregate(app.engineUrl, leadId);

      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
      expect(res.status).toBe(422);

      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node!['status']).toBe('NEW');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, leadId);
      expect(eventsAfter.length).toBe(eventsBefore.length);
    }, 60_000);

    // 3. NEW -> CONVERTED (invalid)
    it('NEW -> CONVERTED via POST /leads/{id}/convert is invalid (422)', async () => {
      const leadId = await createFreshLead();
      const eventsBefore = await getEventsByAggregate(app.engineUrl, leadId);

      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/convert`, { value: 10000 });
      expect(res.status).toBe(422);

      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node!['status']).toBe('NEW');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, leadId);
      expect(eventsAfter.length).toBe(eventsBefore.length);
    }, 60_000);

    // 4. CONTACTED -> QUALIFIED with calls (valid)
    it('CONTACTED -> QUALIFIED with calls via POST /leads/{id}/qualify is valid', async () => {
      const leadId = await createFreshLead();
      // Log a call first, then contact
      const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId, agentId: AGENT_ID, campaignId: CAMPAIGN_ACTIVE_ID, outcome: 'INTERESTED',
      });
      expect([200, 201]).toContain(callRes.status);
      const contactRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
      expect(contactRes.status).toBe(200);

      const nodeMid = await getGraphNode(app.engineUrl, leadId);
      expect(nodeMid!['status']).toBe('CONTACTED');
      expect((nodeMid!['callIds'] as string[]).length).toBeGreaterThan(0);

      const eventsBefore = await getEventsByAggregate(app.engineUrl, leadId);

      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node!['status']).toBe('QUALIFIED');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, leadId);
      expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
      expect(eventsAfter.some(e => e.type === 'LeadQualified')).toBe(true);
    }, 60_000);

    // 5. CONTACTED -> QUALIFIED without calls (invalid)
    it('CONTACTED -> QUALIFIED without calls is invalid (422)', async () => {
      const leadId = await createFreshLead();
      const contactRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
      expect(contactRes.status).toBe(200);

      const nodeMid = await getGraphNode(app.engineUrl, leadId);
      expect(nodeMid!['status']).toBe('CONTACTED');
      expect(nodeMid!['callIds']).toEqual([]);

      const eventsBefore = await getEventsByAggregate(app.engineUrl, leadId);

      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
      expect(res.status).toBe(422);

      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node!['status']).toBe('CONTACTED');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, leadId);
      expect(eventsAfter.length).toBe(eventsBefore.length);
    }, 60_000);

    // 6. QUALIFIED -> CONVERTED (valid)
    it('QUALIFIED -> CONVERTED via POST /leads/{id}/convert is valid', async () => {
      const leadId = await createFreshLead();
      await progressToQualified(leadId);

      const nodeMid = await getGraphNode(app.engineUrl, leadId);
      expect(nodeMid!['status']).toBe('QUALIFIED');
      const eventsBefore = await getEventsByAggregate(app.engineUrl, leadId);

      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/convert`, { value: 50000 });
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node!['status']).toBe('CONVERTED');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, leadId);
      expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
      expect(eventsAfter.some(e => e.type === 'LeadConverted')).toBe(true);
    }, 60_000);

    // 7. CONTACTED -> DISQUALIFIED (valid)
    it('CONTACTED -> DISQUALIFIED via POST /leads/{id}/disqualify is valid', async () => {
      const leadId = await createFreshLead();
      const contactRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
      expect(contactRes.status).toBe(200);

      const nodeMid = await getGraphNode(app.engineUrl, leadId);
      expect(nodeMid!['status']).toBe('CONTACTED');
      const eventsBefore = await getEventsByAggregate(app.engineUrl, leadId);

      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/disqualify`, { reason: 'No budget' });
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node!['status']).toBe('DISQUALIFIED');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, leadId);
      expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
      expect(eventsAfter.some(e => e.type === 'LeadDisqualified')).toBe(true);
    }, 60_000);

    // 8. DNC -> CONTACTED (invalid)
    it('DNC -> CONTACTED via POST /leads/{id}/contact is invalid (422)', async () => {
      const leadId = await createFreshLead();
      // Mark as DNC with manager auth
      const dncRes = await fwd(
        app.engineUrl, 'POST', `/leads/${leadId}/dnc`,
        { reason: 'Requested removal' },
        { authorization: 'Bearer mgr1:manager' },
      );
      expect(dncRes.status).toBe(200);

      const nodeMid = await getGraphNode(app.engineUrl, leadId);
      expect(nodeMid!['status']).toBe('DNC');
      const eventsBefore = await getEventsByAggregate(app.engineUrl, leadId);

      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
      expect(res.status).toBe(422);

      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node!['status']).toBe('DNC');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, leadId);
      expect(eventsAfter.length).toBe(eventsBefore.length);
    }, 60_000);

    // 9. CONVERTED -> CONTACTED (invalid)
    it('CONVERTED -> CONTACTED via POST /leads/{id}/contact is invalid (422)', async () => {
      // Use Cornerstone which is seeded as QUALIFIED -- convert it first
      const convertRes = await fwd(app.engineUrl, 'POST', `/leads/${CORNERSTONE_LEAD_QUALIFIED}/convert`, {
        value: 75000,
      });
      expect(convertRes.status).toBe(200);

      const nodeMid = await getGraphNode(app.engineUrl, CORNERSTONE_LEAD_QUALIFIED);
      expect(nodeMid!['status']).toBe('CONVERTED');
      const eventsBefore = await getEventsByAggregate(app.engineUrl, CORNERSTONE_LEAD_QUALIFIED);

      const res = await fwd(app.engineUrl, 'POST', `/leads/${CORNERSTONE_LEAD_QUALIFIED}/contact`, {});
      expect(res.status).toBe(422);

      const node = await getGraphNode(app.engineUrl, CORNERSTONE_LEAD_QUALIFIED);
      expect(node!['status']).toBe('CONVERTED');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, CORNERSTONE_LEAD_QUALIFIED);
      expect(eventsAfter.length).toBe(eventsBefore.length);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CAMPAIGN TRANSITIONS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Campaign transitions', () => {
    let freshCampaignId: string;

    beforeAll(async () => {
      // Create a fresh campaign for the full lifecycle test
      const res = await fwd(app.engineUrl, 'POST', '/campaigns', {
        name: 'Transition Test Campaign',
        targetSource: 'WEBSITE',
        script: 'Test script for transitions',
        startedAt: '2025-01-01T00:00:00.000Z',
        endedAt: '2025-12-31T23:59:59.000Z',
        targetCalls: 100,
        targetConversions: 10,
      });
      expect([200, 201]).toContain(res.status);
      freshCampaignId = (res.body as JsonObject)['id'] as string;
    }, 60_000);

    // 10. DRAFT -> ACTIVE (valid)
    it('DRAFT -> ACTIVE via PATCH /campaigns/{id}/activate is valid', async () => {
      const nodeBefore = await getGraphNode(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(nodeBefore!['status']).toBe('DRAFT');
      const eventsBefore = await getEventsByAggregate(app.engineUrl, CAMPAIGN_DRAFT_ID);

      const res = await fwd(app.engineUrl, 'PATCH', `/campaigns/${CAMPAIGN_DRAFT_ID}/activate`, {});
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(node!['status']).toBe('ACTIVE');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
      expect(eventsAfter.some(e => e.type === 'CampaignActivated')).toBe(true);
    }, 60_000);

    // 11. ACTIVE -> PAUSED (valid)
    it('ACTIVE -> PAUSED via PATCH /campaigns/{id}/pause is valid', async () => {
      // CAMPAIGN_DRAFT_ID is now ACTIVE from test 10
      const nodeBefore = await getGraphNode(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(nodeBefore!['status']).toBe('ACTIVE');
      const eventsBefore = await getEventsByAggregate(app.engineUrl, CAMPAIGN_DRAFT_ID);

      const res = await fwd(app.engineUrl, 'PATCH', `/campaigns/${CAMPAIGN_DRAFT_ID}/pause`, {});
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(node!['status']).toBe('PAUSED');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
      expect(eventsAfter.some(e => e.type === 'CampaignPaused')).toBe(true);
    }, 60_000);

    // 12. PAUSED -> ACTIVE (valid, re-activate)
    it('PAUSED -> ACTIVE via PATCH /campaigns/{id}/activate is valid (re-activate)', async () => {
      const nodeBefore = await getGraphNode(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(nodeBefore!['status']).toBe('PAUSED');

      const res = await fwd(app.engineUrl, 'PATCH', `/campaigns/${CAMPAIGN_DRAFT_ID}/activate`, {});
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(node!['status']).toBe('ACTIVE');
    }, 60_000);

    // 13. ACTIVE -> COMPLETED (valid)
    it('ACTIVE -> COMPLETED via PATCH /campaigns/{id}/complete is valid', async () => {
      // CAMPAIGN_DRAFT_ID is now ACTIVE again
      const nodeBefore = await getGraphNode(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(nodeBefore!['status']).toBe('ACTIVE');
      const eventsBefore = await getEventsByAggregate(app.engineUrl, CAMPAIGN_DRAFT_ID);

      const res = await fwd(app.engineUrl, 'PATCH', `/campaigns/${CAMPAIGN_DRAFT_ID}/complete`, {});
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(node!['status']).toBe('COMPLETED');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
      expect(eventsAfter.some(e => e.type === 'CampaignCompleted')).toBe(true);
    }, 60_000);

    // 14. COMPLETED -> ACTIVE (invalid)
    it('COMPLETED -> ACTIVE via PATCH /campaigns/{id}/activate is invalid (422)', async () => {
      const nodeBefore = await getGraphNode(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(nodeBefore!['status']).toBe('COMPLETED');
      const eventsBefore = await getEventsByAggregate(app.engineUrl, CAMPAIGN_DRAFT_ID);

      const res = await fwd(app.engineUrl, 'PATCH', `/campaigns/${CAMPAIGN_DRAFT_ID}/activate`, {});
      expect(res.status).toBe(422);

      const node = await getGraphNode(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(node!['status']).toBe('COMPLETED');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(eventsAfter.length).toBe(eventsBefore.length);
    }, 60_000);

    // 15. DRAFT -> COMPLETED (invalid)
    it('DRAFT -> COMPLETED via PATCH /campaigns/{id}/complete is invalid (422)', async () => {
      // Use freshCampaignId which is still DRAFT
      const nodeBefore = await getGraphNode(app.engineUrl, freshCampaignId);
      expect(nodeBefore!['status']).toBe('DRAFT');
      const eventsBefore = await getEventsByAggregate(app.engineUrl, freshCampaignId);

      const res = await fwd(app.engineUrl, 'PATCH', `/campaigns/${freshCampaignId}/complete`, {});
      expect(res.status).toBe(422);

      const node = await getGraphNode(app.engineUrl, freshCampaignId);
      expect(node!['status']).toBe('DRAFT');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, freshCampaignId);
      expect(eventsAfter.length).toBe(eventsBefore.length);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // OPPORTUNITY TRANSITIONS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Opportunity transitions', () => {
    let oppAdvanceId: string;
    let oppLostFromProposedId: string;
    let oppWonId: string;
    let oppLostId: string;

    beforeAll(async () => {
      // Create opportunities for the various transition tests
      oppAdvanceId = await createOpportunity('Opp Advance Corp', 50000);
      oppLostFromProposedId = await createOpportunity('Opp Lost Corp', 30000);
      oppWonId = await createOpportunity('Opp Won Corp', 70000);
      oppLostId = await createOpportunity('Opp Lost Final', 25000);
    }, 60_000);

    // 16. PROPOSED -> NEGOTIATING (valid)
    it('PROPOSED -> NEGOTIATING via PATCH /opportunities/{id}/advance is valid', async () => {
      const nodeBefore = await getGraphNode(app.engineUrl, oppAdvanceId);
      expect(nodeBefore!['stage']).toBe('PROPOSED');
      const eventsBefore = await getEventsByAggregate(app.engineUrl, oppAdvanceId);

      const res = await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppAdvanceId}/advance`, {});
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, oppAdvanceId);
      expect(node!['stage']).toBe('NEGOTIATING');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, oppAdvanceId);
      expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
      expect(eventsAfter.some(e => e.type === 'OpportunityAdvanced')).toBe(true);
    }, 60_000);

    // 17. PROPOSED -> LOST (valid)
    it('PROPOSED -> LOST via PATCH /opportunities/{id}/close with outcome:LOST is valid', async () => {
      const nodeBefore = await getGraphNode(app.engineUrl, oppLostFromProposedId);
      expect(nodeBefore!['stage']).toBe('PROPOSED');
      const eventsBefore = await getEventsByAggregate(app.engineUrl, oppLostFromProposedId);

      const res = await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppLostFromProposedId}/close`, {
        outcome: 'LOST',
        closureReason: 'Budget cut',
      });
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, oppLostFromProposedId);
      expect(node!['stage']).toBe('LOST');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, oppLostFromProposedId);
      expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
      expect(eventsAfter.some(e => e.type === 'OpportunityLost')).toBe(true);
    }, 60_000);

    // 18. NEGOTIATING -> WON (valid)
    it('NEGOTIATING -> WON via PATCH /opportunities/{id}/close with outcome:WON is valid', async () => {
      // Advance to NEGOTIATING first
      const advanceRes = await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppWonId}/advance`, {});
      expect(advanceRes.status).toBe(200);
      const nodeMid = await getGraphNode(app.engineUrl, oppWonId);
      expect(nodeMid!['stage']).toBe('NEGOTIATING');

      const eventsBefore = await getEventsByAggregate(app.engineUrl, oppWonId);

      const res = await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppWonId}/close`, {
        outcome: 'WON',
      });
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, oppWonId);
      expect(node!['stage']).toBe('WON');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, oppWonId);
      expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
      expect(eventsAfter.some(e => e.type === 'OpportunityWon')).toBe(true);
    }, 60_000);

    // 19. WON -> NEGOTIATING (invalid)
    it('WON -> NEGOTIATING via PATCH /opportunities/{id}/advance after WON is invalid (422)', async () => {
      // oppWonId is now WON from test 18
      const nodeBefore = await getGraphNode(app.engineUrl, oppWonId);
      expect(nodeBefore!['stage']).toBe('WON');
      const eventsBefore = await getEventsByAggregate(app.engineUrl, oppWonId);

      const res = await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppWonId}/advance`, {});
      expect(res.status).toBe(422);

      const node = await getGraphNode(app.engineUrl, oppWonId);
      expect(node!['stage']).toBe('WON');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, oppWonId);
      expect(eventsAfter.length).toBe(eventsBefore.length);
    }, 60_000);

    // 20. LOST -> WON (invalid)
    it('LOST -> WON via PATCH /opportunities/{id}/close WON after LOST is invalid (422)', async () => {
      // Close as LOST first
      const lostRes = await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppLostId}/close`, {
        outcome: 'LOST',
        closureReason: 'Competitor won',
      });
      expect(lostRes.status).toBe(200);

      const nodeMid = await getGraphNode(app.engineUrl, oppLostId);
      expect(nodeMid!['stage']).toBe('LOST');
      const eventsBefore = await getEventsByAggregate(app.engineUrl, oppLostId);

      const res = await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppLostId}/close`, {
        outcome: 'WON',
      });
      expect(res.status).toBe(422);

      const node = await getGraphNode(app.engineUrl, oppLostId);
      expect(node!['stage']).toBe('LOST');
      const eventsAfter = await getEventsByAggregate(app.engineUrl, oppLostId);
      expect(eventsAfter.length).toBe(eventsBefore.length);
    }, 60_000);
  });
});
