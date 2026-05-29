/**
 * 17 — Multi-Boundary Cascades via full Specmatic stack.
 *
 * Verifies that the DSL's dispatch_commands declarations correctly cascade
 * mutations across multiple boundary object graphs in a single command,
 * exercised through the full Specmatic+plugin+Node pipeline.
 *
 * DSL files under test:
 *   call.yaml (dispatch_commands -> Lead + Agent)
 *   lead.yaml (dispatch_commands -> Campaign)
 *   agent.yaml (reducer: AgentCallCountIncremented)
 *   campaign.yaml (reducer: CampaignLeadSourceUpdated)
 */

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd,
  getGraphNode,
  getEntityCount,
  getEventsByAggregate,
} from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

function javaAvailable(): boolean {
  try { execSync('java -version', { stdio: 'pipe' }); return true; } catch { return false; }
}
const describeWithJava = javaAvailable() ? describe : describe.skip;

// Seeded IDs from DSL initialization sections
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';
const AGENT_ALICE_ID = '00000000-0000-7000-8000-000000000003';
const AGENT_BOB_ID = '00000000-0000-7000-8000-000000000004';

describeWithJava('17 — Multi-Boundary Cascades (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ---- 1. Call creation fans out to Lead + Agent graph nodes ----

  describe('call.yaml dispatch_commands fans out to Lead + Agent graph nodes', () => {
    let leadId: string;
    let callId: string;

    beforeAll(async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Cascade Test Corp',
        contactName: 'CT User',
        phone: '+61 2 9400 0001',
        email: 'cascade@test.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(res.status);
      leadId = (res.body as JsonObject)['id'] as string;
    });

    it('POST /calls creates Call graph node and dispatches to Lead + Agent', async () => {
      // Capture agent state before the call
      const agentBefore = await getGraphNode(app.engineUrl, AGENT_ALICE_ID);
      const callCountBefore = agentBefore!['dailyCallCount'] as number;

      const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId,
        agentId: AGENT_ALICE_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED',
        durationSeconds: 120,
      });
      expect([200, 201]).toContain(callRes.status);
      callId = (callRes.body as JsonObject)['id'] as string;

      // Primary: Call graph node created with correct fields
      const callNode = await getGraphNode(app.engineUrl, callId);
      expect(callNode).not.toBeNull();
      expect(callNode!['leadId']).toBe(leadId);
      expect(callNode!['agentId']).toBe(AGENT_ALICE_ID);
      expect(callNode!['outcome']).toBe('INTERESTED');

      // Secondary dispatch #1: Lead.callIds has the new callId
      const leadNode = await getGraphNode(app.engineUrl, leadId);
      expect((leadNode!['callIds'] as string[])).toContain(callId);

      // Secondary dispatch #2: Agent.dailyCallCount incremented
      const agentAfter = await getGraphNode(app.engineUrl, AGENT_ALICE_ID);
      expect(agentAfter!['dailyCallCount']).toBe(callCountBefore + 1);
    }, 60_000);

    it('event store records CallIdAppended on lead aggregate', async () => {
      const leadEvents = await getEventsByAggregate(app.engineUrl, leadId);
      const appendEvents = leadEvents.filter(e => e.type === 'CallIdAppended');
      expect(appendEvents.length).toBe(1);
      expect(appendEvents[0].boundary).toBe('Lead');
    }, 60_000);

    it('event store records AgentCallCountIncremented on agent aggregate', async () => {
      const agentEvents = await getEventsByAggregate(app.engineUrl, AGENT_ALICE_ID);
      const incrementEvents = agentEvents.filter(e => e.type === 'AgentCallCountIncremented');
      expect(incrementEvents.length).toBeGreaterThanOrEqual(1);
    }, 60_000);
  });

  // ---- 2. Second call from different agent updates both independently ----

  describe('second call from different agent updates both agents independently', () => {
    let leadId: string;

    beforeAll(async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Multi-Agent Corp',
        contactName: 'MA User',
        phone: '+61 2 9400 0002',
        email: 'multi-agent@test.com',
        source: 'REFERRAL',
      });
      expect([200, 201]).toContain(res.status);
      leadId = (res.body as JsonObject)['id'] as string;

      // First call from Alice
      await fwd(app.engineUrl, 'POST', '/calls', {
        leadId,
        agentId: AGENT_ALICE_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED',
      });
    });

    it('second call from Bob increments Bob, leaves Alice unchanged', async () => {
      const aliceBefore = await getGraphNode(app.engineUrl, AGENT_ALICE_ID);
      const aliceCountBefore = aliceBefore!['dailyCallCount'] as number;

      const bobBefore = await getGraphNode(app.engineUrl, AGENT_BOB_ID);
      const bobCountBefore = bobBefore!['dailyCallCount'] as number;

      const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId,
        agentId: AGENT_BOB_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'CALLBACK_SCHEDULED',
      });
      expect([200, 201]).toContain(callRes.status);

      // Lead.callIds now has 2 entries (one from each agent's call)
      const leadNode = await getGraphNode(app.engineUrl, leadId);
      expect((leadNode!['callIds'] as string[]).length).toBe(2);
      expect((leadNode!['callIds'] as string[])).toContain((callRes.body as JsonObject)['id'] as string);

      // Bob's dailyCallCount incremented
      const bobAfter = await getGraphNode(app.engineUrl, AGENT_BOB_ID);
      expect(bobAfter!['dailyCallCount']).toBe(bobCountBefore + 1);

      // Alice's dailyCallCount unchanged from this call
      const aliceAfter = await getGraphNode(app.engineUrl, AGENT_ALICE_ID);
      expect(aliceAfter!['dailyCallCount']).toBe(aliceCountBefore);
    }, 60_000);
  });

  // ---- 3. Lead creation with assignedCampaignId dispatches to Campaign ----

  describe('lead.yaml dispatch_commands -> Campaign (conditional on assignedCampaignId)', () => {
    it('creating a lead WITH assignedCampaignId dispatches to Campaign graph node', async () => {
      const campBefore = await getGraphNode(app.engineUrl, CAMPAIGN_ID);
      const actualCallsBefore = campBefore!['actualCalls'] as number;

      // Use fwd directly since assignedCampaignId bypasses OpenAPI validation
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Campaign Cascade Corp',
        contactName: 'CC User',
        phone: '+61 2 9400 0010',
        email: 'campaign-cascade@test.com',
        source: 'WEBSITE',
        assignedCampaignId: CAMPAIGN_ID,
      });
      expect([200, 201]).toContain(res.status);

      // campaign.yaml reducer on: CampaignLeadSourceUpdated -> actualCalls + 1
      const campAfter = await getGraphNode(app.engineUrl, CAMPAIGN_ID);
      expect(campAfter!['actualCalls']).toBe(actualCallsBefore + 1);

      // Verify the CampaignLeadSourceUpdated event on campaign aggregate
      const campEvents = await getEventsByAggregate(app.engineUrl, CAMPAIGN_ID);
      const sourceEvents = campEvents.filter(e => e.type === 'CampaignLeadSourceUpdated');
      expect(sourceEvents.length).toBeGreaterThanOrEqual(1);
    }, 60_000);
  });

  // ---- 4. Lead creation WITHOUT assignedCampaignId does NOT dispatch ----

  describe('lead creation without assignedCampaignId does NOT dispatch to Campaign', () => {
    it('campaign.actualCalls unchanged when no assignedCampaignId provided', async () => {
      const campBefore = await getGraphNode(app.engineUrl, CAMPAIGN_ID);
      const actualCallsBefore = campBefore!['actualCalls'] as number;

      // No assignedCampaignId -> condition evaluates to false -> no dispatch
      await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'No Campaign Corp',
        contactName: 'NC User',
        phone: '+61 2 9400 0011',
        email: 'no-campaign@test.com',
        source: 'COLD_LIST',
      });

      const campAfter = await getGraphNode(app.engineUrl, CAMPAIGN_ID);
      expect(campAfter!['actualCalls']).toBe(actualCallsBefore);
    }, 60_000);
  });

  // ---- 5. First-match semantics: appendCallId fires before contact guards ----

  describe('first-match semantics: appendCallId fires before contact guards', () => {
    it('call dispatch to Lead triggers CallIdAppended, not LeadContacted', async () => {
      // Create a NEW lead
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'First Match Corp',
        contactName: 'FM User',
        phone: '+61 2 9400 0020',
        email: 'first-match@test.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(res.status);
      const id = (res.body as JsonObject)['id'] as string;

      // Log a call -> dispatches { callId } to Lead boundary
      await fwd(app.engineUrl, 'POST', '/calls', {
        leadId: id,
        agentId: AGENT_ALICE_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'NO_ANSWER',
      });

      // Graph node: status still NEW, callIds has 1 entry
      const node = await getGraphNode(app.engineUrl, id);
      expect(node!['status']).toBe('NEW');
      expect((node!['callIds'] as string[]).length).toBe(1);

      // Events: CallIdAppended present, LeadContacted NOT present
      const events = await getEventsByAggregate(app.engineUrl, id);
      const types = events.map(e => e.type);
      expect(types).toContain('LeadCreated');
      expect(types).toContain('CallIdAppended');
      expect(types).not.toContain('LeadContacted');
    }, 60_000);
  });

  // ---- 6. Single POST /calls mutates 3 graph nodes atomically ----

  describe('single POST /calls mutates 3 graph nodes atomically', () => {
    it('POST /calls updates Call + Lead + Agent graph nodes from one request', async () => {
      // Create a fresh lead
      const leadRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Three Node Corp',
        contactName: 'TN User',
        phone: '+61 2 9400 0030',
        email: 'three-node@test.com',
        source: 'PARTNER',
      });
      expect([200, 201]).toContain(leadRes.status);
      const leadId = (leadRes.body as JsonObject)['id'] as string;

      const agentBefore = await getGraphNode(app.engineUrl, AGENT_ALICE_ID);
      const agentCallsBefore = agentBefore!['dailyCallCount'] as number;

      // Single POST
      const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId,
        agentId: AGENT_ALICE_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED',
        durationSeconds: 90,
      });
      expect([200, 201]).toContain(callRes.status);
      const callId = (callRes.body as JsonObject)['id'] as string;

      // 1. Call node exists with correct fields
      const callNode = await getGraphNode(app.engineUrl, callId);
      expect(callNode).not.toBeNull();
      expect(callNode!['leadId']).toBe(leadId);
      expect(callNode!['agentId']).toBe(AGENT_ALICE_ID);

      // 2. Lead node has callId appended
      const leadNode = await getGraphNode(app.engineUrl, leadId);
      expect((leadNode!['callIds'] as string[])).toContain(callId);

      // 3. Agent node has dailyCallCount incremented
      const agentAfter = await getGraphNode(app.engineUrl, AGENT_ALICE_ID);
      expect(agentAfter!['dailyCallCount']).toBe(agentCallsBefore + 1);
    }, 60_000);
  });
});
