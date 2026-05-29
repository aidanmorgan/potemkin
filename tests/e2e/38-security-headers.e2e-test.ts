/**
 * 38 — HTTP Security Headers via full Specmatic stack.
 *
 * Verifies that the DSL-driven security_headers configuration in
 * tests/fixtures/crm/dsl/global.yaml correctly drives the injection of
 * security headers on EVERY response coming out of the engine — successful
 * responses, error responses, and admin endpoints alike.
 *
 * Configured in global.yaml:
 *   security_headers:
 *     enabled: true
 *     hsts: true                # -> Strict-Transport-Security: max-age=31536000
 *     nosniff: true             # -> X-Content-Type-Options: nosniff
 *     frame_deny: true          # -> X-Frame-Options: DENY
 *     referrer_policy: "strict-origin-when-cross-origin"
 *     custom_headers:
 *       X-Custom-Sim-Header: "potemkin-sim"
 *
 * The YAML is the system under test — assertions read header values straight
 * off the response and compare them to what the YAML configures.
 *
 * NOTE on transport: the security middleware in src/http/gateway.ts is an
 * Express middleware that runs on EVERY outgoing Express response. The
 * /_engine/forward endpoint returns a ForwardedResponse JSON body that only
 * carries the *inner* (UoW) headers — it does NOT replay security-middleware
 * headers into that JSON envelope. To observe security middleware behaviour
 * we therefore issue direct HTTP requests to the engine's contract routes
 * (still the full booted gateway, same middleware chain) and read the raw
 * HTTP response headers via fetch().
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { javaAvailable } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';
const NONEXISTENT_LEAD_ID = '00000000-dead-7000-8000-000000000000';

// Header names as they appear on a fetch Response (case-insensitive lookup).
const H_HSTS = 'strict-transport-security';
const H_NOSNIFF = 'x-content-type-options';
const H_FRAME = 'x-frame-options';
const H_REFERRER = 'referrer-policy';
const H_CUSTOM = 'x-custom-sim-header';

// Expected values per global.yaml.
const V_HSTS = 'max-age=31536000';
const V_NOSNIFF = 'nosniff';
const V_FRAME = 'DENY';
const V_REFERRER = 'strict-origin-when-cross-origin';
const V_CUSTOM = 'potemkin-sim';

// Helper: issue a direct HTTP request to the engine (through the full Express
// gateway / security middleware chain) and return the raw fetch Response.
async function engineFetch(
  app: E2eApp,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return fetch(`${app.engineUrl}${path}`, init);
}

describeWithJava('38 — HTTP Security Headers (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ---- 1. Header presence on successful responses ----

  describe('Successful responses carry all configured security headers', () => {
    it('GET /leads — all 5 security headers present', async () => {
      const res = await engineFetch(app, 'GET', '/leads');
      expect(res.status).toBe(200);

      expect(res.headers.get(H_HSTS)).not.toBeNull();
      expect(res.headers.get(H_NOSNIFF)).not.toBeNull();
      expect(res.headers.get(H_FRAME)).not.toBeNull();
      expect(res.headers.get(H_REFERRER)).not.toBeNull();
      expect(res.headers.get(H_CUSTOM)).not.toBeNull();
    }, 60_000);

    it('GET /leads/{id} — all 5 security headers present on single-entity fetch', async () => {
      const res = await engineFetch(app, 'GET', `/leads/${APEX_LEAD_ID}`);
      expect(res.status).toBe(200);

      expect(res.headers.get(H_HSTS)).not.toBeNull();
      expect(res.headers.get(H_NOSNIFF)).not.toBeNull();
      expect(res.headers.get(H_FRAME)).not.toBeNull();
      expect(res.headers.get(H_REFERRER)).not.toBeNull();
      expect(res.headers.get(H_CUSTOM)).not.toBeNull();
    }, 60_000);

    it('POST /leads (creation) — all 5 security headers present on 201 response', async () => {
      const res = await engineFetch(app, 'POST', '/leads', {
        companyName: 'Header Probe Corp',
        contactName: 'HP User',
        phone: '+61 2 9500 3801',
        email: 'header-probe@test.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(res.status);

      expect(res.headers.get(H_HSTS)).not.toBeNull();
      expect(res.headers.get(H_NOSNIFF)).not.toBeNull();
      expect(res.headers.get(H_FRAME)).not.toBeNull();
      expect(res.headers.get(H_REFERRER)).not.toBeNull();
      expect(res.headers.get(H_CUSTOM)).not.toBeNull();
    }, 60_000);
  });

  // ---- 2. Header presence on error responses ----

  describe('Error responses also carry security headers', () => {
    it('GET /leads/{nonexistent} — 404 response includes all security headers', async () => {
      const res = await engineFetch(app, 'GET', `/leads/${NONEXISTENT_LEAD_ID}`);
      expect(res.status).toBe(404);

      expect(res.headers.get(H_HSTS)).not.toBeNull();
      expect(res.headers.get(H_NOSNIFF)).not.toBeNull();
      expect(res.headers.get(H_FRAME)).not.toBeNull();
      expect(res.headers.get(H_REFERRER)).not.toBeNull();
      expect(res.headers.get(H_CUSTOM)).not.toBeNull();
    }, 60_000);

    it('POST /leads with missing required fields — 400 response includes all security headers', async () => {
      // Contract requires companyName/contactName/phone/email/source — empty body fails validation.
      const res = await engineFetch(app, 'POST', '/leads', {});
      expect(res.status).toBe(400);

      expect(res.headers.get(H_HSTS)).not.toBeNull();
      expect(res.headers.get(H_NOSNIFF)).not.toBeNull();
      expect(res.headers.get(H_FRAME)).not.toBeNull();
      expect(res.headers.get(H_REFERRER)).not.toBeNull();
      expect(res.headers.get(H_CUSTOM)).not.toBeNull();
    }, 60_000);

    it('POST /leads/{id}/qualify on NEW lead — 422 guard failure includes all security headers', async () => {
      // Create a fresh NEW lead — qualify guard will reject because status != CONTACTED.
      const createRes = await engineFetch(app, 'POST', '/leads', {
        companyName: 'Guard 422 Probe Corp',
        contactName: 'G4 User',
        phone: '+61 2 9500 3802',
        email: 'guard-422-probe@test.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(createRes.status);
      const createBody = (await createRes.json()) as { id: string };
      const leadId = createBody.id;

      const res = await engineFetch(app, 'POST', `/leads/${leadId}/qualify`, {});
      expect(res.status).toBe(422);

      expect(res.headers.get(H_HSTS)).not.toBeNull();
      expect(res.headers.get(H_NOSNIFF)).not.toBeNull();
      expect(res.headers.get(H_FRAME)).not.toBeNull();
      expect(res.headers.get(H_REFERRER)).not.toBeNull();
      expect(res.headers.get(H_CUSTOM)).not.toBeNull();
    }, 60_000);
  });

  // ---- 3. Specific header values match YAML config ----

  describe('Header values match YAML configuration exactly', () => {
    it('Strict-Transport-Security has value "max-age=31536000" (from hsts: true)', async () => {
      const res = await engineFetch(app, 'GET', '/leads');
      expect(res.headers.get(H_HSTS)).toBe(V_HSTS);
    }, 60_000);

    it('X-Content-Type-Options has value "nosniff" (from nosniff: true)', async () => {
      const res = await engineFetch(app, 'GET', '/leads');
      expect(res.headers.get(H_NOSNIFF)).toBe(V_NOSNIFF);
    }, 60_000);

    it('X-Frame-Options has value "DENY" (from frame_deny: true)', async () => {
      const res = await engineFetch(app, 'GET', '/leads');
      expect(res.headers.get(H_FRAME)).toBe(V_FRAME);
    }, 60_000);

    it('Referrer-Policy has value "strict-origin-when-cross-origin" (from referrer_policy)', async () => {
      const res = await engineFetch(app, 'GET', '/leads');
      expect(res.headers.get(H_REFERRER)).toBe(V_REFERRER);
    }, 60_000);

    it('Custom X-Custom-Sim-Header has value "potemkin-sim" (from custom_headers)', async () => {
      const res = await engineFetch(app, 'GET', '/leads');
      expect(res.headers.get(H_CUSTOM)).toBe(V_CUSTOM);
    }, 60_000);
  });

  // ---- 4. Security headers coexist with CORS and OPTIONS handling ----

  describe('Security headers interact correctly with CORS / OPTIONS', () => {
    it('GET /leads — response carries both CORS Access-Control-Allow-Origin AND Strict-Transport-Security', async () => {
      const res = await engineFetch(app, 'GET', '/leads');
      expect(res.status).toBe(200);

      // CORS header (always set by CORS middleware before security middleware).
      expect(res.headers.get('access-control-allow-origin')).not.toBeNull();

      // Security header (set by security middleware after CORS).
      expect(res.headers.get(H_HSTS)).toBe(V_HSTS);
    }, 60_000);

    it('OPTIONS /leads — preflight 204 documents actual behaviour (handled before security middleware)', async () => {
      // OPTIONS preflight goes through a dedicated app.options('*') handler that
      // short-circuits BEFORE the security middleware runs. We assert what
      // actually happens — the preflight succeeds with CORS but without
      // security headers.
      const res = await fetch(`${app.engineUrl}/leads`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);

      // CORS preflight headers ARE present.
      expect(res.headers.get('access-control-allow-origin')).not.toBeNull();
      expect(res.headers.get('access-control-allow-methods')).not.toBeNull();

      // Security middleware is NOT invoked on OPTIONS preflight in current code.
      expect(res.headers.get(H_HSTS)).toBeNull();
      expect(res.headers.get(H_NOSNIFF)).toBeNull();
      expect(res.headers.get(H_FRAME)).toBeNull();
      expect(res.headers.get(H_REFERRER)).toBeNull();
      expect(res.headers.get(H_CUSTOM)).toBeNull();
    }, 60_000);
  });

  // ---- 5. Admin endpoints + custom-header injection coverage ----

  describe('Admin endpoints and custom-header injection', () => {
    it('GET /_admin/health — admin endpoint also goes through security middleware', async () => {
      const res = await fetch(`${app.engineUrl}/_admin/health`);
      expect(res.status).toBe(200);

      expect(res.headers.get(H_HSTS)).toBe(V_HSTS);
      expect(res.headers.get(H_NOSNIFF)).toBe(V_NOSNIFF);
      expect(res.headers.get(H_FRAME)).toBe(V_FRAME);
      expect(res.headers.get(H_REFERRER)).toBe(V_REFERRER);
      expect(res.headers.get(H_CUSTOM)).toBe(V_CUSTOM);
    }, 60_000);

    it('Custom header X-Custom-Sim-Header is injected on GET /leads (success)', async () => {
      const res = await engineFetch(app, 'GET', '/leads');
      expect(res.headers.get(H_CUSTOM)).toBe(V_CUSTOM);
    }, 60_000);

    it('Custom header X-Custom-Sim-Header is injected on 404 error responses', async () => {
      const res = await engineFetch(app, 'GET', `/leads/${NONEXISTENT_LEAD_ID}`);
      expect(res.status).toBe(404);
      expect(res.headers.get(H_CUSTOM)).toBe(V_CUSTOM);
    }, 60_000);

    it('Custom header X-Custom-Sim-Header is injected on /_admin/health', async () => {
      const res = await fetch(`${app.engineUrl}/_admin/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get(H_CUSTOM)).toBe(V_CUSTOM);
    }, 60_000);
  });
});
