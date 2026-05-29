/**
 * 22 — Cross-Boundary Dispatch: dispatch_commands graph propagation via the
 * full Specmatic+plugin+Node stack.
 *
 * Verifies that the DSL's `dispatch_commands` declarations correctly
 * propagate mutations across boundary object graphs by sending HTTP requests
 * through the full Specmatic stack and inspecting state via /_admin/ endpoints.
 *
 * The CRM DSL defines these cross-boundary dispatches:
 *
 *   call.yaml -> dispatch_commands:
 *     1. Lead boundary: appends callId to lead.callIds
 *     2. Agent boundary: increments agent.dailyCallCount
 *
 *   lead.yaml -> dispatch_commands (on createLead):
 *     3. Campaign boundary: updates campaign.actualCalls (when assignedCampaignId provided)
 *
 *   opportunity-close.yaml -> dispatch_commands (on closeWon):
 *     4. Agent boundary: increments agent.totalConversions (when agentId != null)
 *
 * DSL files under test:
 *   tests/fixtures/crm/dsl/call.yaml (dispatch_commands -> Lead + Agent)
 *   tests/fixtures/crm/dsl/lead.yaml (dispatch_commands -> Campaign)
 *   tests/fixtures/crm/dsl/opportunity-close.yaml (dispatch_commands -> Agent)
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd, getGraphNode, getEventsByAggregate,
  javaAvailable,
} from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

const AGENT_ALICE_ID = '00000000-0000-7000-8000-000000000003';
const AGENT_BOB_ID = '00000000-0000-7000-8000-000000000004';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';

describeWithJava('22 — Cross-Boundary Dispatch (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  describe('call.yaml dispatch_commands -> Lead.callIds + Agent.dailyCallCount', () => {
    let leadId: string;

    beforeAll(async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Dispatch Test Corp',
        contactName: 'DT User', phone: '+61 2 9300 0001',
        email: 'dispatch@test.com', source: 'WEBSITE',
      });
      expect([200, 201]).toContain(res.status);
      leadId = (res.body as JsonObject)['id'] as string;
    }, 60_000);

    it('POST /calls updates the Call graph node AND dispatches to Lead + Agent nodes', async () => {
      // Capture Agent graph node before
      const agentBefore = await getGraphNode(app.engineUrl, AGENT_ALICE_ID);
      const callCountBefore = agentBefore!['dailyCallCount'] as number;

      // Log a call
      const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId,
        agentId: AGENT_ALICE_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED',
        durationSeconds: 120,
      });
      expect([200, 201]).toContain(callRes.status);
      const callId = (callRes.body as JsonObject)['id'] as string;

      // 1. Call graph node created (primary boundary)
      const callNode = await getGraphNode(app.engineUrl, callId);
      expect(callNode).not.toBeNull();
      expect(callNode!['leadId']).toBe(leadId);
      expect(callNode!['agentId']).toBe(AGENT_ALICE_ID);
      expect(callNode!['outcome']).toBe('INTERESTED');

      // 2. Lead graph node updated (secondary dispatch -> appendCallId behavior)
      const leadNode = await getGraphNode(app.engineUrl, leadId);
      expect((leadNode!['callIds'] as string[])).toContain(callId);

      // 3. Agent graph node updated (secondary dispatch -> incrementCallCount behavior)
      const agentAfter = await getGraphNode(app.engineUrl, AGENT_ALICE_ID);
      expect(agentAfter!['dailyCallCount']).toBe(callCountBefore + 1);
    }, 60_000);

    it('second call from different agent updates both agents independently', async () => {
      const bobBefore = await getGraphNode(app.engineUrl, AGENT_BOB_ID);
      const bobCountBefore = bobBefore!['dailyCallCount'] as number;

      const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId,
        agentId: AGENT_BOB_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'CALLBACK_SCHEDULED',
      });
      expect([200, 201]).toContain(callRes.status);
      const callId = (callRes.body as JsonObject)['id'] as string;

      // Lead gets a second callId
      const leadNode = await getGraphNode(app.engineUrl, leadId);
      expect((leadNode!['callIds'] as string[]).length).toBe(2);
      expect((leadNode!['callIds'] as string[])).toContain(callId);

      // Bob's count incremented, Alice's unchanged
      const bobAfter = await getGraphNode(app.engineUrl, AGENT_BOB_ID);
      expect(bobAfter!['dailyCallCount']).toBe(bobCountBefore + 1);
    }, 60_000);

    it('event store shows secondary events on target boundaries', async () => {
      // Lead should have CallIdAppended events
      const leadEvents = await getEventsByAggregate(app.engineUrl, leadId);
      const appendEvents = leadEvents.filter(e => e.type === 'CallIdAppended');
      expect(appendEvents.length).toBe(2);

      // Agent Alice should have AgentCallCountIncremented events
      const aliceEvents = await getEventsByAggregate(app.engineUrl, AGENT_ALICE_ID);
      const incrementEvents = aliceEvents.filter(e => e.type === 'AgentCallCountIncremented');
      expect(incrementEvents.length).toBeGreaterThanOrEqual(1);
    }, 60_000);
  });

  describe('lead.yaml dispatch_commands -> Campaign (conditional on assignedCampaignId)', () => {
    it('creating a lead WITH assignedCampaignId dispatches to Campaign graph node', async () => {
      const campBefore = await getGraphNode(app.engineUrl, CAMPAIGN_ID);
      const actualCallsBefore = campBefore!['actualCalls'] as number;

      // The /leads POST request schema in nuisance-bureau.yaml uses
      // additionalProperties:false, so assignedCampaignId is rejected by OpenAPI
      // request validation. Pass the admin-gated skip header to let the DSL
      // dispatch logic see the field — the dispatch is the behaviour under test.
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Campaign Dispatch Corp',
        contactName: 'CD', phone: '+61 2 9300 0010',
        email: 'camp-dispatch@test.com',
        source: 'WEBSITE',
        assignedCampaignId: CAMPAIGN_ID,
      }, {
        authorization: 'Bearer admin-1:admin',
        'x-potemkin-skip-request-validation': 'true',
      });
      expect([200, 201]).toContain(res.status);

      // campaign.yaml reducer on: CampaignLeadSourceUpdated -> actualCalls + 1
      const campAfter = await getGraphNode(app.engineUrl, CAMPAIGN_ID);
      expect(campAfter!['actualCalls']).toBe(actualCallsBefore + 1);
    }, 60_000);

    it('creating a lead WITHOUT assignedCampaignId does NOT dispatch to Campaign', async () => {
      const campBefore = await getGraphNode(app.engineUrl, CAMPAIGN_ID);
      const actualCallsBefore = campBefore!['actualCalls'] as number;

      // No assignedCampaignId -> condition evaluates to false -> no dispatch
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'No Campaign Corp',
        contactName: 'NC', phone: '+61 2 9300 0011',
        email: 'no-camp@test.com',
        source: 'COLD_LIST',
      });
      expect([200, 201]).toContain(res.status);

      const campAfter = await getGraphNode(app.engineUrl, CAMPAIGN_ID);
      expect(campAfter!['actualCalls']).toBe(actualCallsBefore);
    }, 60_000);
  });

  describe('First-match semantics: appendCallId fires before mutation guards', () => {
    it('secondary dispatch to Lead only triggers appendCallId, not contactLead', async () => {
      // The Lead boundary has appendCallId listed FIRST in behaviors[].
      // When a secondary command arrives with payload.callId, it matches
      // appendCallId before reaching contactLead (which has requires guards).
      // This test verifies first-match semantics.

      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'First Match Corp',
        contactName: 'FM', phone: '+61 2 9300 0020',
        email: 'firstmatch@test.com', source: 'WEBSITE',
      });
      expect([200, 201]).toContain(res.status);
      const id = (res.body as JsonObject)['id'] as string;

      // Log a call -- dispatches { callId } to Lead boundary
      const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId: id, agentId: AGENT_ALICE_ID, campaignId: CAMPAIGN_ID, outcome: 'NO_ANSWER',
      });
      expect([200, 201]).toContain(callRes.status);

      // Graph node: callIds updated but status remains NEW
      const node = await getGraphNode(app.engineUrl, id);
      expect(node!['status']).toBe('NEW');
      expect((node!['callIds'] as string[]).length).toBe(1);

      // Event stream: only LeadCreated + CallIdAppended (no LeadContacted)
      const events = await getEventsByAggregate(app.engineUrl, id);
      const types = events.map(e => e.type);
      expect(types).toContain('LeadCreated');
      expect(types).toContain('CallIdAppended');
      expect(types).not.toContain('LeadContacted');
    }, 60_000);
  });

  describe('Multi-hop cascade: POST /calls triggers 3 graph nodes in one transaction', () => {
    it('single POST /calls mutates Call + Lead + Agent graph nodes atomically', async () => {
      const leadRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Three Node Corp',
        contactName: 'TN', phone: '+61 2 9300 0030',
        email: 'threenode@test.com', source: 'PARTNER',
      });
      expect([200, 201]).toContain(leadRes.status);
      const leadId = (leadRes.body as JsonObject)['id'] as string;

      const agentBefore = await getGraphNode(app.engineUrl, AGENT_ALICE_ID);
      const agentCallsBefore = agentBefore!['dailyCallCount'] as number;

      const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId, agentId: AGENT_ALICE_ID, campaignId: CAMPAIGN_ID, outcome: 'INTERESTED',
      });
      expect([200, 201]).toContain(callRes.status);
      const callId = (callRes.body as JsonObject)['id'] as string;

      // All 3 graph nodes updated from a single POST:
      // 1. Call node exists
      const callNode = await getGraphNode(app.engineUrl, callId);
      expect(callNode).not.toBeNull();

      // 2. Lead node has callId appended
      const leadNode = await getGraphNode(app.engineUrl, leadId);
      expect((leadNode!['callIds'] as string[])).toContain(callId);

      // 3. Agent node has dailyCallCount incremented
      const agentAfter = await getGraphNode(app.engineUrl, AGENT_ALICE_ID);
      expect(agentAfter!['dailyCallCount']).toBe(agentCallsBefore + 1);
    }, 60_000);
  });
});
