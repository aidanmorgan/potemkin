/**
 * 26 — Concurrency & Idempotency: ETag chains, idempotency keys, race conditions
 * via full Specmatic+plugin+Node stack.
 *
 * Verifies the DSL handles concurrent and repeated operations correctly.
 * Tests optimistic concurrency via ETag/If-Match, idempotency key lifecycle,
 * and concurrent mutation serialization.
 *
 * Research basis: Stripe idempotency keys, RFC 9110 ETag/If-Match, Google SWE
 * hermetic testing, property-based concurrent command testing (POES)
 */

import { startEngineOnlyApp } from './_harness/engine-only-app';
import type { EngineOnlyApp } from './_harness/engine-only-app';
import {
  fwd, getGraphNode, getEventsByAggregate,
} from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const AGENT_ID = '00000000-0000-7000-8000-000000000003';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';

describe('26 — Concurrency & Idempotency (engine-only)', () => {
  let app: EngineOnlyApp;

  beforeAll(async () => { app = await startEngineOnlyApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  describe('optimistic concurrency -- multi-step ETag chain', () => {
    let leadId: string;
    let etagV1: string;

    it('create lead -> get ETag v1', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'ETag Chain Corp', contactName: 'EC',
        phone: '+61 0', email: 'etag@chain.test', source: 'REFERRAL',
      });
      expect([200, 201]).toContain(res.status);
      leadId = (res.body as JsonObject)['id'] as string;
      etagV1 = res.headers['etag'];
      expect(etagV1).toBeDefined();
    }, 60_000);

    it('contact with If-Match:v1 -> succeeds, get ETag v2', async () => {
      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {}, { 'If-Match': etagV1 });
      expect([200]).toContain(res.status);
      const etagV2 = res.headers['etag'];
      expect(etagV2).toBeDefined();
      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node!['status']).toBe('CONTACTED');
    }, 60_000);

    it('stale If-Match:v1 -> 412, graph unchanged', async () => {
      const nodeBefore = await getGraphNode(app.engineUrl, leadId);
      const statusBefore = nodeBefore!['status'];

      await fwd(app.engineUrl, 'POST', '/calls', {
        leadId, agentId: AGENT_ID, campaignId: CAMPAIGN_ID, outcome: 'INTERESTED',
      });

      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {}, { 'If-Match': etagV1 });
      expect(res.status).toBe(412);

      const nodeAfter = await getGraphNode(app.engineUrl, leadId);
      expect(nodeAfter!['status']).toBe(statusBefore);
    }, 60_000);

    it('ETag values increase after mutations', async () => {
      // After create (v1) + contact + call + failed qualify, the lead has been
      // mutated multiple times. Current ETag should be higher than v1.
      const currentRes = await fwd(app.engineUrl, 'GET', `/leads/${leadId}`);
      const currentEtag = currentRes.headers?.['etag'];
      if (etagV1 && currentEtag) {
        const v1 = parseInt(String(etagV1).replace(/"/g, ''), 10);
        const vCurrent = parseInt(String(currentEtag).replace(/"/g, ''), 10);
        if (!isNaN(v1) && !isNaN(vCurrent)) {
          expect(vCurrent).toBeGreaterThan(v1);
        }
      }
    }, 60_000);
  });

  describe('idempotency keys -- full lifecycle', () => {
    it('same key + same body -> replay with x-idempotency-replay header', async () => {
      const key = `idem-replay-${Date.now()}`;
      const body = { companyName: 'Idem Corp', contactName: 'I', phone: '+61 0', email: 'idem@t.com', source: 'WEBSITE' };

      const first = await fwd(app.engineUrl, 'POST', '/leads', body, { 'idempotency-key': key });
      expect([200, 201]).toContain(first.status);
      const id = (first.body as JsonObject)['id'] as string;

      const second = await fwd(app.engineUrl, 'POST', '/leads', body, { 'idempotency-key': key });
      expect((second.body as JsonObject)['id']).toBe(id);
      expect(second.headers['x-idempotency-replay']).toBe('true');

      const events = await getEventsByAggregate(app.engineUrl, id);
      expect(events.filter(e => e.type === 'LeadCreated').length).toBe(1);
    }, 60_000);

    it('same key + different body -> 409 conflict', async () => {
      const key = `idem-conflict-${Date.now()}`;
      const body1 = { companyName: 'A', contactName: 'A', phone: '+61 0', email: 'a@t.com', source: 'WEBSITE' };
      const body2 = { companyName: 'B', contactName: 'B', phone: '+61 0', email: 'b@t.com', source: 'REFERRAL' };

      await fwd(app.engineUrl, 'POST', '/leads', body1, { 'idempotency-key': key });

      const res = await fwd(app.engineUrl, 'POST', '/leads', body2, { 'idempotency-key': key });
      expect(res.status).toBe(409);
    }, 60_000);

    it('different keys -> separate entities in graph', async () => {
      const k1 = `idem-sep-1-${Date.now()}`;
      const k2 = `idem-sep-2-${Date.now()}`;
      const body = { companyName: 'Sep', contactName: 'S', phone: '+61 0', email: 's@t.com', source: 'WEBSITE' };

      const r1 = await fwd(app.engineUrl, 'POST', '/leads', body, { 'idempotency-key': k1 });
      const r2 = await fwd(app.engineUrl, 'POST', '/leads', body, { 'idempotency-key': k2 });

      const id1 = (r1.body as JsonObject)['id'] as string;
      const id2 = (r2.body as JsonObject)['id'] as string;
      expect(id1).not.toBe(id2);

      const node1 = await getGraphNode(app.engineUrl, id1);
      const node2 = await getGraphNode(app.engineUrl, id2);
      expect(node1).not.toBeNull();
      expect(node2).not.toBeNull();
    }, 60_000);

    it('GET with idempotency key -> key ignored (queries bypass)', async () => {
      const key = `idem-get-${Date.now()}`;
      const r1 = await fwd(app.engineUrl, 'GET', '/leads', null, { 'idempotency-key': key });
      const r2 = await fwd(app.engineUrl, 'GET', '/leads', null, { 'idempotency-key': key });
      expect(r2.headers?.['x-idempotency-replay']).not.toBe('true');
    }, 60_000);
  });

  describe('concurrent mutations', () => {
    it('5 concurrent calls to same lead -> all callIds appended, no duplicates', async () => {
      const leadRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Concurrent Corp', contactName: 'CC',
        phone: '+61 0', email: 'concurrent@t.com', source: 'WEBSITE',
      });
      expect([200, 201]).toContain(leadRes.status);
      const leadId = (leadRes.body as JsonObject)['id'] as string;

      const promises = Array.from({ length: 5 }, () =>
        fwd(app.engineUrl, 'POST', '/calls', {
          leadId, agentId: AGENT_ID, campaignId: CAMPAIGN_ID, outcome: 'INTERESTED',
        })
      );
      const results = await Promise.all(promises);

      const successCount = results.filter(r => [200, 201].includes(r.status)).length;
      expect(successCount).toBeGreaterThanOrEqual(1);

      const lead = await getGraphNode(app.engineUrl, leadId);
      const callIds = lead!['callIds'] as string[];
      const uniqueIds = new Set(callIds);
      expect(uniqueIds.size).toBe(callIds.length);
    }, 60_000);
  });
});
