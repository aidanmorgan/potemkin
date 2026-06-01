/**
 * 32 — Error Response Consistency & Zero-Event Verification via full
 * Specmatic+plugin+Node stack.
 *
 * Verifies that every engine error type:
 *  1. Returns the expected HTTP status code.
 *  2. Includes an error identifier in the response body (either `error` or `code`).
 *  3. Does NOT emit any domain events (zero-event guarantee).
 *  4. Does NOT leak stack traces or internal file paths.
 *
 * Error types exercised:
 *  - 400  ContractViolationError   (invalid request payload)
 *  - 401  AuthenticationRequiredError (missing bearer token for scoped behavior)
 *  - 403  AuthorizationDeniedError (token lacks required scopes)
 *  - 404  EntityAbsenceError / NO_ROUTE (entity not found / no route)
 *  - 405  Method not allowed (wrong HTTP method — via gateway; forwarding returns 404)
 *  - 412  ConcurrencyConflictError (If-Match version mismatch)
 *  - 422  UnhandledOperationError  (guard failure / no behavior matched)
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd,
  getGraphNode,
  getEventCount,
  javaAvailable,
} from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

// Seeded entity IDs from fixture YAML files
const APEX_LEAD_ID   = '00000000-0000-7000-8000-000000000010'; // NEW
const DELTA_LEAD_ID  = '00000000-0000-7000-8000-000000000013'; // DISQUALIFIED

// A UUID that does not correspond to any seeded or created entity.
const NON_EXISTENT_ID = '00000000-dead-7000-8000-000000000099';

/**
 * Assert that an error response body contains an error identifier string
 * (either `error` or `code` field) and does NOT expose stack traces or
 * internal file system paths.
 */
function assertErrorShape(body: unknown): void {
  expect(body).toBeDefined();
  expect(typeof body).toBe('object');
  expect(body).not.toBeNull();

  const obj = body as Record<string, unknown>;

  // Must contain at least one of: `error` (string) or `code` (string)
  const hasError = typeof obj['error'] === 'string';
  const hasCode  = typeof obj['code'] === 'string';
  expect(hasError || hasCode).toBe(true);

  // Must NOT expose stack traces or internal paths
  const serialised = JSON.stringify(body);
  expect(serialised).not.toMatch(/at\s+\S+\s+\(/);          // V8 stack frame pattern
  expect(serialised).not.toMatch(/\/Users\//);               // macOS absolute path
  expect(serialised).not.toMatch(/\/home\//);                // Linux absolute path
  expect(serialised).not.toMatch(/\\Users\\/);               // Windows absolute path
  expect(serialised).not.toMatch(/node_modules/);            // dependency paths
}

describeWithJava('32 — Error Response Consistency (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ── 400 ContractViolationError ──────────────────────────────────────────────

  describe('400 — Contract Violation (invalid request payload)', () => {
    it('POST /leads with missing required field returns 400 and emits zero events', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      // Omit companyName (required field)
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        contactName: 'Missing Company',
        phone: '+61 2 9000 0001',
        email: 'missing@company.test',
        source: 'WEBSITE',
      });

      expect(res.status).toBe(400);
      assertErrorShape(res.body);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);

    it('POST /leads with empty body returns 400 and emits zero events', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', '/leads', {});

      expect(res.status).toBe(400);
      assertErrorShape(res.body);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);
  });

  // ── 401 AuthenticationRequiredError ─────────────────────────────────────────

  describe('401 — Authentication Required (missing bearer token)', () => {
    it('POST /leads/{id}/dnc without Authorization header returns 401 and emits zero events', async () => {
      // Create a fresh lead for this test to avoid polluting seeded state
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Auth Test 401 Corp',
        contactName: 'AT',
        phone: '+61 2 9000 0002',
        email: 'auth401@test.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(createRes.status);
      const leadId = (createRes.body as JsonObject)['id'] as string;

      const eventsBefore = await getEventCount(app.engineUrl);

      // DNC requires manager scope — omit Authorization entirely
      const res = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/dnc`, {
        reason: 'Test',
      });

      // Engine should return 401 (no token) or 403 (no scopes)
      expect([401, 403]).toContain(res.status);
      assertErrorShape(res.body);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);
  });

  // ── 403 AuthorizationDeniedError ───────────────────────────────────────────

  describe('403 — Authorization Denied (insufficient scopes)', () => {
    it('POST /leads/{id}/dnc with agent scope (needs manager) returns 403 and emits zero events', async () => {
      // Create a fresh lead for this test
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Auth Test 403 Corp',
        contactName: 'AT',
        phone: '+61 2 9000 0003',
        email: 'auth403@test.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(createRes.status);
      const leadId = (createRes.body as JsonObject)['id'] as string;

      const eventsBefore = await getEventCount(app.engineUrl);

      // Bearer token with agent scope only — DNC requires manager
      const res = await fwd(
        app.engineUrl,
        'POST',
        `/leads/${leadId}/dnc`,
        { reason: 'Test' },
        { authorization: 'Bearer user-1:agent' },
      );

      expect(res.status).toBe(403);
      assertErrorShape(res.body);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);
  });

  // ── 404 EntityAbsenceError / NO_ROUTE ──────────────────────────────────────

  describe('404 — Entity Absence / No Route', () => {
    it('GET /leads/{nonexistent-uuid} returns 404 and emits zero events', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'GET', `/leads/${NON_EXISTENT_ID}`);

      expect(res.status).toBe(404);
      assertErrorShape(res.body);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);

    it('POST /leads/{nonexistent-uuid}/contact returns 404 and emits zero events', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', `/leads/${NON_EXISTENT_ID}/contact`, {});

      expect(res.status).toBe(404);
      assertErrorShape(res.body);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);

    it('GET /nonexistent-collection returns 404 NO_ROUTE and emits zero events', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'GET', '/nonexistent-collection');

      expect(res.status).toBe(404);
      assertErrorShape(res.body);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);
  });

  // ── 405 Method Not Allowed ─────────────────────────────────────────────────

  describe('405 — Method Not Allowed (via forwarding: 404 NO_ROUTE)', () => {
    it('PUT /leads returns 404/405 (unsupported method on collection) and emits zero events', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      // PUT on /leads collection is not defined in the OpenAPI spec
      const res = await fwd(app.engineUrl, 'PUT', '/leads', {
        companyName: 'Should Fail',
      });

      // Through the forwarding layer, matchRoute returns null for an
      // unsupported method, which produces 404 NO_ROUTE. Through the
      // gateway it would be 405. Both are acceptable here.
      expect([404, 405]).toContain(res.status);
      assertErrorShape(res.body);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);
  });

  // ── 412 ConcurrencyConflictError ───────────────────────────────────────────

  describe('412 — Concurrency Conflict (stale If-Match)', () => {
    it('POST /leads/{id}/contact with stale If-Match returns 412 and emits zero events', async () => {
      // Create a fresh lead so we get a known ETag
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Concurrency 412 Corp',
        contactName: 'C4',
        phone: '+61 2 9000 0004',
        email: 'concurrency412@test.com',
        source: 'REFERRAL',
      });
      expect([200, 201]).toContain(createRes.status);
      const leadId = (createRes.body as JsonObject)['id'] as string;

      // Mutate the lead to advance its version (contact it)
      const contactRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
      expect(contactRes.status).toBe(200);

      // Now the version has advanced beyond 1. Using If-Match: "1" should fail.
      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(
        app.engineUrl,
        'POST',
        `/leads/${leadId}/contact`,
        {},
        { 'If-Match': '"1"' },
      );

      expect(res.status).toBe(412);
      assertErrorShape(res.body);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);

    it('If-Match with wildly stale version returns 412 and leaves graph unchanged', async () => {
      // Create a fresh lead
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Stale Version Corp',
        contactName: 'SV',
        phone: '+61 2 9000 0005',
        email: 'stale412@test.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(createRes.status);
      const leadId = (createRes.body as JsonObject)['id'] as string;

      const nodeBefore = await getGraphNode(app.engineUrl, leadId);
      const statusBefore = nodeBefore!['status'];

      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(
        app.engineUrl,
        'POST',
        `/leads/${leadId}/contact`,
        {},
        { 'If-Match': '"999"' },
      );

      expect(res.status).toBe(412);
      assertErrorShape(res.body);

      // Graph state unchanged
      const nodeAfter = await getGraphNode(app.engineUrl, leadId);
      expect(nodeAfter!['status']).toBe(statusBefore);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);
  });

  // ── 422 UnhandledOperationError ────────────────────────────────────────────

  describe('422 — Unhandled Operation (guard failure)', () => {
    it('POST /leads/{DISQUALIFIED}/qualify returns 422 and emits zero events', async () => {
      // Delta Dynamics is seeded as DISQUALIFIED — qualify guard requires CONTACTED
      const nodeBefore = await getGraphNode(app.engineUrl, DELTA_LEAD_ID);
      expect(nodeBefore!['status']).toBe('DISQUALIFIED');

      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', `/leads/${DELTA_LEAD_ID}/qualify`, {});

      expect(res.status).toBe(422);
      assertErrorShape(res.body);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);

      // Graph state unchanged
      const nodeAfter = await getGraphNode(app.engineUrl, DELTA_LEAD_ID);
      expect(nodeAfter!['status']).toBe('DISQUALIFIED');
    }, 60_000);

    it('POST /leads/{NEW}/qualify returns 422 — guard requires status == CONTACTED', async () => {
      // Apex is seeded as NEW — qualify guard requires status == CONTACTED
      const nodeBefore = await getGraphNode(app.engineUrl, APEX_LEAD_ID);
      expect(nodeBefore!['status']).toBe('NEW');

      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', `/leads/${APEX_LEAD_ID}/qualify`, {});

      expect(res.status).toBe(422);
      assertErrorShape(res.body);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);

      // Graph state unchanged
      const nodeAfter = await getGraphNode(app.engineUrl, APEX_LEAD_ID);
      expect(nodeAfter!['status']).toBe('NEW');
    }, 60_000);
  });

  // ── Cross-cutting: error response shape consistency ────────────────────────

  describe('Cross-cutting: error response shape consistency', () => {
    it('all error responses include an error identifier and no stack traces', async () => {
      // Collect multiple error responses and verify they all pass assertErrorShape
      const errorResponses: Array<{ label: string; res: { status: number; body: unknown } }> = [];

      // 400: missing required field
      const r400 = await fwd(app.engineUrl, 'POST', '/leads', {
        contactName: 'Shape Test',
        phone: '+61 0',
        email: 'shape@test.com',
        source: 'WEBSITE',
        // companyName omitted
      });
      errorResponses.push({ label: '400 contract violation', res: r400 });

      // 404: nonexistent entity
      const r404 = await fwd(app.engineUrl, 'GET', `/leads/${NON_EXISTENT_ID}`);
      errorResponses.push({ label: '404 entity absence', res: r404 });

      // 404: nonexistent path
      const r404route = await fwd(app.engineUrl, 'GET', '/does-not-exist');
      errorResponses.push({ label: '404 no route', res: r404route });

      // 422: guard failure
      const r422 = await fwd(app.engineUrl, 'POST', `/leads/${DELTA_LEAD_ID}/qualify`, {});
      errorResponses.push({ label: '422 guard failure', res: r422 });

      // Verify each error response
      for (const { label: _label, res } of errorResponses) {
        expect(res.status).toBeGreaterThanOrEqual(400);
        assertErrorShape(res.body);
      }

      // Verify we tested at least 4 distinct error scenarios
      expect(errorResponses.length).toBeGreaterThanOrEqual(4);
    }, 60_000);

    it('successful operations DO emit events (sanity baseline for zero-event assertions)', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      // A successful creation should emit at least one event
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Sanity Baseline Corp',
        contactName: 'SB',
        phone: '+61 2 9000 0099',
        email: 'sanity@baseline.test',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(res.status);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBeGreaterThan(eventsBefore);
    }, 60_000);
  });
});
