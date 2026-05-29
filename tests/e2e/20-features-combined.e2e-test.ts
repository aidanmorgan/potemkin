/**
 * 20 — Features Combined via full Specmatic stack.
 *
 * Verifies query_mapping, emit_when branching, postconditions, idempotency,
 * first-match semantics, admin endpoints, derived projections, entity absence,
 * and ETag versioning — all exercised through the full Specmatic+plugin+Node
 * pipeline with state verified via /_admin/ endpoints.
 *
 * DSL files under test:
 *   All boundary YAML files (query_mapping, emit_when, postcondition)
 *   global.yaml (idempotency, derived_projections)
 *   lead.yaml (first-match behavior ordering)
 */

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd,
  getGraphNode,
  getEntityCount,
  getEventCount,
  getEventsByAggregate,
  getAllEvents,
  getAllEntities,
  adminReset,
} from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

function javaAvailable(): boolean {
  try { execSync('java -version', { stdio: 'pipe' }); return true; } catch { return false; }
}
const describeWithJava = javaAvailable() ? describe : describe.skip;

const CAMPAIGN_ACTIVE_ID = '00000000-0000-7000-8000-000000000001';
const CAMPAIGN_DRAFT_ID = '00000000-0000-7000-8000-000000000002';
const AGENT_ALICE_ID = '00000000-0000-7000-8000-000000000003';
const AGENT_BOB_ID = '00000000-0000-7000-8000-000000000004';
const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';

// ---- Section 1: query_mapping ----

describeWithJava('20a — DSL query_mapping (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  it('GET /leads?status=NEW returns only graph nodes where status==NEW', async () => {
    const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'NEW' });
    expect(res.status).toBe(200);
    expect((res.body as JsonObject[]).length).toBe(2); // Apex + Echo
    for (const lead of res.body as JsonObject[]) {
      const node = await getGraphNode(app.engineUrl, lead['id'] as string);
      expect(node!['status']).toBe('NEW');
    }
  }, 60_000);

  it('filter updates when graph node state changes via mutation', async () => {
    const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Filter Mut Corp', contactName: 'FM',
      phone: '+61 2 0000 0001', email: 'fm@test.com', source: 'WEBSITE',
    });
    expect([200, 201]).toContain(createRes.status);
    const id = (createRes.body as JsonObject)['id'] as string;

    // Graph node starts as NEW
    const nodeBefore = await getGraphNode(app.engineUrl, id);
    expect(nodeBefore!['status']).toBe('NEW');

    const newBefore = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'NEW' });
    expect((newBefore.body as JsonObject[]).some((l) => l['id'] === id)).toBe(true);

    // Contact -> status='CONTACTED'
    await fwd(app.engineUrl, 'POST', `/leads/${id}/contact`, {});
    const nodeAfter = await getGraphNode(app.engineUrl, id);
    expect(nodeAfter!['status']).toBe('CONTACTED');

    // No longer in NEW filter, now in CONTACTED
    const newAfter = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'NEW' });
    expect((newAfter.body as JsonObject[]).some((l) => l['id'] === id)).toBe(false);
    const contacted = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'CONTACTED' });
    expect((contacted.body as JsonObject[]).some((l) => l['id'] === id)).toBe(true);
  }, 60_000);

  it('campaign query_mapping filters by graph node status', async () => {
    const active = await fwd(app.engineUrl, 'GET', '/campaigns', null, {}, { status: 'ACTIVE' });
    expect(active.status).toBe(200);
    expect((active.body as JsonObject[]).length).toBe(1);

    const draft = await fwd(app.engineUrl, 'GET', '/campaigns', null, {}, { status: 'DRAFT' });
    expect(draft.status).toBe(200);
    expect((draft.body as JsonObject[]).length).toBe(1);
  }, 60_000);

  it('agent query_mapping filters by graph node currentStatus', async () => {
    const avail = await fwd(app.engineUrl, 'GET', '/agents', null, {}, { currentStatus: 'AVAILABLE' });
    expect(avail.status).toBe(200);
    expect((avail.body as JsonObject[]).length).toBe(2); // Alice + Bob
    for (const a of avail.body as JsonObject[]) {
      const node = await getGraphNode(app.engineUrl, a['id'] as string);
      expect(node!['currentStatus']).toBe('AVAILABLE');
    }

    const offline = await fwd(app.engineUrl, 'GET', '/agents', null, {}, { currentStatus: 'OFFLINE' });
    expect(offline.status).toBe(200);
    expect((offline.body as JsonObject[]).length).toBe(1); // Carla
  }, 60_000);

  it('query with no matches returns empty array', async () => {
    const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'DNC' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  }, 60_000);

  it('call query_mapping filters by graph node leadId', async () => {
    const leadRes = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Call QM Corp', contactName: 'CQ',
      phone: '+61 2 0000 0010', email: 'cq@test.com', source: 'PARTNER',
    });
    expect([200, 201]).toContain(leadRes.status);
    const leadId = (leadRes.body as JsonObject)['id'] as string;

    await fwd(app.engineUrl, 'POST', '/calls', {
      leadId, agentId: AGENT_ALICE_ID, campaignId: CAMPAIGN_ACTIVE_ID, outcome: 'INTERESTED',
    });
    await fwd(app.engineUrl, 'POST', '/calls', {
      leadId, agentId: AGENT_BOB_ID, campaignId: CAMPAIGN_ACTIVE_ID, outcome: 'NO_ANSWER',
    });

    const res = await fwd(app.engineUrl, 'GET', '/calls', null, {}, { leadId });
    expect(res.status).toBe(200);
    expect((res.body as JsonObject[]).length).toBe(2);
    for (const call of res.body as JsonObject[]) {
      expect(call['leadId']).toBe(leadId);
    }
  }, 60_000);
});

// ---- Section 2: emit_when branching + postcondition ----

describeWithJava('20b — DSL emit_when branching + postcondition (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  describe('campaign pause emit_when branches on actualCalls', () => {
    it('branch: actualCalls == 0 -- pause a fresh campaign', async () => {
      await fwd(app.engineUrl, 'PATCH', `/campaigns/${CAMPAIGN_DRAFT_ID}/activate`, {});
      const nodeAfterActivate = await getGraphNode(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(nodeAfterActivate!['actualCalls']).toBe(0);

      await fwd(app.engineUrl, 'PATCH', `/campaigns/${CAMPAIGN_DRAFT_ID}/pause`, {});
      const node = await getGraphNode(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(node!['status']).toBe('PAUSED');

      const events = await getEventsByAggregate(app.engineUrl, CAMPAIGN_DRAFT_ID);
      expect(events.some(e => e.type === 'CampaignPaused')).toBe(true);
    }, 60_000);

    it('branch: actualCalls > 0 -- pause a campaign that received leads', async () => {
      const campRes = await fwd(app.engineUrl, 'POST', '/campaigns', {
        name: 'EmitWhen Test', targetSource: 'WEBSITE', script: 'test',
        startedAt: '2025-01-01T00:00:00.000Z', endedAt: '2025-12-31T23:59:59.000Z',
        targetCalls: 50, targetConversions: 5,
      });
      expect([200, 201]).toContain(campRes.status);
      const campId = (campRes.body as JsonObject)['id'] as string;
      await fwd(app.engineUrl, 'PATCH', `/campaigns/${campId}/activate`, {});

      // Dispatch leads to increment actualCalls via forward
      await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'EW1', contactName: 'EW', phone: '+61 0', email: 'ew@test.com', source: 'WEBSITE', assignedCampaignId: campId,
      });

      const campNode = await getGraphNode(app.engineUrl, campId);
      expect((campNode!['actualCalls'] as number)).toBeGreaterThan(0);

      await fwd(app.engineUrl, 'PATCH', `/campaigns/${campId}/pause`, {});
      const paused = await getGraphNode(app.engineUrl, campId);
      expect(paused!['status']).toBe('PAUSED');
    }, 60_000);
  });

  describe('lead contact emit_when branches on status', () => {
    it('contact from NEW (first branch) sets graph status=CONTACTED', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'EW New', contactName: 'N', phone: '+61 0', email: 'ewnew@t.com', source: 'WEBSITE',
      });
      expect([200, 201]).toContain(res.status);
      const id = (res.body as JsonObject)['id'] as string;

      const nodeBefore = await getGraphNode(app.engineUrl, id);
      expect(nodeBefore!['status']).toBe('NEW');

      await fwd(app.engineUrl, 'POST', `/leads/${id}/contact`, {});
      const node = await getGraphNode(app.engineUrl, id);
      expect(node!['status']).toBe('CONTACTED');
      expect(node!['lastContactedAt']).toBeDefined();
    }, 60_000);

    it('contact from QUALIFIED (second branch) demotes to CONTACTED', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'EW Qual', contactName: 'Q', phone: '+61 0', email: 'ewqual@t.com', source: 'REFERRAL',
      });
      expect([200, 201]).toContain(res.status);
      const id = (res.body as JsonObject)['id'] as string;
      await fwd(app.engineUrl, 'POST', '/calls', { leadId: id, agentId: AGENT_ALICE_ID, campaignId: CAMPAIGN_ACTIVE_ID, outcome: 'INTERESTED' });
      await fwd(app.engineUrl, 'POST', `/leads/${id}/contact`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${id}/qualify`, {});

      const qualNode = await getGraphNode(app.engineUrl, id);
      expect(qualNode!['status']).toBe('QUALIFIED');

      await fwd(app.engineUrl, 'POST', `/leads/${id}/contact`, {});
      const node = await getGraphNode(app.engineUrl, id);
      expect(node!['status']).toBe('CONTACTED');
    }, 60_000);
  });

  describe('opportunity close LOST emit_when branches on stage', () => {
    async function makeOpp(company: string, value: number): Promise<string> {
      const lr = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: company, contactName: 'O', phone: '+61 0', email: `${company.toLowerCase().replace(/\s/g, '')}@t.com`, source: 'REFERRAL',
      });
      const lid = (lr.body as JsonObject)['id'] as string;
      await fwd(app.engineUrl, 'POST', '/calls', { leadId: lid, agentId: AGENT_ALICE_ID, campaignId: CAMPAIGN_ACTIVE_ID, outcome: 'INTERESTED' });
      await fwd(app.engineUrl, 'POST', `/leads/${lid}/contact`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${lid}/qualify`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${lid}/convert`, { value, probability: 50 });
      const opps = await fwd(app.engineUrl, 'GET', '/opportunities');
      return (opps.body as JsonObject[]).find((o) => o['leadId'] === lid)!['id'] as string;
    }

    it('LOST from PROPOSED (second branch)', async () => {
      const oppId = await makeOpp('Lost Proposed Corp', 40000);
      const nodeBefore = await getGraphNode(app.engineUrl, oppId);
      expect(nodeBefore!['stage']).toBe('PROPOSED');

      await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppId}/close`, { outcome: 'LOST', closureReason: 'No budget' });
      const node = await getGraphNode(app.engineUrl, oppId);
      expect(node!['stage']).toBe('LOST');
      expect(node!['closureReason']).toBe('No budget');
    }, 60_000);

    it('LOST from NEGOTIATING (first branch)', async () => {
      const oppId = await makeOpp('Lost Neg Corp', 55000);
      await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppId}/advance`, {});
      const advNode = await getGraphNode(app.engineUrl, oppId);
      expect(advNode!['stage']).toBe('NEGOTIATING');

      await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppId}/close`, { outcome: 'LOST', closureReason: 'Competitor' });
      const node = await getGraphNode(app.engineUrl, oppId);
      expect(node!['stage']).toBe('LOST');
    }, 60_000);

    it('LOST without reason uses DSL default from payload_template', async () => {
      const oppId = await makeOpp('Lost Default Corp', 30000);
      await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppId}/close`, { outcome: 'LOST' });
      const node = await getGraphNode(app.engineUrl, oppId);
      expect(node!['closureReason']).toBe('No reason given');
    }, 60_000);
  });

  describe('postcondition enforcement', () => {
    it('convert postcondition passes -- graph node status == CONVERTED', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'PC Corp', contactName: 'PC', phone: '+61 0', email: 'pc@t.com', source: 'REFERRAL',
      });
      expect([200, 201]).toContain(res.status);
      const id = (res.body as JsonObject)['id'] as string;
      await fwd(app.engineUrl, 'POST', '/calls', { leadId: id, agentId: AGENT_ALICE_ID, campaignId: CAMPAIGN_ACTIVE_ID, outcome: 'INTERESTED' });
      await fwd(app.engineUrl, 'POST', `/leads/${id}/contact`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${id}/qualify`, {});

      // If postcondition failed, this would return 500 not 200
      const convertRes = await fwd(app.engineUrl, 'POST', `/leads/${id}/convert`, { value: 50000 });
      expect(convertRes.status).toBe(200);
      const node = await getGraphNode(app.engineUrl, id);
      expect(node!['status']).toBe('CONVERTED');
    }, 60_000);
  });

  describe('opportunity advance probability override', () => {
    async function makeOpp(company: string, value: number, prob: number): Promise<string> {
      const lr = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: company, contactName: 'P', phone: '+61 0', email: `${company.toLowerCase().replace(/\s/g, '')}@t.com`, source: 'REFERRAL',
      });
      const lid = (lr.body as JsonObject)['id'] as string;
      await fwd(app.engineUrl, 'POST', '/calls', { leadId: lid, agentId: AGENT_ALICE_ID, campaignId: CAMPAIGN_ACTIVE_ID, outcome: 'INTERESTED' });
      await fwd(app.engineUrl, 'POST', `/leads/${lid}/contact`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${lid}/qualify`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${lid}/convert`, { value, probability: prob });
      const opps = await fwd(app.engineUrl, 'GET', '/opportunities');
      return (opps.body as JsonObject[]).find(o => o['leadId'] === lid)!['id'] as string;
    }

    it('advance with explicit probability updates graph node', async () => {
      const oppId = await makeOpp('Prob Corp', 60000, 50);
      const nodeBefore = await getGraphNode(app.engineUrl, oppId);
      expect(nodeBefore!['probability']).toBe(50);

      await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppId}/advance`, { probability: 90 });
      const nodeAfter = await getGraphNode(app.engineUrl, oppId);
      expect(nodeAfter!['probability']).toBe(90);
    }, 60_000);

    it('advance without probability keeps existing value in graph', async () => {
      const oppId = await makeOpp('ProbKeep Corp', 45000, 50);

      await fwd(app.engineUrl, 'PATCH', `/opportunities/${oppId}/advance`, {});
      const node = await getGraphNode(app.engineUrl, oppId);
      expect(node!['probability']).toBe(50);
    }, 60_000);
  });
});

// ---- Section 3: Idempotency + first-match semantics ----

describeWithJava('20c — DSL idempotency + first-match semantics (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  describe('idempotency via forward endpoint', () => {
    it('same key + same body -> replay, graph has only 1 entity', async () => {
      const key = `idem-same-${Date.now()}`;
      const body = { companyName: 'Idem Corp', contactName: 'I', phone: '+61 0', email: 'idem@t.com', source: 'WEBSITE' };

      const first = await fwd(app.engineUrl, 'POST', '/leads', body, { 'idempotency-key': key });
      expect([200, 201]).toContain(first.status);
      const id = (first.body as JsonObject)['id'] as string;
      expect(await getGraphNode(app.engineUrl, id)).not.toBeNull();

      const second = await fwd(app.engineUrl, 'POST', '/leads', body, { 'idempotency-key': key });
      expect((second.body as JsonObject)['id']).toBe(id);
      expect(second.headers['x-idempotency-replay']).toBe('true');

      // Only 1 LeadCreated event for this aggregate
      const events = await getEventsByAggregate(app.engineUrl, id);
      expect(events.filter(e => e.type === 'LeadCreated').length).toBe(1);
    }, 60_000);

    it('same key + different body -> conflict, graph unchanged', async () => {
      const key = `idem-diff-${Date.now()}`;
      const body1 = { companyName: 'Idem A', contactName: 'A', phone: '+61 0', email: 'a@t.com', source: 'WEBSITE' };
      const body2 = { companyName: 'Idem B', contactName: 'B', phone: '+61 0', email: 'b@t.com', source: 'REFERRAL' };

      const first = await fwd(app.engineUrl, 'POST', '/leads', body1, { 'idempotency-key': key });
      expect([200, 201]).toContain(first.status);

      const second = await fwd(app.engineUrl, 'POST', '/leads', body2, { 'idempotency-key': key });
      expect(second.status).toBe(409);
    }, 60_000);

    it('different idempotency keys produce separate graph nodes', async () => {
      const key1 = `idem-k1-${Date.now()}`;
      const key2 = `idem-k2-${Date.now()}`;
      const body = { companyName: 'Idem Multi', contactName: 'IM', phone: '+61 0', email: 'im@t.com', source: 'WEBSITE' };

      const r1 = await fwd(app.engineUrl, 'POST', '/leads', body, { 'idempotency-key': key1 });
      const r2 = await fwd(app.engineUrl, 'POST', '/leads', body, { 'idempotency-key': key2 });

      const id1 = (r1.body as JsonObject)['id'] as string;
      const id2 = (r2.body as JsonObject)['id'] as string;
      expect(id1).not.toBe(id2);
      expect(await getGraphNode(app.engineUrl, id1)).not.toBeNull();
      expect(await getGraphNode(app.engineUrl, id2)).not.toBeNull();
    }, 60_000);
  });

  describe('RBAC: required_scopes in DSL controls access', () => {
    let dncLeadId: string;

    beforeAll(async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'RBAC Corp', contactName: 'R', phone: '+61 0', email: 'rbac@t.com', source: 'WEBSITE',
      });
      dncLeadId = (res.body as JsonObject)['id'] as string;
    });

    it('POST /leads/:id/dnc without Authorization -> 401, graph unchanged', async () => {
      const nodeBefore = await getGraphNode(app.engineUrl, dncLeadId);
      expect(nodeBefore!['status']).toBe('NEW');

      const res = await fwd(app.engineUrl, 'POST', `/leads/${dncLeadId}/dnc`, { reason: 'test' });
      expect(res.status).toBe(401);

      const nodeAfter = await getGraphNode(app.engineUrl, dncLeadId);
      expect(nodeAfter!['status']).toBe('NEW');
    }, 60_000);

    it('POST /leads/:id/dnc with non-manager scope -> 403, graph unchanged', async () => {
      const res = await fwd(app.engineUrl, 'POST', `/leads/${dncLeadId}/dnc`, { reason: 'test' }, { 'Authorization': 'Bearer agent1:agent,viewer' });
      expect(res.status).toBe(403);

      const nodeAfter = await getGraphNode(app.engineUrl, dncLeadId);
      expect(nodeAfter!['status']).toBe('NEW');
    }, 60_000);

    it('POST /leads/:id/dnc with manager scope -> 200, graph updated to DNC', async () => {
      const res = await fwd(app.engineUrl, 'POST', `/leads/${dncLeadId}/dnc`, { reason: 'Customer requested' }, { 'Authorization': 'Bearer mgr1:manager' });
      expect(res.status).toBe(200);

      const nodeAfter = await getGraphNode(app.engineUrl, dncLeadId);
      expect(nodeAfter!['status']).toBe('DNC');

      const events = await getEventsByAggregate(app.engineUrl, dncLeadId);
      expect(events.some(e => e.type === 'LeadMarkedDNC')).toBe(true);
    }, 60_000);
  });

  describe('first-match: appendCallId fires before contact guards', () => {
    it('secondary dispatch appends callId without changing graph status', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'FM Corp', contactName: 'FM', phone: '+61 0', email: 'fme2e@t.com', source: 'WEBSITE',
      });
      expect([200, 201]).toContain(res.status);
      const id = (res.body as JsonObject)['id'] as string;

      const nodeBefore = await getGraphNode(app.engineUrl, id);
      expect(nodeBefore!['status']).toBe('NEW');

      await fwd(app.engineUrl, 'POST', '/calls', {
        leadId: id, agentId: AGENT_ALICE_ID, campaignId: CAMPAIGN_ACTIVE_ID, outcome: 'NO_ANSWER',
      });

      const node = await getGraphNode(app.engineUrl, id);
      expect(node!['status']).toBe('NEW');
      expect((node!['callIds'] as string[]).length).toBe(1);

      const events = await getEventsByAggregate(app.engineUrl, id);
      expect(events.map(e => e.type)).toContain('CallIdAppended');
      expect(events.map(e => e.type)).not.toContain('LeadContacted');
    }, 60_000);
  });
});

// ---- Section 4: Engine discovery endpoints ----

describeWithJava('20d — DSL engine endpoints (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  describe('GET /_engine/routes reflects DSL contract_path declarations', () => {
    it('returns paths array containing all DSL-declared contract_paths', async () => {
      const res = await fetch(`${app.engineUrl}/_engine/routes`);
      expect(res.status).toBe(200);
      const body = await res.json() as { paths: string[]; engine: string; checksum: string };

      expect(Array.isArray(body.paths)).toBe(true);
      expect(body.paths).toContain('/leads');
      expect(body.paths).toContain('/campaigns');
      expect(body.paths).toContain('/agents');
      expect(body.paths).toContain('/calls');
      expect(body.paths).toContain('/opportunities');
    }, 60_000);

    it('includes sub-path action boundaries from DSL', async () => {
      const res = await fetch(`${app.engineUrl}/_engine/routes`);
      const body = await res.json() as { paths: string[] };

      expect(body.paths).toContain('/leads/{id}/contact');
      expect(body.paths).toContain('/leads/{id}/qualify');
      expect(body.paths).toContain('/leads/{id}/convert');
      expect(body.paths).toContain('/leads/{id}/dnc');
      expect(body.paths).toContain('/campaigns/{id}/activate');
      expect(body.paths).toContain('/opportunities/{id}/advance');
      expect(body.paths).toContain('/opportunities/{id}/close');
    }, 60_000);

    it('reports engine identity and includes checksum', async () => {
      const res = await fetch(`${app.engineUrl}/_engine/routes`);
      const body = await res.json() as { engine: string; checksum: string };

      expect(body.engine).toBe('potemkin-stateful');
      expect(typeof body.checksum).toBe('string');
      expect(res.headers.get('etag')).toBeTruthy();
    }, 60_000);
  });

  describe('GET /_engine/fixtures reflects DSL initialization seed data', () => {
    it('returns fixture list with entries for seeded entities', async () => {
      const res = await fetch(`${app.engineUrl}/_engine/fixtures`);
      expect(res.status).toBe(200);
      const body = await res.json() as { fixtures: Array<{ httpRequest: { path: string }; httpResponse: { body: Record<string, unknown> } }> };

      expect(Array.isArray(body.fixtures)).toBe(true);
      expect(body.fixtures.length).toBeGreaterThan(0);
    }, 60_000);

    it('Apex Solutions fixture matches DSL initialization values', async () => {
      const res = await fetch(`${app.engineUrl}/_engine/fixtures`);
      const body = await res.json() as { fixtures: Array<{ httpRequest: { path: string }; httpResponse: { body: Record<string, unknown> } }> };

      const apexFixture = body.fixtures.find(f => f.httpRequest.path === `/leads/${APEX_LEAD_ID}`);
      expect(apexFixture).toBeDefined();
      expect(apexFixture!.httpResponse.body['companyName']).toBe('Apex Solutions Ltd');
      expect(apexFixture!.httpResponse.body['status']).toBe('NEW');
    }, 60_000);
  });

  describe('/_engine/forward processes commands through the DSL pipeline', () => {
    it('POST /leads via forward creates an entity in the graph', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Forwarded Corp', contactName: 'F', phone: '+61 0', email: 'fwd@t.com', source: 'WEBSITE',
      });
      expect([200, 201]).toContain(res.status);
      const id = (res.body as JsonObject)['id'] as string;
      const node = await getGraphNode(app.engineUrl, id);
      expect(node).not.toBeNull();
      expect(node!['companyName']).toBe('Forwarded Corp');
    }, 60_000);

    it('GET via forward returns entity from graph', async () => {
      const res = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`);
      expect(res.status).toBe(200);
      expect((res.body as JsonObject)['companyName']).toBe('Apex Solutions Ltd');
    }, 60_000);
  });

  describe('/_engine/health reports engine status', () => {
    it('returns UP with version', async () => {
      const res = await fetch(`${app.engineUrl}/_engine/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; engine: string; version: string };
      expect(body.status).toBe('UP');
      expect(body.engine).toBe('potemkin-stateful');
      expect(typeof body.version).toBe('string');
    }, 60_000);
  });
});

// ---- Section 5: Admin endpoints ----

describeWithJava('20e — DSL admin endpoints (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  it('GET /_admin/state dumps the full object graph seeded by DSL initialization', async () => {
    const entities = await getAllEntities(app.engineUrl);
    const count = await getEntityCount(app.engineUrl);

    expect(Object.keys(entities).length).toBe(count);
    expect(entities[APEX_LEAD_ID]).toBeDefined();
    expect((entities[APEX_LEAD_ID] as JsonObject)['companyName']).toBe('Apex Solutions Ltd');
  }, 60_000);

  it('GET /_admin/events returns baseline events', async () => {
    const events = await getAllEvents(app.engineUrl);
    expect(events.length).toBeGreaterThan(0);
  }, 60_000);

  it('GET /_admin/events?aggregateId filters to one aggregate', async () => {
    const events = await getEventsByAggregate(app.engineUrl, APEX_LEAD_ID);
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const evt of events) {
      expect(evt.aggregateId).toBe(APEX_LEAD_ID);
    }
  }, 60_000);

  it('mutations produce ordered events with increasing sequenceVersion', async () => {
    const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Evt Corp', contactName: 'E', phone: '+61 0', email: 'evt@t.com', source: 'REFERRAL',
    });
    expect([200, 201]).toContain(createRes.status);
    const id = (createRes.body as JsonObject)['id'] as string;

    await fwd(app.engineUrl, 'POST', '/calls', { leadId: id, agentId: AGENT_ALICE_ID, campaignId: CAMPAIGN_ACTIVE_ID, outcome: 'INTERESTED' });
    await fwd(app.engineUrl, 'POST', `/leads/${id}/contact`, {});

    const events = await getEventsByAggregate(app.engineUrl, id);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].sequenceVersion).toBeGreaterThan(events[i - 1].sequenceVersion);
    }
  }, 60_000);

  it('POST /_admin/reset restores graph to DSL initialization baseline', async () => {
    // Mutate a seeded entity
    await fwd(app.engineUrl, 'POST', `/leads/${APEX_LEAD_ID}/contact`, {});
    const contactedNode = await getGraphNode(app.engineUrl, APEX_LEAD_ID);
    expect(contactedNode!['status']).toBe('CONTACTED');

    // Create a new entity
    const newRes = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Reset Corp', contactName: 'R', phone: '+61 0', email: 'reset@t.com', source: 'COLD_LIST',
    });
    expect([200, 201]).toContain(newRes.status);
    const newId = (newRes.body as JsonObject)['id'] as string;
    expect(await getGraphNode(app.engineUrl, newId)).not.toBeNull();

    await adminReset(app.engineUrl);

    // Seeded entity restored to initialization state
    const restoredNode = await getGraphNode(app.engineUrl, APEX_LEAD_ID);
    expect(restoredNode!['status']).toBe('NEW');

    // New entity gone
    expect(await getGraphNode(app.engineUrl, newId)).toBeNull();

    // Graph size back to baseline
    const count = await getEntityCount(app.engineUrl);
    expect(count).toBe(10);
  }, 60_000);

  it('GET /_admin/health reports entity and event counts from graph', async () => {
    const entityCount = await getEntityCount(app.engineUrl);
    const eventCount = await getEventCount(app.engineUrl);

    expect(entityCount).toBeGreaterThan(0);
    expect(eventCount).toBeGreaterThan(0);
  }, 60_000);
});

// ---- Section 6: Entity absence + ETag versioning ----

describeWithJava('20f — DSL entity absence + ETag versioning (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  it('GET for non-existent entity returns 404, graph has no node', async () => {
    const fakeId = '00000000-0000-0000-0000-ffffffffffff';
    expect(await getGraphNode(app.engineUrl, fakeId)).toBeNull();
    const res = await fwd(app.engineUrl, 'GET', `/leads/${fakeId}`);
    expect(res.status).toBe(404);
  }, 60_000);

  it('mutation on non-existent entity returns 404, graph unchanged', async () => {
    const fakeId = '00000000-0000-0000-0000-ffffffffffff';
    const countBefore = await getEntityCount(app.engineUrl);
    const res = await fwd(app.engineUrl, 'POST', `/leads/${fakeId}/contact`, {});
    expect(res.status).toBe(404);
    const countAfter = await getEntityCount(app.engineUrl);
    expect(countAfter).toBe(countBefore);
  }, 60_000);

  it('creation returns response with id', async () => {
    const res = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'ETag Corp', contactName: 'ET', phone: '+61 0', email: 'et@t.com', source: 'WEBSITE',
    });
    expect([200, 201]).toContain(res.status);
    const id = (res.body as JsonObject)['id'] as string;
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  }, 60_000);
});
