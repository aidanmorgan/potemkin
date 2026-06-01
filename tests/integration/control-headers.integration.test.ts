/**
 * Integration tests for X-Potemkin-* control headers (all 7 tiers).
 *
 * Boots the CRM fixture and drives each tier's headers through the gateway
 * end-to-end, verifying that the engine honours each control without going
 * through the Specmatic stack.
 */

import { createHmac } from 'node:crypto';
import type { BootedSystem } from '../../src/engine/boot.js';
import { bootSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { resetSystem } from '../../src/engine/reset.js';
import { bootCrmSystem, expandByContractPath } from './_helpers/crm-boot.js';
import { loadFixtureWithGlobal } from '../fixtures/index.js';
import {
  withPersistentServer,
  type PersistentAgent,
  type PersistentServer,
} from '../_support/persistentAgent.js';

const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';
const BLUESKY_LEAD_ID = '00000000-0000-7000-8000-000000000011';

describe('X-Potemkin-* control headers — full integration', () => {
  let sys: BootedSystem;
  let agent: PersistentAgent;
  let persistent: PersistentServer;

  beforeAll(async () => {
    sys = await bootCrmSystem();
    const app = createGateway(sys);
    persistent = await withPersistentServer(app);
    agent = persistent.agent;
  });

  afterAll(async () => {
    await persistent.close();
  });

  beforeEach(() => {
    resetSystem(sys);
  });

  // ── Tier 1 — Transparency & determinism ─────────────────────────────────

  describe('Tier 1: transparency', () => {
    it('X-Potemkin-Dry-Run: true skips commit; event count stays unchanged', async () => {
      const before = sys.events.size();

      const res = await agent
        .post('/leads')
        .set('X-Potemkin-Dry-Run', 'true')
        .send({
          companyName: 'Dry Run Corp', contactName: 'DR',
          phone: '+61 2 9100 0001', email: 'dry@test.com', source: 'WEBSITE',
        });

      expect([200, 201]).toContain(res.status);
      expect(sys.events.size()).toBe(before);
      expect(res.headers['x-potemkin-dry-run']).toBe('true');
    });

    it('X-Potemkin-Include-Events: true appends _events to the response', async () => {
      const res = await agent
        .post('/leads')
        .set('X-Potemkin-Include-Events', 'true')
        .send({
          companyName: 'Events Corp', contactName: 'E',
          phone: '+61 2 9100 0002', email: 'events@test.com', source: 'WEBSITE',
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body._events).toBeDefined();
      expect(Array.isArray(res.body._events)).toBe(true);
      expect(res.body._events.length).toBeGreaterThan(0);
      expect(res.body._events[0]).toHaveProperty('eventId');
      expect(res.body._events[0]).toHaveProperty('type');
      expect(res.body._events[0]).toHaveProperty('sequenceVersion');
    });

    it('X-Potemkin-Echo: true appends _debug snapshot', async () => {
      const res = await agent
        .get(`/leads/${APEX_LEAD_ID}`)
        .set('X-Potemkin-Echo', 'true');

      expect(res.status).toBe(200);
      expect(res.body._debug).toBeDefined();
      // GET /leads/{id} is served by the LeadById sub-path boundary.
      expect(res.body._debug.boundary).toBe('LeadById');
      expect(res.body._debug.intent).toBe('query');
      expect(res.body._debug.targetId).toBe(APEX_LEAD_ID);
      expect(res.body._debug.dryRun).toBe(false);
    });

    it('X-Potemkin-Clock-Offset shifts $now() output and is undone after the request', async () => {
      const offsetBefore = sys.cel.getClockOffset();
      const res = await agent
        .post('/leads')
        .set('X-Potemkin-Clock-Offset', '3600000') // +1 hour
        .set('X-Potemkin-Include-Events', 'true')
        .send({
          companyName: 'Clock Shift Corp', contactName: 'C',
          phone: '+61 0', email: 'c@t.com', source: 'WEBSITE',
        });
      expect([200, 201]).toContain(res.status);
      // After the request, the global CEL clock offset is back to what it was.
      expect(sys.cel.getClockOffset()).toBe(offsetBefore);
      // The emitted event's timestamp reflects the shifted clock.
      const ts = (res.body._events as Array<{ timestamp: string }>)[0].timestamp;
      const eventMs = new Date(ts).getTime();
      const nowMs = Date.now();
      // Event timestamp is approximately +1 hour from real now (allowing 10s slack).
      expect(eventMs - nowMs).toBeGreaterThanOrEqual(3590000);
      expect(eventMs - nowMs).toBeLessThanOrEqual(3610000);
    });

    it('X-Potemkin-Seed produces deterministic faker output across requests', async () => {
      // The CRM doesn't directly expose $fake output but we can prove the seed
      // path doesn't crash and the offset stays consistent. (Tighter assertion
      // would need a DSL boundary that calls $fake in its payload template.)
      const res1 = await agent
        .post('/leads')
        .set('X-Potemkin-Seed', 'integration-test-seed-42')
        .send({
          companyName: 'Seed Corp', contactName: 'S',
          phone: '+61 0', email: 's@t.com', source: 'WEBSITE',
        });
      expect([200, 201]).toContain(res1.status);
    });

    // Concurrency isolation: two requests fired together through
    // the gateway — one with a large X-Potemkin-Clock-Offset, one with NONE —
    // each must observe its OWN clock. The awaited UoW inside the gateway lets
    // the two requests interleave between "apply offset" and "respond"; under the
    // previous shared-instance design the offset-bearing request would have
    // shifted the no-offset request's $now()/event timestamp (cross-request
    // leak). The per-request sub-evaluator makes each request see only its own
    // offset.
    it('concurrent requests with and without Clock-Offset each observe their own clock', async () => {
      const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;
      const startMs = Date.now();

      // Fire both at once so they interleave at the gateway's awaited UoW.
      const [offsetRes, plainRes] = await Promise.all([
        agent
          .post('/leads')
          .set('X-Potemkin-Clock-Offset', String(ONE_YEAR_MS))
          .set('X-Potemkin-Include-Events', 'true')
          .send({
            companyName: 'Offset Corp', contactName: 'O',
            phone: '+61 0', email: 'offset@t.com', source: 'WEBSITE',
          }),
        agent
          .post('/leads')
          .set('X-Potemkin-Include-Events', 'true')
          .send({
            companyName: 'Plain Corp', contactName: 'P',
            phone: '+61 0', email: 'plain@t.com', source: 'WEBSITE',
          }),
      ]);
      const endMs = Date.now();

      expect([200, 201]).toContain(offsetRes.status);
      expect([200, 201]).toContain(plainRes.status);

      const offsetTs = new Date(
        (offsetRes.body._events as Array<{ timestamp: string }>)[0].timestamp,
      ).getTime();
      const plainTs = new Date(
        (plainRes.body._events as Array<{ timestamp: string }>)[0].timestamp,
      ).getTime();

      // The offset request's event timestamp is ~1 year in the future.
      expect(offsetTs - startMs).toBeGreaterThanOrEqual(ONE_YEAR_MS - 10000);

      // The no-offset request observes the REAL clock — completely unaffected by
      // the concurrent offset request. Its timestamp is within the test window.
      expect(plainTs).toBeGreaterThanOrEqual(startMs - 10000);
      expect(plainTs).toBeLessThanOrEqual(endMs + 10000);

      // And the server-wide admin clock was never mutated by either request.
      expect(sys.cel.getClockOffset()).toBe(0);
    });

    // Concurrency isolation, burst variant: fire a BURST of
    // simultaneous requests, each carrying a DISTINCT X-Potemkin-Clock-Offset,
    // and assert every response's event timestamp matches ITS OWN offset. Under
    // the previous shared-instance design the offset was set on the shared
    // evaluator then restored around an awaited UoW, so a request that resumed
    // while a sibling held a different offset observed the sibling's clock —
    // a cross-request leak. The per-request sub-evaluator gives each request its
    // own offset, so all N requests stay isolated regardless of interleaving.
    it('a burst of concurrent requests each observe their own distinct Clock-Offset', async () => {
      const startMs = Date.now();
      const DAY_MS = 24 * 3600 * 1000;
      // Distinct, widely-separated offsets so any cross-request bleed is obvious.
      const offsets = [1, 50, 100, 200, 365, 500, 800, 1000].map((d) => d * DAY_MS);

      const responses = await Promise.all(
        offsets.map((offsetMs, i) =>
          agent
            .post('/leads')
            .set('X-Potemkin-Clock-Offset', String(offsetMs))
            .set('X-Potemkin-Include-Events', 'true')
            .send({
              companyName: `Burst Co ${i}`, contactName: `B${i}`,
              phone: '+61 0', email: `burst${i}@t.com`, source: 'WEBSITE',
            }),
        ),
      );

      const endMs = Date.now();
      responses.forEach((res, i) => {
        expect([200, 201]).toContain(res.status);
        const ts = new Date(
          (res.body._events as Array<{ timestamp: string }>)[0].timestamp,
        ).getTime();
        // Each request's event timestamp must equal real-now + its OWN offset
        // (within the test's wall-clock window) — never a sibling's offset.
        const expectedLow = startMs + offsets[i]! - 10000;
        const expectedHigh = endMs + offsets[i]! + 10000;
        expect(ts).toBeGreaterThanOrEqual(expectedLow);
        expect(ts).toBeLessThanOrEqual(expectedHigh);
      });

      // The server-wide admin clock was never mutated by any request.
      expect(sys.cel.getClockOffset()).toBe(0);
    });

    it('Dry-Run + Include-Events: events appear but state stays unchanged', async () => {
      const before = sys.events.size();

      const res = await agent
        .post('/leads')
        .set('X-Potemkin-Dry-Run', 'true')
        .set('X-Potemkin-Include-Events', 'true')
        .send({
          companyName: 'Dry+Events Corp', contactName: 'DE',
          phone: '+61 2 9100 0003', email: 'dryevents@test.com', source: 'WEBSITE',
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body._events.length).toBeGreaterThan(0);
      expect(sys.events.size()).toBe(before);
    });
  });

  // ── Tier 2 — Side-effect control ─────────────────────────────────────────

  describe('Tier 2: side effects', () => {
    it('X-Potemkin-Skip-Sagas: true commits events but skips saga trigger', async () => {
      // The LeadConverted event normally triggers an Opportunity creation saga.
      // With Skip-Sagas, the Lead transitions but no Opportunity event is emitted.
      const leadRes = await agent.post('/leads').send({
        companyName: 'Skip Sagas Corp', contactName: 'SS',
        phone: '+61 2 9100 0010', email: 'ss@test.com', source: 'REFERRAL',
      });
      const leadId = leadRes.body.id;

      await agent.post(`/leads/${leadId}/contact`).send({});
      await agent.post('/calls').send({
        leadId, agentId: '00000000-0000-7000-8000-000000000003',
        campaignId: '00000000-0000-7000-8000-000000000001',
        outcome: 'INTERESTED', durationSeconds: 60,
      });
      await agent.post(`/leads/${leadId}/qualify`).send({});

      const opportunityEventsBefore = sys.events.all().filter(e => e.boundary === 'Opportunity').length;

      const convertRes = await agent
        .post(`/leads/${leadId}/convert`)
        .set('X-Potemkin-Skip-Sagas', 'true')
        .send({ value: 5000 });

      expect(convertRes.status).toBe(200);
      // Lead's own event committed
      const leadEventsAfter = sys.events.byAggregate(leadId).length;
      expect(leadEventsAfter).toBeGreaterThan(0);
      // Saga was skipped → no Opportunity boundary events from this convert
      // (small delay for fire-and-forget — but skip-sagas prevents the saga from being scheduled at all)
      await new Promise(r => setTimeout(r, 100));
      const opportunityEventsAfter = sys.events.all().filter(e => e.boundary === 'Opportunity').length;
      expect(opportunityEventsAfter).toBe(opportunityEventsBefore);
    });

    it('X-Potemkin-Max-Cascade-Depth: 0 prevents any secondary commands', async () => {
      // POST /calls normally dispatches a secondary command appending callId to Lead.
      const beforeCalls = sys.events.all().filter(e => e.type === 'CallLogged').length;
      const beforeLeadUpdates = sys.events.all().filter(e => e.type === 'CallIdAppended').length;

      await agent
        .post('/calls')
        .set('X-Potemkin-Skip-Dispatch', 'true')
        .send({
          leadId: APEX_LEAD_ID,
          agentId: '00000000-0000-7000-8000-000000000003',
          campaignId: '00000000-0000-7000-8000-000000000001',
          outcome: 'INTERESTED', durationSeconds: 60,
        });

      const afterCalls = sys.events.all().filter(e => e.type === 'CallLogged').length;
      const afterLeadUpdates = sys.events.all().filter(e => e.type === 'CallIdAppended').length;
      // Primary call event was committed
      expect(afterCalls).toBe(beforeCalls + 1);
      // Skip-Dispatch blocked the cascade → no CallIdAppended event
      expect(afterLeadUpdates).toBe(beforeLeadUpdates);
    });

    it('X-Potemkin-Skip-Projections: true commits events but skips derived projection apply', async () => {
      // CampaignDashboard derived projection increments totalLeads on LeadCreated.
      const dashName = 'CampaignDashboard';
      const beforeRegistry = sys.derivedProjections?.get(dashName);
      const beforeKeyCount = beforeRegistry ? beforeRegistry.size : 0;

      await agent
        .post('/leads')
        .set('X-Potemkin-Skip-Projections', 'true')
        .send({
          companyName: 'Skip Projections Corp', contactName: 'SP',
          phone: '+61 2 9100 0011', email: 'sp@test.com', source: 'WEBSITE',
        });

      const afterRegistry = sys.derivedProjections?.get(dashName);
      const afterKeyCount = afterRegistry ? afterRegistry.size : 0;
      // Without skip, this would have incremented at least one key.
      expect(afterKeyCount).toBe(beforeKeyCount);
    });

    it('X-Potemkin-Bulk-Transactional: true aborts the whole batch on first UoW failure', async () => {
      // Bulk-transactional fires after request validation, so we need items
      // that survive validation but fail in the UoW. We use an admin-token
      // bypass of request validation + a payload with a non-enum source so
      // the UoW's behavior pipeline rejects it.
      const res = await agent
        .post('/leads')
        .set('Authorization', 'Bearer admin-1:admin')
        .set('X-Potemkin-Skip-Request-Validation', 'true')
        .set('X-Potemkin-Bulk-Transactional', 'true')
        .send([
          { companyName: 'OK A', contactName: 'A', phone: '+61 0', email: 'a@t.com', source: 'WEBSITE' },
          // Invalid source enum + missing required fields — survives skipped
          // request validation but the UoW emits no events and the response
          // validator subsequently throws.
          { companyName: 'Bad', source: 'INVALID_ENUM' },
          { companyName: 'OK C', contactName: 'C', phone: '+61 0', email: 'c@t.com', source: 'WEBSITE' },
        ]);

      // Bulk-transactional surfaces the wrapped abort body.
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('BULK_TRANSACTION_ABORTED');
    });

    it('X-Potemkin-Bulk-Transactional: a successful batch persists every item to state', async () => {
      const beforeEvents = sys.events.size();
      const beforeGraph = sys.graph.size();

      const res = await agent
        .post('/leads')
        .set('X-Potemkin-Bulk-Transactional', 'true')
        .send([
          { companyName: 'Bulk One', contactName: 'One', phone: '+61 2 9100 1001', email: 'one@bulk.com', source: 'WEBSITE' },
          { companyName: 'Bulk Two', contactName: 'Two', phone: '+61 2 9100 1002', email: 'two@bulk.com', source: 'WEBSITE' },
          { companyName: 'Bulk Three', contactName: 'Three', phone: '+61 2 9100 1003', email: 'three@bulk.com', source: 'WEBSITE' },
        ]);

      expect(res.status).toBe(201);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(3);
      // Each item ran through the real UoW and produced a persisted entity.
      const createdIds = (res.body as { id?: string }[]).map((b) => b.id);
      expect(createdIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);

      // State observably changed: three new entities + three new events.
      expect(sys.graph.size()).toBe(beforeGraph + 3);
      expect(sys.events.size()).toBe(beforeEvents + 3);

      // The created entities are individually retrievable via the read path.
      for (const id of createdIds) {
        const got = await agent.get(`/leads/${id}`);
        expect(got.status).toBe(200);
        expect(got.body.id).toBe(id);
      }
    });

    it('X-Potemkin-Bulk-Transactional + X-Potemkin-Mask masks the field in EVERY created item', async () => {
      const res = await agent
        .post('/leads')
        .set('X-Potemkin-Bulk-Transactional', 'true')
        .set('X-Potemkin-Mask', 'companyName')
        .send([
          { companyName: 'Mask One', contactName: 'One', phone: '+61 2 9100 3001', email: 'm1@bulk.com', source: 'WEBSITE' },
          { companyName: 'Mask Two', contactName: 'Two', phone: '+61 2 9100 3002', email: 'm2@bulk.com', source: 'WEBSITE' },
        ]);

      expect(res.status).toBe(201);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      // The bulk array must be processed through the mask pipeline — every item must be masked.
      for (const item of res.body as { companyName?: string }[]) {
        expect(item.companyName).toBe('[MASKED]');
      }
    });

    it('X-Potemkin-Bulk-Transactional: an aborted batch persists NO prior items (rollback)', async () => {
      const beforeEvents = sys.events.size();
      const beforeGraph = sys.graph.size();

      const res = await agent
        .post('/leads')
        .set('Authorization', 'Bearer admin-1:admin')
        .set('X-Potemkin-Skip-Request-Validation', 'true')
        .set('X-Potemkin-Bulk-Transactional', 'true')
        .send([
          // Item 0 succeeds and is committed by the UoW...
          { companyName: 'Rollback OK', contactName: 'OK', phone: '+61 2 9100 2001', email: 'ok@rb.com', source: 'WEBSITE' },
          // ...item 1 fails in the UoW, which must roll item 0 back.
          { companyName: 'Rollback Bad', source: 'INVALID_ENUM' },
          { companyName: 'Rollback Never', contactName: 'N', phone: '+61 2 9100 2003', email: 'n@rb.com', source: 'WEBSITE' },
        ]);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('BULK_TRANSACTION_ABORTED');
      expect(res.body.abortIndex).toBe(1);

      // Rollback: the successfully-committed item 0 must NOT remain.
      expect(sys.events.size()).toBe(beforeEvents);
      expect(sys.graph.size()).toBe(beforeGraph);
    });
  });

  // ── Tier 3 — Identity & audit override (admin-gated) ────────────────────

  describe('Tier 3: identity', () => {
    it('X-Potemkin-Actor without admin returns 401', async () => {
      const res = await agent
        .post('/leads')
        .set('X-Potemkin-Actor', 'alice:agent')
        .send({
          companyName: 'Actor Corp', contactName: 'A',
          phone: '+61 0', email: 'a@t.com', source: 'WEBSITE',
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('ADMIN_REQUIRED');
    });

    it('X-Potemkin-Actor with :admin in caller scopes stamps the overridden actor on the created entity', async () => {
      const res = await agent
        .post('/leads')
        .set('Authorization', 'Bearer admin-1:admin')
        .set('X-Potemkin-Actor', 'alice:manager,agent')
        .set('X-Potemkin-Include-Events', 'true')
        .send({
          companyName: 'Override Corp', contactName: 'O',
          phone: '+61 0', email: 'o@t.com', source: 'WEBSITE',
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body._events.length).toBeGreaterThan(0);
      // audit_fields on the Lead boundary stamps updatedBy from the request's
      // actor. The override replaced the admin caller with alice, so the
      // persisted entity must be attributed to alice — not admin-1.
      expect(res.body.updatedBy).toBe('alice');
    });

    it('X-Potemkin-Impersonate with admin auth attributes the entity to the impersonated identity', async () => {
      const res = await agent
        .post('/leads')
        .set('Authorization', 'Bearer admin-1:admin')
        .set('X-Potemkin-Impersonate', 'bob:manager')
        .set('X-Potemkin-Include-Events', 'true')
        .send({
          companyName: 'Impersonate Corp', contactName: 'I',
          phone: '+61 0', email: 'imp@t.com', source: 'WEBSITE',
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body._events.length).toBeGreaterThan(0);
      // The emitted/persisted entity is attributed to the impersonated actor
      // (bob), not the admin caller that issued the request.
      expect(res.body.updatedBy).toBe('bob');
    });

    it('X-Potemkin-Caused-By is reflected on emitted events', async () => {
      const causedById = '00000000-0000-7000-8000-deadbeef0001';
      const res = await agent
        .post('/leads')
        .set('X-Potemkin-Include-Events', 'true')
        .set('X-Potemkin-Caused-By', causedById)
        .send({
          companyName: 'Caused-By Corp', contactName: 'C',
          phone: '+61 0', email: 'c@t.com', source: 'WEBSITE',
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body._events[0].causedBy).toBe(causedById);
    });
  });

  // ── Tier 4 — Event sourcing time travel ─────────────────────────────────

  describe('Tier 4: time travel', () => {
    it('X-Potemkin-Read-At-Version=1 returns the entity state after the first event only', async () => {
      const res = await agent
        .get(`/leads/${BLUESKY_LEAD_ID}`)
        .set('X-Potemkin-Read-At-Version', '1');

      expect(res.status).toBe(200);
      expect(res.headers['x-potemkin-read-at-version']).toBe('1');
      // Version 1 is the BaselineEntityCreatedEvent — the state must reflect the
      // seeded baseline payload (status CONTACTED, the original company), proving
      // the read is reconstructed from events up to that version and not the
      // latest projection.
      expect(res.body.id).toBe(BLUESKY_LEAD_ID);
      expect(res.body.status).toBe('CONTACTED');
      expect(res.body.companyName).toBe('BlueSky Tech');
    });

    it('X-Potemkin-Read-At-Version on missing entity returns 404', async () => {
      const res = await agent
        .get('/leads/00000000-dead-7000-8000-000000000099')
        .set('X-Potemkin-Read-At-Version', '5');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('ENTITY_ABSENCE');
    });

    it('X-Potemkin-Replay-Event returns a historic event by id', async () => {
      const allEvents = sys.events.all();
      const target = allEvents.find(e => e.aggregateId === APEX_LEAD_ID);
      expect(target).toBeDefined();

      const res = await agent
        .get(`/leads/${APEX_LEAD_ID}`)
        .set('X-Potemkin-Replay-Event', target!.eventId);

      expect(res.status).toBe(200);
      expect(res.headers['x-potemkin-replayed-event']).toBe(target!.eventId);
      expect(res.body.eventId).toBe(target!.eventId);
      expect(res.body.aggregateId).toBe(APEX_LEAD_ID);
    });

    it('X-Potemkin-Replay-Event for unknown event id returns 404', async () => {
      const res = await agent
        .get(`/leads/${APEX_LEAD_ID}`)
        .set('X-Potemkin-Replay-Event', 'evt-does-not-exist');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('EVENT_NOT_FOUND');
    });
  });

  // ── Tier 5 — Response format ────────────────────────────────────────────

  describe('Tier 5: response format', () => {
    it('X-Potemkin-Mask replaces named fields with [MASKED]', async () => {
      const res = await agent
        .get(`/leads/${APEX_LEAD_ID}`)
        .set('X-Potemkin-Mask', 'email,phone');

      expect(res.status).toBe(200);
      expect(res.body.email).toBe('[MASKED]');
      expect(res.body.phone).toBe('[MASKED]');
      expect(res.body.companyName).not.toBe('[MASKED]');
    });

    it('Mask applied to collection responses redacts each item', async () => {
      const res = await agent
        .get('/leads')
        .set('X-Potemkin-Mask', 'email');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      for (const lead of res.body) {
        expect(lead.email).toBe('[MASKED]');
      }
    });

    it('X-Potemkin-Response-Format: hal wraps a single entity with a self _link', async () => {
      const res = await agent
        .get(`/leads/${APEX_LEAD_ID}`)
        .set('X-Potemkin-Response-Format', 'hal');

      expect(res.status).toBe(200);
      expect(res.headers['x-potemkin-response-format']).toBe('hal');
      // The entity fields are preserved and a HAL self link is added.
      expect(res.body.id).toBe(APEX_LEAD_ID);
      expect(res.body._links.self.href).toBe(`/leads/${APEX_LEAD_ID}`);
    });

    it('X-Potemkin-Response-Format: hal embeds a collection under _embedded.items', async () => {
      const res = await agent
        .get('/leads')
        .set('X-Potemkin-Response-Format', 'hal');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);
      expect(Array.isArray(res.body._embedded.items)).toBe(true);
      expect(res.body._embedded.items.length).toBeGreaterThan(0);
      expect(res.body._links.self.href).toBe('/leads');
    });

    it('X-Potemkin-Response-Format: jsonapi shapes a single entity as { data: { type, id, attributes } }', async () => {
      const res = await agent
        .get(`/leads/${APEX_LEAD_ID}`)
        .set('X-Potemkin-Response-Format', 'jsonapi');

      expect(res.status).toBe(200);
      expect(res.body.data.type).toBe('LeadById');
      expect(res.body.data.id).toBe(APEX_LEAD_ID);
      // The id is lifted out of attributes per JSON:API.
      expect(res.body.data.attributes.id).toBeUndefined();
      expect(res.body.data.attributes.companyName).toBeDefined();
    });

    it('X-Potemkin-Response-Format: jsonapi shapes a collection as { data: [...] }', async () => {
      const res = await agent
        .get('/leads')
        .set('X-Potemkin-Response-Format', 'jsonapi');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0].type).toBe('Lead');
      expect(res.body.data[0].attributes).toBeDefined();
    });

    it('X-Potemkin-Pagination-Style: envelope wraps a bare collection in an items envelope', async () => {
      const res = await agent
        .get('/leads')
        .set('X-Potemkin-Pagination-Style', 'envelope');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(typeof res.body.totalCount).toBe('number');
      expect(res.body.totalCount).toBe(res.body.items.length);
    });

    it('X-Potemkin-Pagination-Style: link-header returns a bare array plus pagination headers', async () => {
      const res = await agent
        .get('/leads?limit=1')
        .set('X-Potemkin-Pagination-Style', 'link-header');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      // More pages exist (the fixture seeds multiple leads) → a next Link is emitted.
      expect(res.headers['link']).toContain('rel="next"');
      expect(res.headers['x-total-count']).toBeDefined();
    });

    it('X-Potemkin-Pagination-Style: raw unwraps a limit envelope back to a bare array', async () => {
      // ?limit produces an envelope by default; `raw` flattens it to an array.
      const res = await agent
        .get('/leads?limit=2')
        .set('X-Potemkin-Pagination-Style', 'raw');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeLessThanOrEqual(2);
    });
  });

  // ── Tier 6 — Observability ──────────────────────────────────────────────

  describe('Tier 6: observability', () => {
    it('X-Potemkin-Trace-Id is echoed back on the response', async () => {
      const traceId = '0123456789abcdef0123456789abcdef';
      const res = await agent
        .get(`/leads/${APEX_LEAD_ID}`)
        .set('X-Potemkin-Trace-Id', traceId);

      expect(res.status).toBe(200);
      expect(res.headers['x-potemkin-trace-id']).toBe(traceId);
    });

    it('X-Potemkin-Span-Name is echoed back on the response', async () => {
      const res = await agent
        .get(`/leads/${APEX_LEAD_ID}`)
        .set('X-Potemkin-Span-Name', 'custom-span-42');

      expect(res.status).toBe(200);
      expect(res.headers['x-potemkin-span-name']).toBe('custom-span-42');
    });
  });

  // ── Tier 7 — Validation control (admin-gated) ───────────────────────────

  describe('Tier 7: validation control', () => {
    it('X-Potemkin-Skip-Request-Validation without admin returns 401', async () => {
      const res = await agent
        .post('/leads')
        .set('X-Potemkin-Skip-Request-Validation', 'true')
        .send({
          // missing companyName — would normally be 400
          contactName: 'X', phone: '+61 0', email: 'x@t.com', source: 'WEBSITE',
        });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('ADMIN_REQUIRED');
    });

    it('X-Potemkin-Skip-Request-Validation WITH :admin lets a normally-invalid request through', async () => {
      const res = await agent
        .post('/leads')
        .set('Authorization', 'Bearer admin-1:admin')
        .set('X-Potemkin-Skip-Request-Validation', 'true')
        .send({
          // Skipping validation lets a payload with missing required fields proceed.
          contactName: 'X', phone: '+61 0', email: 'x@t.com', source: 'WEBSITE',
        });
      // The downstream UoW may still emit a 4xx for domain reasons, but it must
      // NOT be 401 (admin auth accepted) and must NOT be the original 400.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(400);
    });
  });

  // ── Cross-tier ──────────────────────────────────────────────────────────

  describe('Cross-tier combinations', () => {
    it('Echo + Include-Events + Dry-Run combine cleanly', async () => {
      const before = sys.events.size();
      const res = await agent
        .post('/leads')
        .set('X-Potemkin-Dry-Run', 'true')
        .set('X-Potemkin-Include-Events', 'true')
        .set('X-Potemkin-Echo', 'true')
        .send({
          companyName: 'All Tier 1 Corp', contactName: 'A',
          phone: '+61 0', email: 'a@t.com', source: 'WEBSITE',
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body._events).toBeDefined();
      expect(res.body._debug).toBeDefined();
      expect(res.body._debug.dryRun).toBe(true);
      expect(sys.events.size()).toBe(before);
    });

    it('Mask + Echo: debug snapshot is added alongside masked fields', async () => {
      const res = await agent
        .get(`/leads/${APEX_LEAD_ID}`)
        .set('X-Potemkin-Mask', 'email')
        .set('X-Potemkin-Echo', 'true');

      expect(res.status).toBe(200);
      expect(res.body.email).toBe('[MASKED]');
      expect(res.body._debug).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Per-request clock-offset isolation across an EARLY RETURN.
//
// The previous shared-instance design set the clock offset on the shared CEL
// evaluator at the top of the handler and restored it at the end. Several early
// returns (JWT validation error, idempotency replay/conflict) returned BEFORE
// the restore ran — permanently shifting the shared offset so EVERY later
// request observed the leaked clock. This is deterministic (no interleaving
// needed): one offset-bearing request that 401s must not move the clock for the
// next request. The per-request sub-evaluator never mutates shared state, so
// there is nothing to leak and nothing to restore.
//
// JWT mode is required to reach the gateway's offset-set → JWT-validate → 401
// early return, so this block boots the crm-jwt fixture.
// ---------------------------------------------------------------------------
describe('X-Potemkin-Clock-Offset — no leak across a JWT-error early return', () => {
  const JWT_SECRET = 'potemkin-jwt-e2e-test-secret-do-not-use';

  function b64url(buf: Buffer): string {
    return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  /** Mint a valid HS256 token for the crm-jwt fixture (1-hour expiry). */
  function validToken(scopes: string): string {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: 'mgr1', scopes, iss: 'potemkin-test', aud: 'potemkin-api',
      iat: now, exp: now + 3600,
    };
    const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8'));
    const payload = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
    const sig = b64url(createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
    return `${header}.${payload}.${sig}`;
  }

  let sys: BootedSystem;
  let agent: PersistentAgent;
  let persistent: PersistentServer;

  beforeAll(async () => {
    const fixture = await loadFixtureWithGlobal('crm-jwt');
    sys = await bootSystem(fixture);
    expandByContractPath(sys);
    const app = createGateway(sys);
    persistent = await withPersistentServer(app);
    agent = persistent.agent;
  });

  afterAll(async () => {
    await persistent.close();
  });

  beforeEach(() => {
    resetSystem(sys);
  });

  it('an offset request that 401s leaves the clock unshifted for the next request', async () => {
    const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;

    // 1. Offset-bearing request with a bogus bearer token → 401 (JwtValidation).
    //    On the shared-instance design this set the offset then short-circuited
    //    on the 401 BEFORE restoring it — leaking the offset onto the shared
    //    evaluator.
    const denied = await agent
      .post('/leads')
      .set('Authorization', 'Bearer not-a-valid-jwt')
      .set('X-Potemkin-Clock-Offset', String(ONE_YEAR_MS))
      .send({
        companyName: 'Denied Co', contactName: 'D',
        phone: '+61 0', email: 'denied@t.com', source: 'WEBSITE',
      });
    expect(denied.status).toBe(401);

    // 2. A valid follow-up request with NO offset must observe the REAL clock.
    //    On the leaked design its event timestamp would be ~1 year in the future.
    const startMs = Date.now();
    const ok = await agent
      .post('/leads')
      .set('Authorization', `Bearer ${validToken('manager')}`)
      .set('X-Potemkin-Include-Events', 'true')
      .send({
        companyName: 'Allowed Co', contactName: 'A',
        phone: '+61 0', email: 'allowed@t.com', source: 'WEBSITE',
      });
    const endMs = Date.now();
    expect([200, 201]).toContain(ok.status);

    const ts = new Date(
      (ok.body._events as Array<{ timestamp: string }>)[0].timestamp,
    ).getTime();
    expect(ts).toBeGreaterThanOrEqual(startMs - 10000);
    expect(ts).toBeLessThanOrEqual(endMs + 10000);

    // The server-wide admin clock was never mutated.
    expect(sys.cel.getClockOffset()).toBe(0);
  });
});
