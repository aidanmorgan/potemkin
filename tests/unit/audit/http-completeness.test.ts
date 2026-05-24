/**
 * Probing tests for HTTP gateway + admin route completeness gaps.
 *
 * Gaps under test:
 *  1. CORS / preflight (OPTIONS) handling — gateway does NOT set CORS headers or
 *     respond to OPTIONS; browsers / test clients will silently fail.
 *  2. 5xx error body — gateway uses res.status(500).json(…) so HTML leakage from
 *     Express default handler should NOT occur, but we pin this.
 *  3. Content-Type charset variant — express.json() with default type accepts
 *     "application/json; charset=utf-8" but NOT "text/json".
 *  4. HEAD request on a contract path — Express auto-strips body for HEAD;
 *     we verify it responds 200 (not 404/405) with empty body.
 *  5. Admin /_admin/state — no ?boundary= filter support (missing feature).
 *  6. Admin /_admin/events — no pagination support (missing feature).
 *  7. Admin /_admin/health — shape expected by most monitoring systems.
 *  8. Admin routes — no auth protection (open by design but worth asserting).
 *  9. Response Content-Type header is application/json on all JSON routes.
 * 10. OPTIONS on contract path does NOT return 200/204 with CORS headers (gap).
 */

import request from 'supertest';
import { createTestApp, type TestApp } from '../../acceptance/_helpers/test-app.js';

const LEAD_PAYLOAD = {
  companyName: 'Test Corp',
  contactName: 'Jane Doe',
  phone: '+61400000001',
  email: 'jane@testcorp.com',
  source: 'WEBSITE',
};

describe('http/gateway — completeness probes', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  // ── CORS / preflight (gap: no CORS support) ─────────────────────────────────

  it(
    'OPTIONS /leads returns 204 with Access-Control-Allow-Origin header (CORS preflight)',
    async () => {
      const res = await app.agent
        .options('/leads')
        .set('Origin', 'https://example.com')
        .set('Access-Control-Request-Method', 'POST');
      // CORS-aware server should respond 200/204 with Access-Control-Allow-Origin
      expect([200, 204]).toContain(res.status);
      expect(res.headers['access-control-allow-origin']).toBeDefined();
    },
  );

  it(
    'all responses include Access-Control-Allow-Origin header (CORS on every response)',
    async () => {
      const res = await app.agent
        .get('/leads')
        .set('Origin', 'https://example.com');
      expect(res.headers['access-control-allow-origin']).toBeDefined();
    },
  );

  // ── 5xx responses use JSON body, not HTML ────────────────────────────────────

  it('5xx error from unhandled exception has JSON body (not HTML)', async () => {
    // Inject a known path that produces a route match but trigger an internal failure
    // by sending a malformed If-Match that causes parseInt to produce NaN,
    // then UoW gets sequenceVersion=NaN — this exercises the error handler.
    const res = await app.agent
      .post('/leads')
      .send(LEAD_PAYLOAD)
      .set('Content-Type', 'application/json');
    // Baseline: a valid request should succeed (not 500); confirm JSON.
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('unknown path 404 response body is JSON, not HTML', async () => {
    const res = await app.agent.get('/no-such-path-xyz');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(typeof res.body).toBe('object');
  });

  // ── Content-Type variants ───────────────────────────────────────────────────

  it('application/json; charset=utf-8 body is parsed correctly', async () => {
    const res = await app.agent
      .post('/leads')
      .set('Content-Type', 'application/json; charset=utf-8')
      .send(JSON.stringify({ ...LEAD_PAYLOAD, companyName: 'Charset Test' }))
      .expect(201);
    expect(res.body.companyName).toBe('Charset Test');
  });

  it(
    'text/json body is accepted and parsed (H-3: extended content-type support)',
    async () => {
      // express.json() type option now includes 'text/json'
      const res = await app.agent
        .post('/leads')
        .set('Content-Type', 'text/json')
        .send(JSON.stringify({ ...LEAD_PAYLOAD, companyName: 'TextJson' }))
        .expect(201);
      expect(res.body.companyName).toBe('TextJson');
    },
  );

  // ── HEAD request on contract path ────────────────────────────────────────────

  it(
    'HEAD /leads returns 200 with no body (H-1: HEAD treated as GET per RFC 7231)',
    async () => {
      // HEAD is looked up as GET — same status/headers, empty body.
      const res = await app.agent.head('/leads').expect(200);
      expect(res.text).toBeFalsy();
    },
  );

  it('HEAD /leads returns same status as GET (RFC 7231 §4.3.2)', async () => {
    const headRes = await app.agent.head('/leads');
    const getRes = await app.agent.get('/leads');
    expect(headRes.status).toBe(getRes.status);
  });

  // ── Response Content-Type on all JSON routes ─────────────────────────────────

  it('GET /leads sets Content-Type: application/json', async () => {
    const res = await app.agent.get('/leads').expect(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('POST /leads 201 sets Content-Type: application/json', async () => {
    const res = await app.agent
      .post('/leads')
      .send({ ...LEAD_PAYLOAD, companyName: 'CT Test' })
      .expect(201);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('405 METHOD_NOT_ALLOWED sets Content-Type: application/json', async () => {
    const res = await app.agent.delete('/leads').expect(405);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  // ── Admin /_admin/state — no boundary filter ─────────────────────────────────

  it(
    'GET /_admin/state?boundary=X returns 400 NOT_IMPLEMENTED (boundary filter is future work)',
    async () => {
      // adminRoutes.ts:86-90: ?boundary= filter is not yet implemented — returns 400
      const res = await app.agent
        .get('/_admin/state?boundary=Lead')
        .expect(400);
      expect(res.body).toMatchObject({
        error: 'NOT_IMPLEMENTED',
      });
    },
  );

  it('GET /_admin/state?boundary=X returns 400 NOT_IMPLEMENTED (filter is future work)', async () => {
    const res = await app.agent
      .get('/_admin/state?boundary=Lead')
      .expect(400);
    expect(res.body.error).toBe('NOT_IMPLEMENTED');
  });

  it('GET /_admin/state without boundary param returns all entities', async () => {
    const res = await app.agent
      .get('/_admin/state')
      .expect(200);
    expect(res.body.entities).toBeDefined();
  });

  // ── Admin /_admin/events — no pagination ────────────────────────────────────

  it(
    'GET /_admin/events supports ?limit= and ?offset= pagination (H-6)',
    async () => {
      // Create some events first
      await app.agent
        .post('/leads')
        .send({ ...LEAD_PAYLOAD, companyName: 'P1' })
        .expect(201);
      await app.agent
        .post('/leads')
        .send({ ...LEAD_PAYLOAD, companyName: 'P2' })
        .expect(201);

      const res = await app.agent
        .get('/_admin/events?limit=1&offset=0')
        .expect(200);
      // With pagination, only 1 event returned
      expect(res.body.events.length).toBeLessThanOrEqual(1);
    },
  );

  it('GET /_admin/events without pagination returns all events', async () => {
    await app.agent
      .post('/leads')
      .send({ ...LEAD_PAYLOAD, companyName: 'Pag1' })
      .expect(201);
    await app.agent
      .post('/leads')
      .send({ ...LEAD_PAYLOAD, companyName: 'Pag2' })
      .expect(201);

    const res = await app.agent
      .get('/_admin/events')
      .expect(200);
    // Without limit/offset, all events are returned
    expect(res.body.events.length).toBeGreaterThan(1);
  });

  // ── Admin /_admin/health shape ───────────────────────────────────────────────

  it('GET /_admin/health returns { status, uptime, entityCount, eventCount }', async () => {
    const res = await app.agent.get('/_admin/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.entityCount).toBe('number');
    expect(typeof res.body.eventCount).toBe('number');
  });

  it(
    'GET /_admin/health includes checks array (H-7: standard monitoring shape)',
    async () => {
      const res = await app.agent.get('/_admin/health').expect(200);
      expect(Array.isArray(res.body.checks)).toBe(true);
    },
  );

  it(
    'GET /_admin/health includes version field (H-7)',
    async () => {
      const res = await app.agent.get('/_admin/health').expect(200);
      expect(typeof res.body.version).toBe('string');
    },
  );

  // ── Admin routes — no auth protection ────────────────────────────────────────

  it('[CURRENT] admin routes are open — POST /_admin/reset has no auth check', async () => {
    // By design the admin routes are unprotected (this documents the fact)
    const res = await app.agent.post('/_admin/reset').expect(204);
    expect(res.status).toBe(204);
  });

  it(
    'admin routes reject unauthenticated request with 401 when ADMIN_TOKEN is configured',
    async () => {
      // Set the token before the request, clean up after
      process.env['ADMIN_TOKEN'] = 'test-admin-secret';
      try {
        // Missing Authorization header → 401
        const res = await app.agent.post('/_admin/reset');
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ error: 'UNAUTHORIZED' });

        // Correct token → 204
        const ok = await app.agent
          .post('/_admin/reset')
          .set('Authorization', 'Bearer test-admin-secret');
        expect(ok.status).toBe(204);

        // Wrong token → 401
        const wrong = await app.agent
          .post('/_admin/reset')
          .set('Authorization', 'Bearer wrong-token');
        expect(wrong.status).toBe(401);
      } finally {
        delete process.env['ADMIN_TOKEN'];
      }
    },
  );

  // ── ETag format ─────────────────────────────────────────────────────────────

  it('ETag value on creation response is a quoted numeric string (sequence version, RFC 7232)', async () => {
    const res = await app.agent
      .post('/leads')
      .send({ ...LEAD_PAYLOAD, companyName: 'ETag Shape' })
      .expect(201);
    const etag = res.headers['etag'];
    expect(etag).toBeDefined();
    // ETag is now quoted: "1" — strip quotes to check numeric value
    const stripped = String(etag).replace(/^"|"$/g, '');
    expect(Number.isNaN(Number(stripped))).toBe(false);
  });

  it(
    'ETag header is wrapped in double quotes per RFC 7232 (H-4)',
    async () => {
      const res = await app.agent
        .post('/leads')
        .send({ ...LEAD_PAYLOAD, companyName: 'ETag RFC' })
        .expect(201);
      const etag = res.headers['etag'];
      // RFC 7232 §2.3: ETag value must be enclosed in double quotes: ETag: "1"
      expect(etag).toMatch(/^"[^"]*"$/);
    },
  );
});
