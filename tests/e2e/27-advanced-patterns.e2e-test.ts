/**
 * 27 — Advanced Patterns: Saga, schema evolution, RBAC, observability
 * via full Specmatic+plugin+Node stack.
 *
 * Verifies advanced DSL features work correctly end-to-end by inspecting
 * graph state and events via admin endpoints.
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd, getGraphNode, getEventsByAggregate, getEntityCount, getEventCount,
  getAllEntities, javaAvailable,
} from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

const AGENT_ID = '00000000-0000-7000-8000-000000000003';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';
const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';

describeWithJava('27 — Advanced Patterns (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  describe('saga / process manager', () => {
    let convertedLeadId: string;

    it('lead conversion triggers saga -> creates Opportunity in graph', async () => {
      const lr = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Saga Corp', contactName: 'S', phone: '+61 0', email: 'saga@t.com', source: 'REFERRAL',
      });
      expect([200, 201]).toContain(lr.status);
      convertedLeadId = (lr.body as JsonObject)['id'] as string;

      await fwd(app.engineUrl, 'POST', '/calls', { leadId: convertedLeadId, agentId: AGENT_ID, campaignId: CAMPAIGN_ID, outcome: 'INTERESTED' });
      await fwd(app.engineUrl, 'POST', `/leads/${convertedLeadId}/contact`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${convertedLeadId}/qualify`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${convertedLeadId}/convert`, { value: 75000, probability: 80 });

      const opps = await fwd(app.engineUrl, 'GET', '/opportunities');
      const opp = (opps.body as JsonObject[]).find(o => o['leadId'] === convertedLeadId);
      expect(opp).toBeDefined();
      const oppNode = await getGraphNode(app.engineUrl, opp!['id'] as string);
      expect(oppNode).not.toBeNull();
    }, 60_000);

    it('saga-created opportunity has correct leadId, value, probability', async () => {
      const opps = await fwd(app.engineUrl, 'GET', '/opportunities');
      const opp = (opps.body as JsonObject[]).find(o => o['leadId'] === convertedLeadId)!;
      const node = await getGraphNode(app.engineUrl, opp['id'] as string);
      expect(node!['leadId']).toBe(convertedLeadId);
      expect(node!['value']).toBe(75000);
      expect(node!['stage']).toBe('PROPOSED');
    }, 60_000);

    it('multiple conversions -> each creates own opportunity (saga isolation)', async () => {
      const lr2 = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Saga2 Corp', contactName: 'S2', phone: '+61 0', email: 'saga2@t.com', source: 'PARTNER',
      });
      expect([200, 201]).toContain(lr2.status);
      const lid2 = (lr2.body as JsonObject)['id'] as string;

      await fwd(app.engineUrl, 'POST', '/calls', { leadId: lid2, agentId: AGENT_ID, campaignId: CAMPAIGN_ID, outcome: 'INTERESTED' });
      await fwd(app.engineUrl, 'POST', `/leads/${lid2}/contact`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${lid2}/qualify`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${lid2}/convert`, { value: 30000, probability: 60 });

      const opps = await fwd(app.engineUrl, 'GET', '/opportunities');
      const opp1 = (opps.body as JsonObject[]).find(o => o['leadId'] === convertedLeadId);
      const opp2 = (opps.body as JsonObject[]).find(o => o['leadId'] === lid2);
      expect(opp1).toBeDefined();
      expect(opp2).toBeDefined();
      expect(opp1!['id']).not.toBe(opp2!['id']);
    }, 60_000);

    it('event stream shows LeadConverted -> OpportunityCreated causal chain', async () => {
      const leadEvents = await getEventsByAggregate(app.engineUrl, convertedLeadId);
      expect(leadEvents.some(e => e.type === 'LeadConverted')).toBe(true);

      const opps = await fwd(app.engineUrl, 'GET', '/opportunities');
      const opp = (opps.body as JsonObject[]).find(o => o['leadId'] === convertedLeadId)!;
      const oppEvents = await getEventsByAggregate(app.engineUrl, opp['id'] as string);
      expect(oppEvents.some(e => e.type === 'OpportunityCreated')).toBe(true);
    }, 60_000);
  });

  describe('schema evolution -- optional field defaults', () => {
    it('POST /leads with only required fields -> optional fields get defaults', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Minimal Corp', contactName: 'M', phone: '+61 0', email: 'min@t.com', source: 'WEBSITE',
      });
      expect([200, 201]).toContain(res.status);
      const id = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, id);
      expect(node!['callIds']).toEqual([]);
      expect(node!['notes']).toEqual([]);
      expect(node!['status']).toBe('NEW');
    }, 60_000);

    it('POST /calls with only required fields -> optional fields get defaults', async () => {
      const lr = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Call Default Corp', contactName: 'CD', phone: '+61 0', email: 'cd@t.com', source: 'WEBSITE',
      });
      expect([200, 201]).toContain(lr.status);
      const leadId = (lr.body as JsonObject)['id'] as string;

      const res = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId, agentId: AGENT_ID, campaignId: CAMPAIGN_ID, outcome: 'NO_ANSWER',
      });
      expect([200, 201]).toContain(res.status);
      const callId = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, callId);
      expect(node!['transcript']).toEqual([]);
      expect(typeof node!['startedAt']).toBe('string');
    }, 60_000);

    it('GET entity with minimal fields -> optional fields present as null or default', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'GetDefault Corp', contactName: 'GD', phone: '+61 0', email: 'gd@t.com', source: 'COLD_LIST',
      });
      expect([200, 201]).toContain(res.status);
      const id = (res.body as JsonObject)['id'] as string;

      const getRes = await fwd(app.engineUrl, 'GET', `/leads/${id}`);
      expect(getRes.status).toBe(200);
      expect((getRes.body as JsonObject)['callIds']).toEqual([]);
      expect((getRes.body as JsonObject)['notes']).toEqual([]);
    }, 60_000);
  });

  describe('RBAC / authorization simulation', () => {
    let rbacLeadId: string;

    beforeAll(async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'RBAC Corp', contactName: 'R', phone: '+61 0', email: 'rbac@t.com', source: 'WEBSITE',
      });
      rbacLeadId = (res.body as JsonObject)['id'] as string;
    });

    it('DNC without auth -> 401, graph unchanged', async () => {
      const res = await fwd(app.engineUrl, 'POST', `/leads/${rbacLeadId}/dnc`, { reason: 'test' });
      expect(res.status).toBe(401);
      const node = await getGraphNode(app.engineUrl, rbacLeadId);
      expect(node!['status']).toBe('NEW');
    }, 60_000);

    it('DNC with wrong scope -> 403, graph unchanged', async () => {
      const res = await fwd(
        app.engineUrl, 'POST', `/leads/${rbacLeadId}/dnc`,
        { reason: 'test' },
        { 'Authorization': 'Bearer agent1:agent,viewer' },
      );
      expect(res.status).toBe(403);
      const node = await getGraphNode(app.engineUrl, rbacLeadId);
      expect(node!['status']).toBe('NEW');
    }, 60_000);

    it('DNC with manager scope -> 200, graph updated to DNC', async () => {
      const res = await fwd(
        app.engineUrl, 'POST', `/leads/${rbacLeadId}/dnc`,
        { reason: 'Customer requested' },
        { 'Authorization': 'Bearer mgr1:manager' },
      );
      expect(res.status).toBe(200);
      const node = await getGraphNode(app.engineUrl, rbacLeadId);
      expect(node!['status']).toBe('DNC');
      const events = await getEventsByAggregate(app.engineUrl, rbacLeadId);
      expect(events.some(e => e.type === 'LeadMarkedDNC')).toBe(true);
    }, 60_000);
  });

  describe('observability / audit trail', () => {
    it('events filtered by aggregateId belong to that aggregate', async () => {
      const events = await getEventsByAggregate(app.engineUrl, APEX_LEAD_ID);
      for (const evt of events) {
        expect(evt.aggregateId).toBe(APEX_LEAD_ID);
      }
    }, 60_000);

    it('admin state entity count matches health entity count', async () => {
      const entities = await getAllEntities(app.engineUrl);
      const count = await getEntityCount(app.engineUrl);
      expect(Object.keys(entities).length).toBe(count);
    }, 60_000);

    it('health reports correct entity and event counts', async () => {
      const entityCount = await getEntityCount(app.engineUrl);
      const eventCount = await getEventCount(app.engineUrl);
      expect(entityCount).toBeGreaterThanOrEqual(10);
      expect(eventCount).toBeGreaterThanOrEqual(10);
    }, 60_000);
  });
});
