/**
 * 16 — Initialization and Query Mapping via full Specmatic stack.
 *
 * Verifies that the DSL's initialization section seeds the object graph,
 * query_mapping declarations filter collections, and identity.creation.generate
 * produces unique IDs — all exercised through the full Specmatic+plugin+Node pipeline.
 *
 * DSL files under test:
 *   lead.yaml, campaign.yaml, agent.yaml, call.yaml
 */

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd,
  getGraphNode,
  getEntityCount,
  getAllEvents,
} from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

function javaAvailable(): boolean {
  try { execSync('java -version', { stdio: 'pipe' }); return true; } catch { return false; }
}
const describeWithJava = javaAvailable() ? describe : describe.skip;

describeWithJava('16 — Initialization and Query Mapping (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ---- DSL initialization section -> object graph seeding ----

  describe('DSL initialization seeds the object graph on boot', () => {
    it('lead.yaml initialization seeds 5 leads with exact field values', async () => {
      const leads = [
        { id: '00000000-0000-7000-8000-000000000010', companyName: 'Apex Solutions Ltd', status: 'NEW', source: 'WEBSITE', score: 50 },
        { id: '00000000-0000-7000-8000-000000000011', companyName: 'BlueSky Tech', status: 'CONTACTED', source: 'REFERRAL', score: 80 },
        { id: '00000000-0000-7000-8000-000000000012', companyName: 'Cornerstone Corp', status: 'QUALIFIED', source: 'COLD_LIST', score: 20 },
        { id: '00000000-0000-7000-8000-000000000013', companyName: 'Delta Dynamics', status: 'DISQUALIFIED', source: 'PARTNER', score: 70 },
        { id: '00000000-0000-7000-8000-000000000014', companyName: 'Echo Enterprises', status: 'NEW', source: 'WEBSITE', score: 50 },
      ];

      for (const expected of leads) {
        const node = await getGraphNode(app.engineUrl, expected.id);
        expect(node).not.toBeNull();
        expect(node!['companyName']).toBe(expected.companyName);
        expect(node!['status']).toBe(expected.status);
        expect(node!['source']).toBe(expected.source);
        expect(node!['score']).toBe(expected.score);
        expect(node!['callIds']).toBeDefined();
        expect(node!['notes']).toBeDefined();
      }
    }, 60_000);

    it('campaign.yaml initialization seeds 2 campaigns', async () => {
      const campaigns = [
        { id: '00000000-0000-7000-8000-000000000001', name: 'Q1 Website Leads', status: 'ACTIVE', targetCalls: 500 },
        { id: '00000000-0000-7000-8000-000000000002', name: 'Partner Referral Drive', status: 'DRAFT', targetCalls: 200 },
      ];

      for (const expected of campaigns) {
        const node = await getGraphNode(app.engineUrl, expected.id);
        expect(node).not.toBeNull();
        expect(node!['name']).toBe(expected.name);
        expect(node!['status']).toBe(expected.status);
        expect(node!['targetCalls']).toBe(expected.targetCalls);
        expect(node!['actualCalls']).toBe(0);
        expect(node!['assignedAgentIds']).toEqual([]);
      }
    }, 60_000);

    it('agent.yaml initialization seeds 3 agents with skills arrays', async () => {
      const agents = [
        { id: '00000000-0000-7000-8000-000000000003', name: 'Alice Thompson', currentStatus: 'AVAILABLE', skills: ['B2B', 'SaaS'], dailyCallQuota: 40 },
        { id: '00000000-0000-7000-8000-000000000004', name: 'Bob Martinez', currentStatus: 'AVAILABLE', skills: ['Enterprise', 'Finance'], dailyCallQuota: 35 },
        { id: '00000000-0000-7000-8000-000000000005', name: 'Carla Nguyen', currentStatus: 'OFFLINE', skills: ['SMB', 'Retail'], dailyCallQuota: 50 },
      ];

      for (const expected of agents) {
        const node = await getGraphNode(app.engineUrl, expected.id);
        expect(node).not.toBeNull();
        expect(node!['name']).toBe(expected.name);
        expect(node!['currentStatus']).toBe(expected.currentStatus);
        expect(node!['skills']).toEqual(expected.skills);
        expect(node!['dailyCallQuota']).toBe(expected.dailyCallQuota);
        expect(node!['dailyCallCount']).toBe(0);
      }
    }, 60_000);

    it('total graph size matches seeded entity count', async () => {
      // 5 leads + 2 campaigns + 3 agents = 10 entities
      const count = await getEntityCount(app.engineUrl);
      expect(count).toBe(10);
    }, 60_000);

    it('event store has baseline events for all seeded entities', async () => {
      const allEvents = await getAllEvents(app.engineUrl);
      // Each seeded entity produces 1 creation event at boot
      expect(allEvents.length).toBe(10);
    }, 60_000);
  });

  // ---- DSL query_mapping -> collection filtering ----

  describe('DSL query_mapping filters collections via GET with query params', () => {
    it('lead.yaml query_mapping status filters correctly', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'NEW' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as JsonObject[]).length).toBe(2); // Apex + Echo
      for (const lead of res.body as JsonObject[]) {
        expect(lead['status']).toBe('NEW');
      }
    }, 60_000);

    it('query_mapping returns single result for unique status values', async () => {
      const contacted = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'CONTACTED' });
      expect(contacted.status).toBe(200);
      expect((contacted.body as JsonObject[]).length).toBe(1);
      expect((contacted.body as JsonObject[])[0]['companyName']).toBe('BlueSky Tech');

      const qualified = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'QUALIFIED' });
      expect(qualified.status).toBe(200);
      expect((qualified.body as JsonObject[]).length).toBe(1);
      expect((qualified.body as JsonObject[])[0]['companyName']).toBe('Cornerstone Corp');
    }, 60_000);

    it('campaign.yaml query_mapping status filters campaigns by status', async () => {
      const active = await fwd(app.engineUrl, 'GET', '/campaigns', null, {}, { status: 'ACTIVE' });
      expect(active.status).toBe(200);
      expect((active.body as JsonObject[]).length).toBe(1);
      expect((active.body as JsonObject[])[0]['name']).toBe('Q1 Website Leads');

      const draft = await fwd(app.engineUrl, 'GET', '/campaigns', null, {}, { status: 'DRAFT' });
      expect(draft.status).toBe(200);
      expect((draft.body as JsonObject[]).length).toBe(1);
      expect((draft.body as JsonObject[])[0]['name']).toBe('Partner Referral Drive');
    }, 60_000);

    it('agent.yaml query_mapping currentStatus filters agents', async () => {
      const available = await fwd(app.engineUrl, 'GET', '/agents', null, {}, { currentStatus: 'AVAILABLE' });
      expect(available.status).toBe(200);
      expect((available.body as JsonObject[]).length).toBe(2); // Alice + Bob
      for (const agent of available.body as JsonObject[]) {
        expect(agent['currentStatus']).toBe('AVAILABLE');
      }

      const offline = await fwd(app.engineUrl, 'GET', '/agents', null, {}, { currentStatus: 'OFFLINE' });
      expect(offline.status).toBe(200);
      expect((offline.body as JsonObject[]).length).toBe(1); // Carla
      expect((offline.body as JsonObject[])[0]['name']).toBe('Carla Nguyen');
    }, 60_000);

    it('query_mapping with no matches returns empty array (not 404)', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'DNC' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    }, 60_000);

    it('unfiltered GET returns all entities in the boundary', async () => {
      const leads = await fwd(app.engineUrl, 'GET', '/leads');
      expect(leads.status).toBe(200);
      expect((leads.body as unknown[]).length).toBe(5);

      const campaigns = await fwd(app.engineUrl, 'GET', '/campaigns');
      expect(campaigns.status).toBe(200);
      expect((campaigns.body as unknown[]).length).toBe(2);

      const agents = await fwd(app.engineUrl, 'GET', '/agents');
      expect(agents.status).toBe(200);
      expect((agents.body as unknown[]).length).toBe(3);
    }, 60_000);
  });

  // ---- DSL identity.creation.generate -> unique ID assignment ----

  describe('DSL identity.creation.generate assigns unique IDs', () => {
    it('each created entity gets a unique UUIDv7 ID', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await fwd(app.engineUrl, 'POST', '/leads', {
          companyName: `ID Test ${i}`,
          contactName: `IDT${i}`, phone: `+61 2 0000 ${i}`,
          email: `idt${i}@test.com`, source: 'WEBSITE',
        });
        expect([200, 201]).toContain(res.status);
        ids.push((res.body as JsonObject)['id'] as string);
      }

      // All IDs must be unique strings
      const unique = new Set(ids);
      expect(unique.size).toBe(3);

      // Each ID must exist in the graph
      for (const id of ids) {
        expect(await getGraphNode(app.engineUrl, id)).not.toBeNull();
      }
    }, 60_000);

    it('created entity ID matches what is stored in the graph node', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/agents', {
        name: 'Identity Test Agent',
        email: 'identity@test.com',
        dailyCallQuota: 25,
        skills: ['Testing'],
      });
      expect([200, 201]).toContain(res.status);
      const id = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, id);
      expect(node!['id']).toBe(id);
      expect(node!['name']).toBe('Identity Test Agent');
    }, 60_000);
  });

  // ---- Query mapping updates after mutations ----

  describe('query_mapping reflects graph state after mutations', () => {
    it('contacting a NEW lead moves it from status=NEW to status=CONTACTED filter', async () => {
      // Create a lead (starts as NEW)
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Filter Mutation Corp',
        contactName: 'FM', phone: '+61 2 9300 8000',
        email: 'filtermut@test.com', source: 'WEBSITE',
      });
      expect([200, 201]).toContain(createRes.status);
      const id = (createRes.body as JsonObject)['id'] as string;

      // Appears in NEW filter
      const newBefore = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'NEW' });
      expect((newBefore.body as JsonObject[]).some((l) => l['id'] === id)).toBe(true);

      // Contact it
      const contactRes = await fwd(app.engineUrl, 'POST', `/leads/${id}/contact`, {});
      expect(contactRes.status).toBe(200);

      // No longer in NEW filter
      const newAfter = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'NEW' });
      expect((newAfter.body as JsonObject[]).some((l) => l['id'] === id)).toBe(false);

      // Now in CONTACTED filter
      const contacted = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'CONTACTED' });
      expect((contacted.body as JsonObject[]).some((l) => l['id'] === id)).toBe(true);
    }, 60_000);

    it('call.yaml query_mapping leadId filters calls by target lead', async () => {
      const leadRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Call Filter Corp',
        contactName: 'CF', phone: '+61 2 9300 8001',
        email: 'callfilter@test.com', source: 'PARTNER',
      });
      expect([200, 201]).toContain(leadRes.status);
      const leadId = (leadRes.body as JsonObject)['id'] as string;

      // Log 2 calls against this lead
      await fwd(app.engineUrl, 'POST', '/calls', {
        leadId, agentId: '00000000-0000-7000-8000-000000000003',
        campaignId: '00000000-0000-7000-8000-000000000001', outcome: 'INTERESTED',
      });
      await fwd(app.engineUrl, 'POST', '/calls', {
        leadId, agentId: '00000000-0000-7000-8000-000000000004',
        campaignId: '00000000-0000-7000-8000-000000000001', outcome: 'NO_ANSWER',
      });

      // Filter calls by leadId
      const res = await fwd(app.engineUrl, 'GET', '/calls', null, {}, { leadId });
      expect(res.status).toBe(200);
      expect((res.body as JsonObject[]).length).toBe(2);
      for (const call of res.body as JsonObject[]) {
        expect(call['leadId']).toBe(leadId);
      }
    }, 60_000);
  });
});
