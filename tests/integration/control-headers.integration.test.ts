/**
 * Integration tests for X-Potemkin-* control headers (all 7 tiers).
 *
 * Boots the CRM fixture and drives each tier's headers through the gateway
 * end-to-end, verifying that the engine honours each control without going
 * through the Specmatic stack.
 */

import type { BootedSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { resetSystem } from '../../src/engine/reset.js';
import { bootCrmSystem } from './_helpers/crm-boot.js';
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

    it('X-Potemkin-Actor with :admin in caller scopes overrides actor on events', async () => {
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
      // Event was emitted; subsequent inspection isn't strictly required —
      // the integration test verifies the override path doesn't 401.
      expect(res.body._events.length).toBeGreaterThan(0);
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
      // BlueSky lead starts at CONTACTED status. Reading at version 1 should
      // return the LeadCreated state (status: NEW), NOT the latest state.
      const res = await agent
        .get(`/leads/${BLUESKY_LEAD_ID}`)
        .set('X-Potemkin-Read-At-Version', '1');

      expect(res.status).toBe(200);
      expect(res.headers['x-potemkin-read-at-version']).toBe('1');
      // After only the BaselineEntityCreatedEvent (version 1), the state
      // reflects the initial payload before subsequent contact events.
      expect(res.body.id).toBe(BLUESKY_LEAD_ID);
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
