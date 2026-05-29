/**
 * 30 — Fault Injection: DSL-driven fault injection via the full
 * Specmatic+plugin+Node stack.
 *
 * Tests the DSL-integrated fault injection system that uses the same
 * condition matching (CEL expressions, intent, requires guards) as behaviors
 * but produces HTTP error responses instead of state mutations.
 *
 * Three tiers tested:
 *   1. Dynamic fault rules (runtime, via POST /_admin/faults)
 *   2. YAML-defined boundary faults (static, in boundary YAML)
 *   3. YAML-defined global faults (static, in global.yaml)
 *
 * Also tests: fault priority ordering, graph immutability under faults,
 * event count unchanged, delay injection, probabilistic faults,
 * backward compat with x-specmatic-fault header.
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd, getGraphNode, getEntityCount, getEventCount,
  adminReset, javaAvailable,
} from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';

describeWithJava('30 — Fault Injection (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ─── Helper: clear faults via admin API ───────────────────────────────────

  async function clearFaults(): Promise<void> {
    const listRes = await fetch(`${app.engineUrl}/_admin/faults`);
    const faults = (await listRes.json()) as Array<{ id: string }>;
    for (const f of faults) {
      await fetch(`${app.engineUrl}/_admin/faults/${f.id}`, { method: 'DELETE' });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DYNAMIC FAULT RULES VIA ADMIN API
  // ═══════════════════════════════════════════════════════════════════════════

  describe('dynamic fault rules via admin API', () => {
    afterEach(async () => {
      await clearFaults();
    });

    it('POST /_admin/faults registers a fault rule', async () => {
      const res = await fetch(`${app.engineUrl}/_admin/faults`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test-fault',
          match: { condition: 'true', intent: 'query' },
          response: { status: 503, body: { error: 'SERVICE_DOWN' } },
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as JsonObject;
      expect(body['id']).toBeDefined();
      expect(body['name']).toBe('test-fault');
    }, 60_000);

    it('GET /_admin/faults lists active rules', async () => {
      // Add a fault via admin API
      await fetch(`${app.engineUrl}/_admin/faults`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'listed-fault',
          match: { condition: 'true' },
          response: { status: 500, body: {} },
        }),
      });

      const res = await fetch(`${app.engineUrl}/_admin/faults`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ id: string; rule: { name: string } }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body.some(f => f.rule.name === 'listed-fault')).toBe(true);
    }, 60_000);

    it('DELETE /_admin/faults/:id removes a rule', async () => {
      const addRes = await fetch(`${app.engineUrl}/_admin/faults`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'deletable-fault',
          match: { condition: 'true' },
          response: { status: 500, body: {} },
        }),
      });
      const added = (await addRes.json()) as JsonObject;
      const faultId = added['id'] as string;

      const deleteRes = await fetch(`${app.engineUrl}/_admin/faults/${faultId}`, {
        method: 'DELETE',
      });
      expect(deleteRes.status).toBe(204);

      const listRes = await fetch(`${app.engineUrl}/_admin/faults`);
      const list = (await listRes.json()) as Array<{ id: string }>;
      expect(list.some(f => f.id === faultId)).toBe(false);
    }, 60_000);

    it('DELETE non-existent fault returns 404', async () => {
      const res = await fetch(`${app.engineUrl}/_admin/faults/nonexistent-id`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    }, 60_000);

    it('dynamic fault matches and returns fault response', async () => {
      await fetch(`${app.engineUrl}/_admin/faults`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'query-blocker',
          match: { condition: 'true', intent: 'query' },
          response: { status: 503, body: { error: 'UNAVAILABLE' } },
        }),
      });

      const res = await fwd(app.engineUrl, 'GET', '/leads');
      expect(res.status).toBe(503);
      expect((res.body as JsonObject)['error']).toBe('UNAVAILABLE');
    }, 60_000);

    it('dynamic fault does not mutate graph', async () => {
      const entityCountBefore = await getEntityCount(app.engineUrl);
      const eventCountBefore = await getEventCount(app.engineUrl);

      await fetch(`${app.engineUrl}/_admin/faults`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'creation-blocker',
          match: { condition: 'true', intent: 'creation' },
          response: { status: 500, body: { error: 'CHAOS' } },
        }),
      });

      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Fault Corp', contactName: 'F', phone: '+61 0', email: 'f@t.com', source: 'WEBSITE',
      });
      expect(res.status).toBe(500);

      const entityCountAfter = await getEntityCount(app.engineUrl);
      const eventCountAfter = await getEventCount(app.engineUrl);
      expect(entityCountAfter).toBe(entityCountBefore);
      expect(eventCountAfter).toBe(eventCountBefore);
    }, 60_000);

    it('dynamic fault with condition filters correctly', async () => {
      await fetch(`${app.engineUrl}/_admin/faults`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'referral-only-fault',
          match: { condition: "command.payload.source == 'REFERRAL'", intent: 'creation' },
          response: { status: 422, body: { error: 'REFERRAL_BLOCKED' } },
        }),
      });

      // REFERRAL source -> fault matches
      const blockedRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Blocked', contactName: 'B', phone: '+61 0', email: 'b@t.com', source: 'REFERRAL',
      });
      expect(blockedRes.status).toBe(422);

      // WEBSITE source -> fault does NOT match, creation succeeds
      const allowedRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Allowed', contactName: 'A', phone: '+61 0', email: 'a@t.com', source: 'WEBSITE',
      });
      expect([200, 201]).toContain(allowedRes.status);
      const allowedId = (allowedRes.body as JsonObject)['id'] as string;
      const node = await getGraphNode(app.engineUrl, allowedId);
      expect(node).not.toBeNull();
    }, 60_000);

    it('fault cleared on /_admin/reset', async () => {
      await fetch(`${app.engineUrl}/_admin/faults`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'pre-reset-fault',
          match: { condition: 'true', intent: 'query' },
          response: { status: 503, body: {} },
        }),
      });

      // Fault active
      const faultedRes = await fwd(app.engineUrl, 'GET', '/leads');
      expect(faultedRes.status).toBe(503);

      // Reset clears faults
      await adminReset(app.engineUrl);

      // Fault no longer active
      const normalRes = await fwd(app.engineUrl, 'GET', '/leads');
      expect(normalRes.status).toBe(200);
      expect(Array.isArray(normalRes.body)).toBe(true);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BACKWARD COMPATIBILITY WITH x-specmatic-fault HEADER
  // ═══════════════════════════════════════════════════════════════════════════

  describe('backward compatibility with x-specmatic-fault header', () => {
    it('x-specmatic-fault header still takes priority', async () => {
      const fault = JSON.stringify({ status: 418, body: { error: 'TEAPOT' } });
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, { 'x-specmatic-fault': fault });
      expect(res.status).toBe(418);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GRAPH AND EVENT IMMUTABILITY UNDER FAULTS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('graph and event immutability under faults', () => {
    afterEach(async () => {
      await clearFaults();
    });

    it('seeded entity state unchanged after fault on mutation', async () => {
      await fetch(`${app.engineUrl}/_admin/faults`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'mutation-fault',
          match: { condition: 'true', intent: 'mutation' },
          response: { status: 500, body: { error: 'FAULT' } },
        }),
      });

      const leadBefore = await getGraphNode(app.engineUrl, APEX_LEAD_ID);
      const res = await fwd(app.engineUrl, 'POST', `/leads/${APEX_LEAD_ID}/contact`, {});
      expect(res.status).toBe(500);
      const leadAfter = await getGraphNode(app.engineUrl, APEX_LEAD_ID);

      expect(leadAfter!['status']).toBe(leadBefore!['status']);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LATENCY INJECTION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('latency injection via YAML-defined fault rules', () => {
    afterEach(async () => {
      await clearFaults();
    });

    it('boundary-level fault with delay_ms: lead creation with checkDuplicates triggers delayed 504', async () => {
      // lead.yaml defines a fault: when checkDuplicates==true -> 504 with delay_ms: 50
      // checkDuplicates is not part of the OpenAPI POST /leads schema
      // (additionalProperties:false), so request validation would normally reject
      // the payload before the DSL fault rule runs. Skip request validation with
      // the admin-gated control header so the boundary-level fault is reachable.
      const start = Date.now();
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Delay Test', contactName: 'D', phone: '+61 0',
        email: 'd@t.com', source: 'WEBSITE', checkDuplicates: true,
      }, {
        authorization: 'Bearer admin-1:admin',
        'x-potemkin-skip-request-validation': 'true',
      });
      const elapsed = Date.now() - start;

      expect(res.status).toBe(504);
      expect((res.body as JsonObject)['error']).toBe('DUPLICATE_CHECK_TIMEOUT');
      expect(elapsed).toBeGreaterThanOrEqual(40); // delay_ms: 50 with some tolerance
    }, 60_000);

    it('dynamic fault with delay_ms delays response', async () => {
      await fetch(`${app.engineUrl}/_admin/faults`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'delay-test',
          match: { condition: 'true', intent: 'query', boundary: 'Lead' },
          response: { status: 200, body: { delayed: true }, delay_ms: 80 },
        }),
      });

      const start = Date.now();
      const res = await fwd(app.engineUrl, 'GET', '/leads');
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);
      expect((res.body as JsonObject)['delayed']).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(70);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PROBABILISTIC FAULT INJECTION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('probabilistic fault injection via YAML-defined rules', () => {
    afterEach(async () => {
      await clearFaults();
    });

    it('dynamic fault with probability ~50% produces mix of successes and failures', async () => {
      await fetch(`${app.engineUrl}/_admin/faults`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'prob-test',
          match: { condition: 'true', intent: 'query', boundary: 'Lead', probability: 0.5 },
          response: { status: 503, body: { error: 'CHAOS' } },
        }),
      });

      let faultCount = 0;
      let successCount = 0;
      const iterations = 40;

      for (let i = 0; i < iterations; i++) {
        const res = await fwd(app.engineUrl, 'GET', '/leads');
        if (res.status === 503) faultCount++;
        else successCount++;
      }

      // With probability 0.5 and 40 iterations, expect roughly 20 faults.
      // Allow wide tolerance (at least 5 and at most 35 of each).
      expect(faultCount).toBeGreaterThanOrEqual(5);
      expect(successCount).toBeGreaterThanOrEqual(5);
    }, 60_000);

    it('fault with probability 0 never fires', async () => {
      await fetch(`${app.engineUrl}/_admin/faults`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'zero-prob',
          match: { condition: 'true', intent: 'query', boundary: 'Lead', probability: 0 },
          response: { status: 503, body: {} },
        }),
      });

      for (let i = 0; i < 10; i++) {
        const res = await fwd(app.engineUrl, 'GET', '/leads');
        expect(res.status).toBe(200); // never faulted
      }
    }, 60_000);

    it('fault with probability 1 always fires', async () => {
      await fetch(`${app.engineUrl}/_admin/faults`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'always-fault',
          match: { condition: 'true', intent: 'query', boundary: 'Lead', probability: 1.0 },
          response: { status: 503, body: { error: 'ALWAYS' } },
        }),
      });

      for (let i = 0; i < 5; i++) {
        const res = await fwd(app.engineUrl, 'GET', '/leads');
        expect(res.status).toBe(503);
      }
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // YAML-DEFINED GLOBAL FAULT RULES FROM global.yaml
  // ═══════════════════════════════════════════════════════════════════════════

  describe('YAML-defined global fault rules from global.yaml', () => {
    it('global fault triggers on matching condition (DNC registry check)', async () => {
      // global.yaml defines: dnc-registry-slow triggers when reason==REGISTRY_CHECK
      const res = await fwd(
        app.engineUrl, 'POST', `/leads/${APEX_LEAD_ID}/dnc`,
        { reason: 'REGISTRY_CHECK' },
        { authorization: 'Bearer mgr1:manager' },
      );

      expect(res.status).toBe(504);
      expect((res.body as JsonObject)['error']).toBe('DNC_REGISTRY_TIMEOUT');
    }, 60_000);

    it('global fault does not trigger when condition does not match', async () => {
      // Same endpoint but different reason -- fault should NOT match
      const res = await fwd(
        app.engineUrl, 'POST', `/leads/${APEX_LEAD_ID}/dnc`,
        { reason: 'Customer requested' },
        { authorization: 'Bearer mgr1:manager' },
      );

      // Should succeed normally (DNC applied)
      expect(res.status).toBe(200);
      const node = await getGraphNode(app.engineUrl, APEX_LEAD_ID);
      expect(node!['status']).toBe('DNC');
    }, 60_000);
  });
});
