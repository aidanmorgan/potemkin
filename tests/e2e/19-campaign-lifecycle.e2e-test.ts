/**
 * 19 — Campaign Lifecycle Multi-Agent via full Specmatic stack.
 *
 * Exercises the complete CRM lifecycle through the full Specmatic+plugin+Node
 * pipeline: campaign creation, activation, lead management, calls, conversions,
 * opportunity lifecycle, campaign completion, and agent status transitions.
 *
 * All state is verified via /_admin/ endpoints.
 *
 * DSL files under test:
 *   campaign.yaml, campaign-activate.yaml, campaign-pause.yaml, campaign-complete.yaml
 *   agent.yaml, agent-status.yaml
 *   lead.yaml, lead-contact.yaml, lead-qualify.yaml, lead-disqualify.yaml, lead-convert.yaml
 *   call.yaml
 *   opportunity.yaml, opportunity-advance.yaml, opportunity-close.yaml
 *   global.yaml (LeadConversionSaga)
 */

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd,
  getGraphNode,
  getEventsByAggregate,
  getAllEntities,
} from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

function javaAvailable(): boolean {
  try { execSync('java -version', { stdio: 'pipe' }); return true; } catch { return false; }
}
const describeWithJava = javaAvailable() ? describe : describe.skip;

describeWithJava('19 — Campaign Lifecycle Multi-Agent (full Specmatic stack)', () => {
  let app: E2eApp;

  // Entity IDs populated during the workflow
  let campaignId: string;
  let agentAliceId: string;
  let agentBobId: string;

  let leadWebsiteId: string;
  let leadReferralId: string;
  let leadColdListId: string;

  let callAliceWebsiteId: string;
  let callBobReferralId: string;
  let callAliceColdListId: string;

  let opportunityWebsiteId: string;
  let opportunityReferralId: string;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ---- Phase 1: Create campaign + agents ----

  describe('Phase 1: Create campaign + agents', () => {
    it('POST /campaigns creates a DRAFT campaign in the graph', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/campaigns', {
        name: 'Multi-Agent Outbound Q3',
        targetSource: 'WEBSITE',
        script: 'Hello, this is a follow-up regarding your recent inquiry...',
        startedAt: '2025-07-01T00:00:00.000Z',
        endedAt: '2025-09-30T23:59:59.000Z',
        targetCalls: 300,
        targetConversions: 40,
      });
      expect([200, 201]).toContain(res.status);
      campaignId = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, campaignId);
      expect(node).not.toBeNull();
      expect(node!['status']).toBe('DRAFT');
      expect(node!['name']).toBe('Multi-Agent Outbound Q3');
      expect(node!['targetCalls']).toBe(300);
      expect(node!['targetConversions']).toBe(40);
      expect(node!['actualCalls']).toBe(0);
      expect(node!['actualConversions']).toBe(0);
      expect(node!['assignedAgentIds']).toEqual([]);
    }, 60_000);

    it('POST /agents creates Agent Alice with AVAILABLE status', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/agents', {
        name: 'Alice Lifecycle',
        email: 'alice-lc@nuisance-bureau.com',
        dailyCallQuota: 40,
        skills: ['B2B', 'SaaS'],
      });
      expect([200, 201]).toContain(res.status);
      agentAliceId = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, agentAliceId);
      expect(node).not.toBeNull();
      expect(node!['currentStatus']).toBe('AVAILABLE');
      expect(node!['dailyCallCount']).toBe(0);
      expect(node!['totalConversions']).toBe(0);
      expect(node!['name']).toBe('Alice Lifecycle');
      expect(node!['skills']).toEqual(['B2B', 'SaaS']);
    }, 60_000);

    it('POST /agents creates Agent Bob with AVAILABLE status', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/agents', {
        name: 'Bob Lifecycle',
        email: 'bob-lc@nuisance-bureau.com',
        dailyCallQuota: 35,
        skills: ['Enterprise', 'Finance'],
      });
      expect([200, 201]).toContain(res.status);
      agentBobId = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, agentBobId);
      expect(node).not.toBeNull();
      expect(node!['currentStatus']).toBe('AVAILABLE');
      expect(node!['dailyCallCount']).toBe(0);
      expect(node!['totalConversions']).toBe(0);
    }, 60_000);
  });

  // ---- Phase 2: Activate campaign ----

  describe('Phase 2: Activate campaign', () => {
    it('PATCH /campaigns/:id/activate transitions DRAFT to ACTIVE in graph', async () => {
      const res = await fwd(app.engineUrl, 'PATCH', `/campaigns/${campaignId}/activate`, {});
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, campaignId);
      expect(node!['status']).toBe('ACTIVE');
    }, 60_000);

    it('CampaignActivated event appears in the event stream', async () => {
      const events = await getEventsByAggregate(app.engineUrl, campaignId);
      const activated = events.find(e => e.type === 'CampaignActivated');
      expect(activated).toBeDefined();
      expect(activated!.boundary).toBe('CampaignActivate');
      expect(activated!.payload['activatedAt']).toBeDefined();
    }, 60_000);
  });

  // ---- Phase 3: Create leads ----

  describe('Phase 3: Create leads with different sources', () => {
    it('POST /leads creates WEBSITE lead with score=50', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'WebCorp',
        contactName: 'Web User',
        phone: '+61 2 9100 0001',
        email: 'web@webcorp.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(res.status);
      leadWebsiteId = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, leadWebsiteId);
      expect(node!['status']).toBe('NEW');
      expect(node!['score']).toBe(50);
      expect(node!['source']).toBe('WEBSITE');
      expect(node!['callIds']).toEqual([]);
    }, 60_000);

    it('POST /leads creates REFERRAL lead with score=80', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'RefCorp',
        contactName: 'Ref User',
        phone: '+61 2 9100 0002',
        email: 'ref@refcorp.com',
        source: 'REFERRAL',
      });
      expect([200, 201]).toContain(res.status);
      leadReferralId = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, leadReferralId);
      expect(node!['status']).toBe('NEW');
      expect(node!['score']).toBe(80);
      expect(node!['source']).toBe('REFERRAL');
      expect(node!['callIds']).toEqual([]);
    }, 60_000);

    it('POST /leads creates COLD_LIST lead with score=20', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'ColdCorp',
        contactName: 'Cold User',
        phone: '+61 2 9100 0003',
        email: 'cold@coldcorp.com',
        source: 'COLD_LIST',
      });
      expect([200, 201]).toContain(res.status);
      leadColdListId = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, leadColdListId);
      expect(node!['status']).toBe('NEW');
      expect(node!['score']).toBe(20);
      expect(node!['source']).toBe('COLD_LIST');
      expect(node!['callIds']).toEqual([]);
    }, 60_000);
  });

  // ---- Phase 4: Log calls ----

  describe('Phase 4: Log calls and verify cross-boundary graph updates', () => {
    it('Alice calls WEBSITE lead: call + lead + agent graph nodes updated', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId: leadWebsiteId,
        agentId: agentAliceId,
        campaignId,
        outcome: 'INTERESTED',
        durationSeconds: 180,
      });
      expect([200, 201]).toContain(res.status);
      callAliceWebsiteId = (res.body as JsonObject)['id'] as string;

      // Call graph node created
      const callNode = await getGraphNode(app.engineUrl, callAliceWebsiteId);
      expect(callNode).not.toBeNull();
      expect(callNode!['leadId']).toBe(leadWebsiteId);
      expect(callNode!['agentId']).toBe(agentAliceId);
      expect(callNode!['outcome']).toBe('INTERESTED');

      // Lead graph node: callId appended
      const leadNode = await getGraphNode(app.engineUrl, leadWebsiteId);
      expect((leadNode!['callIds'] as string[])).toContain(callAliceWebsiteId);

      // Agent graph node: dailyCallCount incremented
      const agentNode = await getGraphNode(app.engineUrl, agentAliceId);
      expect(agentNode!['dailyCallCount']).toBe(1);
    }, 60_000);

    it('Bob calls REFERRAL lead: both agents have independent call counts', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId: leadReferralId,
        agentId: agentBobId,
        campaignId,
        outcome: 'CALLBACK_SCHEDULED',
        durationSeconds: 90,
      });
      expect([200, 201]).toContain(res.status);
      callBobReferralId = (res.body as JsonObject)['id'] as string;

      // Lead graph node updated
      const leadNode = await getGraphNode(app.engineUrl, leadReferralId);
      expect((leadNode!['callIds'] as string[])).toContain(callBobReferralId);

      // Bob's count = 1, Alice's still = 1
      const bobNode = await getGraphNode(app.engineUrl, agentBobId);
      expect(bobNode!['dailyCallCount']).toBe(1);

      const aliceNode = await getGraphNode(app.engineUrl, agentAliceId);
      expect(aliceNode!['dailyCallCount']).toBe(1);
    }, 60_000);

    it('Alice calls COLD_LIST lead: her dailyCallCount increments to 2', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId: leadColdListId,
        agentId: agentAliceId,
        campaignId,
        outcome: 'NOT_INTERESTED',
        durationSeconds: 60,
      });
      expect([200, 201]).toContain(res.status);
      callAliceColdListId = (res.body as JsonObject)['id'] as string;

      const leadNode = await getGraphNode(app.engineUrl, leadColdListId);
      expect((leadNode!['callIds'] as string[])).toContain(callAliceColdListId);

      const aliceNode = await getGraphNode(app.engineUrl, agentAliceId);
      expect(aliceNode!['dailyCallCount']).toBe(2);
    }, 60_000);
  });

  // ---- Phase 5: Progress leads ----

  describe('Phase 5: Contact, qualify, and disqualify leads', () => {
    it('contact WEBSITE lead: graph status transitions NEW -> CONTACTED', async () => {
      await fwd(app.engineUrl, 'POST', `/leads/${leadWebsiteId}/contact`, {});

      const node = await getGraphNode(app.engineUrl, leadWebsiteId);
      expect(node!['status']).toBe('CONTACTED');
      expect(typeof node!['lastContactedAt']).toBe('string');
    }, 60_000);

    it('qualify WEBSITE lead: graph status transitions CONTACTED -> QUALIFIED', async () => {
      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadWebsiteId}/qualify`, {});
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, leadWebsiteId);
      expect(node!['status']).toBe('QUALIFIED');
    }, 60_000);

    it('contact REFERRAL lead: graph status transitions NEW -> CONTACTED', async () => {
      await fwd(app.engineUrl, 'POST', `/leads/${leadReferralId}/contact`, {});

      const node = await getGraphNode(app.engineUrl, leadReferralId);
      expect(node!['status']).toBe('CONTACTED');
    }, 60_000);

    it('qualify REFERRAL lead: graph status transitions CONTACTED -> QUALIFIED', async () => {
      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadReferralId}/qualify`, {});
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, leadReferralId);
      expect(node!['status']).toBe('QUALIFIED');
    }, 60_000);

    it('contact COLD_LIST lead: graph status transitions NEW -> CONTACTED', async () => {
      await fwd(app.engineUrl, 'POST', `/leads/${leadColdListId}/contact`, {});

      const node = await getGraphNode(app.engineUrl, leadColdListId);
      expect(node!['status']).toBe('CONTACTED');
    }, 60_000);

    it('disqualify COLD_LIST lead: graph status transitions CONTACTED -> DISQUALIFIED', async () => {
      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadColdListId}/disqualify`, {
        reason: 'No budget',
      });
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, leadColdListId);
      expect(node!['status']).toBe('DISQUALIFIED');

      // Verify the disqualification event payload
      const events = await getEventsByAggregate(app.engineUrl, leadColdListId);
      const dqEvent = events.find(e => e.type === 'LeadDisqualified');
      expect(dqEvent).toBeDefined();
      expect(dqEvent!.payload['reason']).toBe('No budget');
    }, 60_000);
  });

  // ---- Phase 6: Convert leads ----

  describe('Phase 6: Convert leads and verify saga creates opportunities', () => {
    it('convert WEBSITE lead: graph status becomes CONVERTED', async () => {
      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadWebsiteId}/convert`, {
        value: 75000,
        probability: 60,
      });
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, leadWebsiteId);
      expect(node!['status']).toBe('CONVERTED');
    }, 60_000);

    it('saga created opportunity for WEBSITE lead with stage=PROPOSED', async () => {
      const allEntities = await getAllEntities(app.engineUrl);
      const opportunities = Object.entries(allEntities).filter(
        ([, state]) => (state as JsonObject)['stage'] !== undefined && (state as JsonObject)['leadId'] === leadWebsiteId,
      );
      expect(opportunities.length).toBe(1);

      const [oppId, oppState] = opportunities[0];
      opportunityWebsiteId = oppId;

      expect((oppState as JsonObject)['stage']).toBe('PROPOSED');
      expect((oppState as JsonObject)['leadId']).toBe(leadWebsiteId);
      expect((oppState as JsonObject)['value']).toBe(75000);
      expect((oppState as JsonObject)['probability']).toBe(60);
    }, 60_000);

    it('convert REFERRAL lead: graph status becomes CONVERTED', async () => {
      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadReferralId}/convert`, {
        value: 120000,
        probability: 80,
      });
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, leadReferralId);
      expect(node!['status']).toBe('CONVERTED');
    }, 60_000);

    it('saga created opportunity for REFERRAL lead with stage=PROPOSED', async () => {
      const allEntities = await getAllEntities(app.engineUrl);
      const opportunities = Object.entries(allEntities).filter(
        ([, state]) => (state as JsonObject)['stage'] !== undefined && (state as JsonObject)['leadId'] === leadReferralId,
      );
      expect(opportunities.length).toBe(1);

      const [oppId, oppState] = opportunities[0];
      opportunityReferralId = oppId;

      expect((oppState as JsonObject)['stage']).toBe('PROPOSED');
      expect((oppState as JsonObject)['leadId']).toBe(leadReferralId);
      expect((oppState as JsonObject)['value']).toBe(120000);
      expect((oppState as JsonObject)['probability']).toBe(80);
    }, 60_000);

    it('OpportunityCreated events exist in the event stream', async () => {
      const websiteOppEvents = await getEventsByAggregate(app.engineUrl, opportunityWebsiteId);
      expect(websiteOppEvents.some(e => e.type === 'OpportunityCreated')).toBe(true);

      const referralOppEvents = await getEventsByAggregate(app.engineUrl, opportunityReferralId);
      expect(referralOppEvents.some(e => e.type === 'OpportunityCreated')).toBe(true);
    }, 60_000);
  });

  // ---- Phase 7: Close opportunities ----

  describe('Phase 7: Advance and close opportunities', () => {
    it('PATCH /opportunities/:id/advance moves WEBSITE opportunity to NEGOTIATING', async () => {
      const res = await fwd(app.engineUrl, 'PATCH', `/opportunities/${opportunityWebsiteId}/advance`, {
        probability: 75,
      });
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, opportunityWebsiteId);
      expect(node!['stage']).toBe('NEGOTIATING');
      expect(node!['probability']).toBe(75);
    }, 60_000);

    it('PATCH /opportunities/:id/close WON sets stage=WON', async () => {
      const res = await fwd(app.engineUrl, 'PATCH', `/opportunities/${opportunityWebsiteId}/close`, {
        outcome: 'WON',
      });
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, opportunityWebsiteId);
      expect(node!['stage']).toBe('WON');
      expect(typeof node!['closedAt']).toBe('string');
    }, 60_000);

    it('OpportunityWon event appears in the event stream', async () => {
      const events = await getEventsByAggregate(app.engineUrl, opportunityWebsiteId);
      const wonEvent = events.find(e => e.type === 'OpportunityWon');
      expect(wonEvent).toBeDefined();
      expect(wonEvent!.payload['closedAt']).toBeDefined();
    }, 60_000);

    it('PATCH /opportunities/:id/close LOST sets stage=LOST with closureReason', async () => {
      const res = await fwd(app.engineUrl, 'PATCH', `/opportunities/${opportunityReferralId}/close`, {
        outcome: 'LOST',
        closureReason: 'Competitor selected',
      });
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, opportunityReferralId);
      expect(node!['stage']).toBe('LOST');
      expect(node!['closureReason']).toBe('Competitor selected');
      expect(typeof node!['closedAt']).toBe('string');
    }, 60_000);

    it('OpportunityLost event appears in the event stream', async () => {
      const events = await getEventsByAggregate(app.engineUrl, opportunityReferralId);
      const lostEvent = events.find(e => e.type === 'OpportunityLost');
      expect(lostEvent).toBeDefined();
      expect(lostEvent!.payload['closureReason']).toBe('Competitor selected');
    }, 60_000);
  });

  // ---- Phase 8: Campaign lifecycle ----

  describe('Phase 8: Campaign pause, re-activate, and complete', () => {
    it('PATCH /campaigns/:id/pause transitions ACTIVE to PAUSED', async () => {
      const res = await fwd(app.engineUrl, 'PATCH', `/campaigns/${campaignId}/pause`, {});
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, campaignId);
      expect(node!['status']).toBe('PAUSED');
    }, 60_000);

    it('CampaignPaused event appears in the event stream', async () => {
      const events = await getEventsByAggregate(app.engineUrl, campaignId);
      const paused = events.find(e => e.type === 'CampaignPaused');
      expect(paused).toBeDefined();
      expect(paused!.payload['pausedAt']).toBeDefined();
    }, 60_000);

    it('PATCH /campaigns/:id/activate transitions PAUSED back to ACTIVE', async () => {
      const res = await fwd(app.engineUrl, 'PATCH', `/campaigns/${campaignId}/activate`, {});
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, campaignId);
      expect(node!['status']).toBe('ACTIVE');
    }, 60_000);

    it('PATCH /campaigns/:id/complete transitions ACTIVE to COMPLETED', async () => {
      const res = await fwd(app.engineUrl, 'PATCH', `/campaigns/${campaignId}/complete`, {});
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, campaignId);
      expect(node!['status']).toBe('COMPLETED');
    }, 60_000);

    it('CampaignCompleted event appears in the event stream', async () => {
      const events = await getEventsByAggregate(app.engineUrl, campaignId);
      const completed = events.find(e => e.type === 'CampaignCompleted');
      expect(completed).toBeDefined();
      expect(completed!.payload['completedAt']).toBeDefined();
    }, 60_000);
  });

  // ---- Phase 9: Agent status transitions ----

  describe('Phase 9: Agent status transitions', () => {
    it('PATCH /agents/:id/status ON_CALL sets currentStatus in graph', async () => {
      const res = await fwd(app.engineUrl, 'PATCH', `/agents/${agentAliceId}/status`, {
        currentStatus: 'ON_CALL',
      });
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, agentAliceId);
      expect(node!['currentStatus']).toBe('ON_CALL');
    }, 60_000);

    it('PATCH /agents/:id/status BREAK sets currentStatus in graph', async () => {
      const res = await fwd(app.engineUrl, 'PATCH', `/agents/${agentAliceId}/status`, {
        currentStatus: 'BREAK',
      });
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, agentAliceId);
      expect(node!['currentStatus']).toBe('BREAK');
    }, 60_000);

    it('PATCH /agents/:id/status AVAILABLE sets currentStatus in graph', async () => {
      const res = await fwd(app.engineUrl, 'PATCH', `/agents/${agentAliceId}/status`, {
        currentStatus: 'AVAILABLE',
      });
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, agentAliceId);
      expect(node!['currentStatus']).toBe('AVAILABLE');
    }, 60_000);

    it('PATCH /agents/:id/status OFFLINE sets currentStatus in graph', async () => {
      const res = await fwd(app.engineUrl, 'PATCH', `/agents/${agentAliceId}/status`, {
        currentStatus: 'OFFLINE',
      });
      expect(res.status).toBe(200);

      const node = await getGraphNode(app.engineUrl, agentAliceId);
      expect(node!['currentStatus']).toBe('OFFLINE');
      expect(typeof node!['lastActiveAt']).toBe('string');
    }, 60_000);

    it('AgentStatusChanged events track all transitions', async () => {
      const events = await getEventsByAggregate(app.engineUrl, agentAliceId);
      const statusEvents = events.filter(e => e.type === 'AgentStatusChanged');
      // ON_CALL, BREAK, AVAILABLE, OFFLINE = 4 transitions
      expect(statusEvents.length).toBe(4);

      const statuses = statusEvents.map(e => e.payload['newStatus']);
      expect(statuses).toEqual(['ON_CALL', 'BREAK', 'AVAILABLE', 'OFFLINE']);
    }, 60_000);
  });

  // ---- Phase 10: Final graph verification ----

  describe('Phase 10: Final graph verification -- terminal states + causal chain', () => {
    it('campaign graph node is in terminal COMPLETED state', async () => {
      const node = await getGraphNode(app.engineUrl, campaignId);
      expect(node!['status']).toBe('COMPLETED');
      expect(node!['name']).toBe('Multi-Agent Outbound Q3');
    }, 60_000);

    it('WEBSITE lead is CONVERTED, REFERRAL lead is CONVERTED, COLD_LIST lead is DISQUALIFIED', async () => {
      const website = await getGraphNode(app.engineUrl, leadWebsiteId);
      expect(website!['status']).toBe('CONVERTED');

      const referral = await getGraphNode(app.engineUrl, leadReferralId);
      expect(referral!['status']).toBe('CONVERTED');

      const coldList = await getGraphNode(app.engineUrl, leadColdListId);
      expect(coldList!['status']).toBe('DISQUALIFIED');
    }, 60_000);

    it('WEBSITE opportunity is WON, REFERRAL opportunity is LOST', async () => {
      const won = await getGraphNode(app.engineUrl, opportunityWebsiteId);
      expect(won!['stage']).toBe('WON');
      expect(won!['value']).toBe(75000);

      const lost = await getGraphNode(app.engineUrl, opportunityReferralId);
      expect(lost!['stage']).toBe('LOST');
      expect(lost!['closureReason']).toBe('Competitor selected');
    }, 60_000);

    it('Alice is OFFLINE, Bob remains AVAILABLE', async () => {
      const alice = await getGraphNode(app.engineUrl, agentAliceId);
      expect(alice!['currentStatus']).toBe('OFFLINE');
      expect(alice!['dailyCallCount']).toBe(2);

      const bob = await getGraphNode(app.engineUrl, agentBobId);
      expect(bob!['currentStatus']).toBe('AVAILABLE');
      expect(bob!['dailyCallCount']).toBe(1);
    }, 60_000);

    it('event counts per aggregate verify the full causal chain', async () => {
      // Campaign: CampaignCreated + CampaignActivated + CampaignPaused + CampaignActivated + CampaignCompleted = 5
      const campaignEvents = await getEventsByAggregate(app.engineUrl, campaignId);
      expect(campaignEvents.length).toBe(5);
      const campaignTypes = campaignEvents.map(e => e.type);
      expect(campaignTypes).toEqual([
        'CampaignCreated',
        'CampaignActivated',
        'CampaignPaused',
        'CampaignActivated',
        'CampaignCompleted',
      ]);

      // Agent Alice: AgentCreated + 2x AgentCallCountIncremented + 4x AgentStatusChanged = 7
      const aliceEvents = await getEventsByAggregate(app.engineUrl, agentAliceId);
      expect(aliceEvents.length).toBe(7);
      expect(aliceEvents[0].type).toBe('AgentCreated');
      expect(aliceEvents.filter(e => e.type === 'AgentCallCountIncremented').length).toBe(2);
      expect(aliceEvents.filter(e => e.type === 'AgentStatusChanged').length).toBe(4);

      // Agent Bob: AgentCreated + 1x AgentCallCountIncremented = 2
      const bobEvents = await getEventsByAggregate(app.engineUrl, agentBobId);
      expect(bobEvents.length).toBe(2);
      expect(bobEvents[0].type).toBe('AgentCreated');
      expect(bobEvents[1].type).toBe('AgentCallCountIncremented');

      // WEBSITE lead: LeadCreated + CallIdAppended + LeadContacted + LeadQualified + LeadConverted = 5
      const websiteLeadEvents = await getEventsByAggregate(app.engineUrl, leadWebsiteId);
      expect(websiteLeadEvents.length).toBe(5);
      expect(websiteLeadEvents.map(e => e.type)).toEqual([
        'LeadCreated',
        'CallIdAppended',
        'LeadContacted',
        'LeadQualified',
        'LeadConverted',
      ]);

      // REFERRAL lead: LeadCreated + CallIdAppended + LeadContacted + LeadQualified + LeadConverted = 5
      const referralLeadEvents = await getEventsByAggregate(app.engineUrl, leadReferralId);
      expect(referralLeadEvents.length).toBe(5);
      expect(referralLeadEvents.map(e => e.type)).toEqual([
        'LeadCreated',
        'CallIdAppended',
        'LeadContacted',
        'LeadQualified',
        'LeadConverted',
      ]);

      // COLD_LIST lead: LeadCreated + CallIdAppended + LeadContacted + LeadDisqualified = 4
      const coldListLeadEvents = await getEventsByAggregate(app.engineUrl, leadColdListId);
      expect(coldListLeadEvents.length).toBe(4);
      expect(coldListLeadEvents.map(e => e.type)).toEqual([
        'LeadCreated',
        'CallIdAppended',
        'LeadContacted',
        'LeadDisqualified',
      ]);

      // WEBSITE opportunity: OpportunityCreated + OpportunityAdvanced + OpportunityWon = 3
      const websiteOppEvents = await getEventsByAggregate(app.engineUrl, opportunityWebsiteId);
      expect(websiteOppEvents.length).toBe(3);
      expect(websiteOppEvents.map(e => e.type)).toEqual([
        'OpportunityCreated',
        'OpportunityAdvanced',
        'OpportunityWon',
      ]);

      // REFERRAL opportunity: OpportunityCreated + OpportunityLost = 2
      const referralOppEvents = await getEventsByAggregate(app.engineUrl, opportunityReferralId);
      expect(referralOppEvents.length).toBe(2);
      expect(referralOppEvents.map(e => e.type)).toEqual([
        'OpportunityCreated',
        'OpportunityLost',
      ]);
    }, 60_000);

    it('all events have monotonically increasing sequenceVersions per aggregate', async () => {
      const aggregateIds = [
        campaignId,
        agentAliceId,
        agentBobId,
        leadWebsiteId,
        leadReferralId,
        leadColdListId,
        opportunityWebsiteId,
        opportunityReferralId,
      ];

      for (const aggId of aggregateIds) {
        const events = await getEventsByAggregate(app.engineUrl, aggId);
        for (let i = 1; i < events.length; i++) {
          expect(events[i].sequenceVersion).toBeGreaterThan(events[i - 1].sequenceVersion);
        }
      }
    }, 60_000);
  });
});
