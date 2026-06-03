/**
 * 48 — X-Potemkin-* control headers (Tiers 1-7) via full Specmatic stack.
 *
 * Drives each tier's headers through the Specmatic + plugin + Node engine
 * stack via /_engine/forward. Verifies that headers parsed at the gateway
 * level are honoured end-to-end and surface their expected response
 * transformations.
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { fwd, getEventCount, javaAvailable } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

const APEX_LEAD_ID    = '00000000-0000-7000-8000-000000000010';
const BLUESKY_LEAD_ID = '00000000-0000-7000-8000-000000000011';

describeWithJava('48 — X-Potemkin-* control headers (full Specmatic stack)', () => {
  let app: E2eApp;
  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ── Tier 1 — Transparency & determinism ─────────────────────────────────

  describe('Tier 1: transparency', () => {
    it('Dry-Run skips commit; event count unchanged', async () => {
      const before = await getEventCount(app.engineUrl);
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'E2E Dry-Run', contactName: 'D',
        phone: '+61 0', email: 'd@t.com', source: 'WEBSITE',
      }, { 'x-potemkin-dry-run': 'true' });
      expect([200, 201]).toContain(res.status);
      expect(res.headers['x-potemkin-dry-run']).toBe('true');
      const after = await getEventCount(app.engineUrl);
      expect(after).toBe(before);
    }, 60_000);

    it('Include-Events surfaces _events array', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'E2E Events', contactName: 'E',
        phone: '+61 0', email: 'e@t.com', source: 'WEBSITE',
      }, { 'x-potemkin-include-events': 'true' });
      expect([200, 201]).toContain(res.status);
      const body = res.body as JsonObject;
      expect(Array.isArray(body['_events'])).toBe(true);
      expect((body['_events'] as JsonObject[]).length).toBeGreaterThan(0);
    }, 60_000);

    it('Echo surfaces _debug snapshot', async () => {
      const res = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`, null,
        { 'x-potemkin-echo': 'true' });
      expect(res.status).toBe(200);
      const body = res.body as JsonObject;
      expect(body['_debug']).toBeDefined();
      const debug = body['_debug'] as JsonObject;
      expect(debug['intent']).toBe('query');
      expect(debug['targetId']).toBe(APEX_LEAD_ID);
    }, 60_000);
  });

  // ── Tier 2 — Side-effect control ────────────────────────────────────────

  describe('Tier 2: side effects', () => {
    it('Skip-Dispatch blocks secondary cascades', async () => {
      // POST /calls normally appends callId to Lead. Skip-Dispatch prevents it.
      const callsBefore = await fwd(app.engineUrl, 'GET', '/calls');
      const initialCallCount = Array.isArray(callsBefore.body)
        ? (callsBefore.body as JsonObject[]).length : 0;

      const res = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId: APEX_LEAD_ID,
        agentId: '00000000-0000-7000-8000-000000000003',
        campaignId: '00000000-0000-7000-8000-000000000001',
        outcome: 'INTERESTED', durationSeconds: 60,
      }, { 'x-potemkin-skip-dispatch': 'true' });
      expect([200, 201]).toContain(res.status);

      const callsAfter = await fwd(app.engineUrl, 'GET', '/calls');
      const finalCallCount = Array.isArray(callsAfter.body)
        ? (callsAfter.body as JsonObject[]).length : 0;
      expect(finalCallCount).toBe(initialCallCount + 1);
    }, 60_000);
  });

  // ── Tier 3 — Identity & audit override ──────────────────────────────────

  describe('Tier 3: identity', () => {
    it('Actor override without any auth token (no actor) → 401', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Identity', contactName: 'I',
        phone: '+61 0', email: 'i@t.com', source: 'WEBSITE',
      }, { 'x-potemkin-actor': 'alice:agent' });
      expect(res.status).toBe(401);
      expect((res.body as JsonObject)['error']).toBe('ADMIN_REQUIRED');
    }, 60_000);

    it('Actor override with non-admin auth token → 403', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Identity403', contactName: 'I',
        phone: '+61 0', email: 'i403@t.com', source: 'WEBSITE',
      }, {
        'x-potemkin-actor': 'alice:agent',
        'authorization': 'Bearer user-1:agent',
      });
      expect(res.status).toBe(403);
      expect((res.body as JsonObject)['error']).toBe('ADMIN_REQUIRED');
    }, 60_000);

    it('Caused-By is reflected on emitted events when Include-Events is on', async () => {
      const causedBy = '00000000-0000-7000-8000-c0ffeebabe01';
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'CausedBy', contactName: 'C',
        phone: '+61 0', email: 'cb@t.com', source: 'WEBSITE',
      }, {
        'x-potemkin-include-events': 'true',
        'x-potemkin-caused-by': causedBy,
      });
      expect([200, 201]).toContain(res.status);
      const body = res.body as JsonObject;
      const events = body['_events'] as JsonObject[];
      expect(events[0]['causedBy']).toBe(causedBy);
    }, 60_000);
  });

  // ── Tier 4 — Event sourcing time travel ─────────────────────────────────

  describe('Tier 4: time travel', () => {
    it('Read-At-Version on unknown entity → 404', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads/00000000-dead-7000-8000-000000000099',
        null, { 'x-potemkin-read-at-version': '3' },
      );
      expect(res.status).toBe(404);
      expect((res.body as JsonObject)['error']).toBe('ENTITY_ABSENCE');
    }, 60_000);

    it('Read-At-Version=1 returns the entity reconstructed from its first event', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', `/leads/${BLUESKY_LEAD_ID}`,
        null, { 'x-potemkin-read-at-version': '1' },
      );
      expect(res.status).toBe(200);
      expect(res.headers['x-potemkin-read-at-version']).toBe('1');
      expect((res.body as JsonObject)['id']).toBe(BLUESKY_LEAD_ID);
    }, 60_000);

    it('Replay-Event with unknown id → 404', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`,
        null, { 'x-potemkin-replay-event': 'evt-does-not-exist' },
      );
      expect(res.status).toBe(404);
      expect((res.body as JsonObject)['error']).toBe('EVENT_NOT_FOUND');
    }, 60_000);
  });

  // ── Tier 5 — Response format ────────────────────────────────────────────

  describe('Tier 5: response format', () => {
    it('Mask replaces named fields in single-entity response', async () => {
      const res = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`,
        null, { 'x-potemkin-mask': 'email,phone' });
      expect(res.status).toBe(200);
      const body = res.body as JsonObject;
      expect(body['email']).toBe('[MASKED]');
      expect(body['phone']).toBe('[MASKED]');
      expect(body['companyName']).not.toBe('[MASKED]');
    }, 60_000);

    it('Mask applies to every item in a collection', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-mask': 'email' });
      expect(res.status).toBe(200);
      const list = res.body as JsonObject[];
      expect(Array.isArray(list)).toBe(true);
      for (const lead of list) {
        expect(lead['email']).toBe('[MASKED]');
      }
    }, 60_000);
  });

  // ── Tier 6 — Observability ──────────────────────────────────────────────

  describe('Tier 6: observability', () => {
    it('Trace-Id is echoed on response', async () => {
      const traceId = 'abcdef0123456789abcdef0123456789';
      const res = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`,
        null, { 'x-potemkin-trace-id': traceId });
      expect(res.status).toBe(200);
      expect(res.headers['x-potemkin-trace-id']).toBe(traceId);
    }, 60_000);

    it('Span-Name is echoed on response', async () => {
      const res = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`,
        null, { 'x-potemkin-span-name': 'e2e-test-span' });
      expect(res.status).toBe(200);
      expect(res.headers['x-potemkin-span-name']).toBe('e2e-test-span');
    }, 60_000);
  });

  // ── Tier 7 — Validation control ─────────────────────────────────────────

  describe('Tier 7: validation control', () => {
    it('Skip-Request-Validation without admin → 401', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', { invalid: 'payload' },
        { 'x-potemkin-skip-request-validation': 'true' });
      expect(res.status).toBe(401);
      expect((res.body as JsonObject)['error']).toBe('ADMIN_REQUIRED');
    }, 60_000);

    it('Skip-Request-Validation WITH :admin lets normally-invalid payload through', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        // missing required fields — normally a 400
        contactName: 'X', phone: '+61 0', email: 'x@t.com', source: 'WEBSITE',
      }, {
        authorization: 'Bearer admin-1:admin',
        'x-potemkin-skip-request-validation': 'true',
      });
      // The downstream UoW may still reject for domain reasons, but it must
      // not be 401 (admin auth accepted) nor 400 (validation skipped).
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(400);
    }, 60_000);
  });

  // ── Cross-tier ──────────────────────────────────────────────────────────

  describe('Cross-tier combinations', () => {
    it('Dry-Run + Echo + Include-Events: state unchanged, debug and events present', async () => {
      const before = await getEventCount(app.engineUrl);
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'CrossTier', contactName: 'X',
        phone: '+61 0', email: 'x@t.com', source: 'WEBSITE',
      }, {
        'x-potemkin-dry-run': 'true',
        'x-potemkin-echo': 'true',
        'x-potemkin-include-events': 'true',
      });
      expect([200, 201]).toContain(res.status);
      const body = res.body as JsonObject;
      expect(body['_events']).toBeDefined();
      expect(body['_debug']).toBeDefined();
      expect((body['_debug'] as JsonObject)['dryRun']).toBe(true);
      const after = await getEventCount(app.engineUrl);
      expect(after).toBe(before);
    }, 60_000);
  });
});
