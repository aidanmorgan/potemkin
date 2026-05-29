/**
 * 39 — Multi-Sort & Array Operators: validate the two new query operators
 * exposed by the engine — multi-field sort (?sort=status,-score) and array
 * membership operators (?callIds:contains=<uuid>, ?callIds:arrayContains=<uuid>) —
 * exercised through the full Specmatic+plugin+Node stack.
 *
 * Feature 1: Multi-field sort
 *   ?sort=status,-score      sort by status ASC, score DESC
 *   ?sort=-createdAt,name    sort by createdAt DESC, name ASC
 *   Backward-compat with single-field ?sort=score&order=desc.
 *
 * Feature 2: Array contains operators
 *   ?callIds:contains=<id>        membership test on arrays (substring on strings)
 *   ?callIds:arrayContains=<id>   strict array-only membership; non-arrays → false
 *
 * DSL files under test:
 *   lead.yaml (5 seeded leads with score, status, source, companyName)
 *   call.yaml (CallLogged events append to Lead.callIds)
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { fwd, getGraphNode, javaAvailable } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

// Seeded IDs
const AGENT_ID    = '00000000-0000-7000-8000-000000000003';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';

// Seeded Lead IDs from lead.yaml initialization
const APEX_LEAD_ID    = '00000000-0000-7000-8000-000000000010'; // score=50, NEW,          WEBSITE,    "Apex Solutions Ltd"
const BLUESKY_LEAD_ID = '00000000-0000-7000-8000-000000000011'; // score=80, CONTACTED,    REFERRAL,   "BlueSky Tech"
const CORNER_LEAD_ID  = '00000000-0000-7000-8000-000000000012'; // score=20, QUALIFIED,    COLD_LIST,  "Cornerstone Corp"
const DELTA_LEAD_ID   = '00000000-0000-7000-8000-000000000013'; // score=70, DISQUALIFIED, PARTNER,    "Delta Dynamics"
const ECHO_LEAD_ID    = '00000000-0000-7000-8000-000000000014'; // score=50, NEW,          WEBSITE,    "Echo Enterprises"

describeWithJava('39 — Multi-Sort & Array Operators (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // Multi-field sorting
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Multi-field sorting', () => {

    it('?sort=status,score sorts by status ASC, then score ASC for ties', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { sort: 'status,score' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const leads = res.body as JsonObject[];
      expect(leads.length).toBe(5);

      // Statuses must appear in alphabetical order:
      // CONTACTED, DISQUALIFIED, NEW, NEW, QUALIFIED
      const statuses = leads.map((l) => l['status'] as string);
      expect(statuses).toEqual(['CONTACTED', 'DISQUALIFIED', 'NEW', 'NEW', 'QUALIFIED']);

      // Per-status entity expectations
      expect(leads[0]['id']).toBe(BLUESKY_LEAD_ID); // CONTACTED, score=80
      expect(leads[1]['id']).toBe(DELTA_LEAD_ID);   // DISQUALIFIED, score=70
      // Index 2,3 are both NEW (APEX & ECHO at score=50) — order between them
      // is determined by the secondary score key (tie ⇒ stable comparator order).
      const newIds = [leads[2]['id'], leads[3]['id']].sort();
      expect(newIds).toEqual([APEX_LEAD_ID, ECHO_LEAD_ID].sort());
      expect(leads[4]['id']).toBe(CORNER_LEAD_ID);  // QUALIFIED, score=20
    }, 60_000);

    it('?sort=-score,status sorts by score DESC primary, status ASC for ties', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { sort: '-score,status' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const leads = res.body as JsonObject[];
      expect(leads.length).toBe(5);

      const scores = leads.map((l) => l['score'] as number);
      expect(scores).toEqual([80, 70, 50, 50, 20]);

      // Top + bottom rows are unique on score
      expect(leads[0]['id']).toBe(BLUESKY_LEAD_ID); // score=80
      expect(leads[1]['id']).toBe(DELTA_LEAD_ID);   // score=70
      expect(leads[4]['id']).toBe(CORNER_LEAD_ID);  // score=20

      // Middle two ties on score=50 (APEX, ECHO) — both have status=NEW so the
      // secondary key is a tie too; assert membership rather than ordering.
      const middleIds = [leads[2]['id'], leads[3]['id']].sort();
      expect(middleIds).toEqual([APEX_LEAD_ID, ECHO_LEAD_ID].sort());
    }, 60_000);

    it('multi-field sort combined with filter (?status:in=NEW,CONTACTED&sort=-score)', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'status:in': 'NEW,CONTACTED',
        sort: '-score',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const leads = res.body as JsonObject[];
      // CONTACTED: BlueSky (80); NEW: Apex (50), Echo (50)
      expect(leads.length).toBe(3);

      // BlueSky has the highest score and must come first
      expect(leads[0]['id']).toBe(BLUESKY_LEAD_ID);
      expect(leads[0]['score']).toBe(80);

      // Remaining two are Apex / Echo, both score=50, both status=NEW
      const tailIds = [leads[1]['id'], leads[2]['id']].sort();
      expect(tailIds).toEqual([APEX_LEAD_ID, ECHO_LEAD_ID].sort());
      expect(leads[1]['score']).toBe(50);
      expect(leads[2]['score']).toBe(50);
    }, 60_000);

    it('multi-field sort with pagination envelope (?sort=-score,companyName&limit=3)', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        sort: '-score,companyName',
        limit: '3',
      });
      expect(res.status).toBe(200);

      // ?limit=… switches the response to the pagination envelope shape
      const body = res.body as JsonObject;
      expect(Array.isArray(body['items'])).toBe(true);
      expect(body['totalCount']).toBe(5);
      expect(body['offset']).toBe(0);
      expect(body['limit']).toBe(3);
      expect(body['hasMore']).toBe(true);

      const items = body['items'] as JsonObject[];
      expect(items.length).toBe(3);

      // Top 3 by score DESC: BlueSky (80), Delta (70), then a 50-score lead
      expect(items[0]['id']).toBe(BLUESKY_LEAD_ID);
      expect(items[1]['id']).toBe(DELTA_LEAD_ID);
      expect(items[2]['score']).toBe(50);
      // Tie-break is companyName ASC ⇒ "Apex Solutions Ltd" precedes "Echo Enterprises"
      expect(items[2]['id']).toBe(APEX_LEAD_ID);
      expect(items[2]['companyName']).toBe('Apex Solutions Ltd');
    }, 60_000);

    it('single field with `-` prefix (?sort=-score) routes through multi-field path', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { sort: '-score' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const scores = (res.body as JsonObject[]).map((l) => l['score'] as number);
      expect(scores).toEqual([80, 70, 50, 50, 20]);
    }, 60_000);

    it('single field without `-` or comma (?sort=status) uses backward-compat single-field path, ascending', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { sort: 'status' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const leads = res.body as JsonObject[];
      expect(leads.length).toBe(5);

      // Statuses must be in ascending (alphabetical) order
      const statuses = leads.map((l) => l['status'] as string);
      expect(statuses).toEqual(['CONTACTED', 'DISQUALIFIED', 'NEW', 'NEW', 'QUALIFIED']);

      // First lead is the sole CONTACTED entry: BlueSky
      expect(leads[0]['id']).toBe(BLUESKY_LEAD_ID);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Backward compatibility — legacy single-field sort
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Backward compatibility', () => {

    it('?sort=score&order=desc (no comma, no `-`) still uses the single-field path', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        sort: 'score',
        order: 'desc',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const scores = (res.body as JsonObject[]).map((l) => l['score'] as number);
      expect(scores).toEqual([80, 70, 50, 50, 20]);
    }, 60_000);

    it('?sort=score (no order param) defaults to ascending', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { sort: 'score' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const scores = (res.body as JsonObject[]).map((l) => l['score'] as number);
      expect(scores).toEqual([20, 50, 50, 70, 80]);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Array contains — `:contains` for array fields does membership
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Array contains operator', () => {

    it('?callIds:contains=<callId> returns the lead containing that call', async () => {
      // Create a fresh lead, then log a call against it so the lead's callIds
      // array is populated by the CallLogged → CallIdAppended cascade.
      const leadRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Array Contains Corp',
        contactName: 'Alice Contains',
        phone: '+61 2 9100 0010',
        email: 'alice@arraycontains.test',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(leadRes.status);
      const leadId = (leadRes.body as JsonObject)['id'] as string;

      const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED',
        durationSeconds: 60,
      });
      expect([200, 201]).toContain(callRes.status);
      const callId = (callRes.body as JsonObject)['id'] as string;

      // Verify the graph contains the lead with our callId in its array
      const leadNode = await getGraphNode(app.engineUrl, leadId);
      expect(leadNode).not.toBeNull();
      expect(leadNode!['callIds']).toContain(callId);

      // Query: ?callIds:contains=<callId> should return our lead
      const queryRes = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'callIds:contains': callId,
      });
      expect(queryRes.status).toBe(200);
      expect(Array.isArray(queryRes.body)).toBe(true);

      const matches = queryRes.body as JsonObject[];
      const matchedIds = matches.map((l) => l['id'] as string);
      expect(matchedIds).toContain(leadId);
    }, 60_000);

    it('?callIds:contains=<unknown-uuid> returns no leads', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'callIds:contains': '00000000-dead-0000-0000-000000000000',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as JsonObject[]).length).toBe(0);
    }, 60_000);

    it('?status:contains=NEW (string field) keeps the existing substring semantics', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'status:contains': 'NEW',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const leads = res.body as JsonObject[];
      // All leads with the substring 'NEW' in status are returned (APEX + ECHO).
      expect(leads.length).toBeGreaterThanOrEqual(2);
      for (const lead of leads) {
        expect(String(lead['status']).toLowerCase()).toContain('new');
      }
    }, 60_000);

    it('?callIds:contains isolates per-lead membership across multiple leads', async () => {
      // Create lead A + call A
      const leadARes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Isolate Corp A',
        contactName: 'AA',
        phone: '+61 2 9100 1001',
        email: 'aa@isolate.test',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(leadARes.status);
      const leadAId = (leadARes.body as JsonObject)['id'] as string;

      const callARes = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId: leadAId,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED',
        durationSeconds: 30,
      });
      expect([200, 201]).toContain(callARes.status);
      const callAId = (callARes.body as JsonObject)['id'] as string;

      // Create lead B + call B
      const leadBRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Isolate Corp B',
        contactName: 'BB',
        phone: '+61 2 9100 1002',
        email: 'bb@isolate.test',
        source: 'REFERRAL',
      });
      expect([200, 201]).toContain(leadBRes.status);
      const leadBId = (leadBRes.body as JsonObject)['id'] as string;

      const callBRes = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId: leadBId,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'CALLBACK_SCHEDULED',
        durationSeconds: 45,
      });
      expect([200, 201]).toContain(callBRes.status);
      const callBId = (callBRes.body as JsonObject)['id'] as string;

      // Querying for callA's id must surface only leadA — not leadB
      const queryA = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'callIds:contains': callAId,
      });
      expect(queryA.status).toBe(200);
      const matchedA = (queryA.body as JsonObject[]).map((l) => l['id'] as string);
      expect(matchedA).toContain(leadAId);
      expect(matchedA).not.toContain(leadBId);

      // And the reverse for callB
      const queryB = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'callIds:contains': callBId,
      });
      expect(queryB.status).toBe(200);
      const matchedB = (queryB.body as JsonObject[]).map((l) => l['id'] as string);
      expect(matchedB).toContain(leadBId);
      expect(matchedB).not.toContain(leadAId);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // arrayContains — strict array-only membership
  // ═══════════════════════════════════════════════════════════════════════════

  describe('arrayContains strict operator', () => {

    it('?callIds:arrayContains=<callId> returns the lead with that call in its array', async () => {
      // Create lead + call so callIds is populated.
      const leadRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'ArrayContains Strict Corp',
        contactName: 'Sam Strict',
        phone: '+61 2 9100 0020',
        email: 'sam@strict.test',
        source: 'REFERRAL',
      });
      expect([200, 201]).toContain(leadRes.status);
      const leadId = (leadRes.body as JsonObject)['id'] as string;

      const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED',
        durationSeconds: 90,
      });
      expect([200, 201]).toContain(callRes.status);
      const callId = (callRes.body as JsonObject)['id'] as string;

      const queryRes = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'callIds:arrayContains': callId,
      });
      expect(queryRes.status).toBe(200);
      expect(Array.isArray(queryRes.body)).toBe(true);

      const matchedIds = (queryRes.body as JsonObject[]).map((l) => l['id'] as string);
      expect(matchedIds).toContain(leadId);
    }, 60_000);

    it('?status:arrayContains=NEW returns zero results (status is a string, not an array)', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'status:arrayContains': 'NEW',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // Strict mode: a non-array field never matches arrayContains.
      expect((res.body as JsonObject[]).length).toBe(0);
    }, 60_000);

    it('?callIds:arrayContains=<unknown-uuid> returns no leads', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'callIds:arrayContains': '00000000-dead-0000-0000-000000000001',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as JsonObject[]).length).toBe(0);
    }, 60_000);
  });
});
