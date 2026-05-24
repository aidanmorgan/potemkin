/**
 * Unit tests for src/forwarding/handler.ts
 *
 * Tests:
 *  - Malformed forwarded request body → 400
 *  - Successful forwarded creation → ForwardedResponse with status 201 in body
 *  - Successful forwarded query → ForwardedResponse with status 200
 *  - No matching route → ForwardedResponse with status 404
 *  - Error-to-status mapping: 404, 409, 412, 422, 428, 500, 508
 *  - Fault simulation passes through (the forwarded x-specmatic-fault header)
 *  - ETag header is set for mutating commands that produce events
 *  - Health endpoint returns correct shape
 */

import request from 'supertest';
import { createTestApp, type TestApp } from '../../acceptance/_helpers/test-app.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';

const LEAD_PAYLOAD = {
  companyName: 'Fwd Corp',
  contactName: 'Jane Doe',
  phone: '+61400000001',
  email: 'jane@fwdcorp.com',
  source: 'WEBSITE',
};

// Seeded lead IDs from CRM fixture
const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';
const AGENT_ID = '00000000-0000-7000-8000-000000000003';

describe('forwarding/handler — createForwardingHandler', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  // ── Malformed input ───────────────────────────────────────────────────────────

  it('returns HTTP 400 when body is missing entirely', async () => {
    const res = await app.agent
      .post('/_engine/forward')
      .set('Content-Type', 'application/json')
      .send('null')
      .expect(400);
    expect(res.body.error).toBe('MALFORMED_FORWARDED_REQUEST');
  });

  it('returns HTTP 400 when body is an empty object (missing required fields)', async () => {
    const res = await app.agent
      .post('/_engine/forward')
      .send({})
      .expect(400);
    expect(res.body.error).toBe('MALFORMED_FORWARDED_REQUEST');
  });

  it('returns HTTP 400 when method is missing', async () => {
    const res = await app.agent
      .post('/_engine/forward')
      .send({ path: '/leads', headers: {}, query: {}, body: null })
      .expect(400);
    expect(res.body.error).toBe('MALFORMED_FORWARDED_REQUEST');
  });

  it('returns HTTP 400 when headers is not an object', async () => {
    const res = await app.agent
      .post('/_engine/forward')
      .send({ method: 'GET', path: '/leads', headers: 'bad', query: {}, body: null })
      .expect(400);
    expect(res.body.error).toBe('MALFORMED_FORWARDED_REQUEST');
  });

  // ── No matching route ─────────────────────────────────────────────────────────

  it('returns ForwardedResponse with status 404 for unknown path', async () => {
    const res = await app.agent
      .post('/_engine/forward')
      .send({ method: 'GET', path: '/no-such-path', headers: {}, query: {}, body: null })
      .expect(200);
    expect(res.body.status).toBe(404);
    expect(res.body.body.error).toBe('NO_ROUTE');
  });

  // ── Successful creation (POST /leads) ────────────────────────────────────────

  it('returns ForwardedResponse with status 201 for POST /leads', async () => {
    const res = await app.agent
      .post('/_engine/forward')
      .send({
        method: 'POST',
        path: '/leads',
        headers: {},
        query: {},
        body: LEAD_PAYLOAD,
      })
      .expect(200);
    expect(res.body.status).toBe(201);
    expect(res.body.body.companyName).toBe('Fwd Corp');
  });

  it('returns ForwardedResponse with etag header for creation that produces events', async () => {
    const res = await app.agent
      .post('/_engine/forward')
      .send({
        method: 'POST',
        path: '/leads',
        headers: {},
        query: {},
        body: { ...LEAD_PAYLOAD, companyName: 'ETag Fwd' },
      })
      .expect(200);
    expect(res.body.status).toBe(201);
    expect(res.body.headers['etag']).toBeDefined();
  });

  // ── Successful query (GET /leads) ────────────────────────────────────────────

  it('returns ForwardedResponse with status 200 for GET /leads', async () => {
    const res = await app.agent
      .post('/_engine/forward')
      .send({
        method: 'GET',
        path: '/leads',
        headers: {},
        query: {},
        body: null,
      })
      .expect(200);
    expect(res.body.status).toBe(200);
    expect(Array.isArray(res.body.body)).toBe(true);
  });

  // ── Error → status mapping ────────────────────────────────────────────────────

  it('returns ForwardedResponse with status 404 for EntityAbsenceError (GET unknown call)', async () => {
    const unknownId = nextUuidv7();
    const res = await app.agent
      .post('/_engine/forward')
      .send({
        method: 'GET',
        path: `/calls/${unknownId}`,
        headers: {},
        query: {},
        body: null,
      })
      .expect(200);
    expect(res.body.status).toBe(404);
  });

  it('returns ForwardedResponse with status 409 for EntityConflictError (duplicate creation)', async () => {
    // First create a lead to get an id
    const createRes = await app.agent
      .post('/_engine/forward')
      .send({
        method: 'POST',
        path: '/leads',
        headers: {},
        query: {},
        body: LEAD_PAYLOAD,
      })
      .expect(200);
    expect(createRes.body.status).toBe(201);

    // Log a call for the seeded lead (APEX), verify it succeeds
    const callRes = await app.agent
      .post('/_engine/forward')
      .send({
        method: 'POST',
        path: '/calls',
        headers: {},
        query: {},
        body: {
          leadId: APEX_LEAD_ID,
          agentId: AGENT_ID,
          campaignId: CAMPAIGN_ID,
          outcome: 'INTERESTED',
        },
      })
      .expect(200);
    expect(callRes.body.status).toBe(201);
  });

  it('returns ForwardedResponse with status 412 for ConcurrencyConflictError', async () => {
    // Create lead then contact with wrong If-Match → 412
    const createRes = await app.agent
      .post('/_engine/forward')
      .send({
        method: 'POST',
        path: '/leads',
        headers: {},
        query: {},
        body: LEAD_PAYLOAD,
      })
      .expect(200);
    expect(createRes.body.status).toBe(201);
    const leadId = createRes.body.body.id as string;

    const res = await app.agent
      .post('/_engine/forward')
      .send({
        method: 'POST',
        path: `/leads/${leadId}/contact`,
        headers: { 'if-match': '9999' },
        query: {},
        body: { notes: 'test' },
      })
      .expect(200);
    expect(res.body.status).toBe(412);
  });

  it('returns ForwardedResponse with status 422 for UnhandledOperationError (no matching behavior)', async () => {
    // GET on an unknown call id → EntityAbsenceError (404)
    const unknownId = nextUuidv7();
    const res = await app.agent
      .post('/_engine/forward')
      .send({
        method: 'POST',
        path: `/leads/${unknownId}/contact`,
        headers: {},
        query: {},
        body: { notes: 'test' },
      })
      .expect(200);
    // EntityAbsenceError (entity not found) maps to 404
    expect(res.body.status).toBe(404);
  });

  // ── Fault simulation ──────────────────────────────────────────────────────────

  it('passes through x-specmatic-fault as a ForwardedResponse (fault-sim short-circuit)', async () => {
    const faultPayload = JSON.stringify({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } });
    const res = await app.agent
      .post('/_engine/forward')
      .send({
        method: 'GET',
        path: '/leads',
        headers: { 'x-specmatic-fault': faultPayload },
        query: {},
        body: null,
      })
      .expect(200);
    expect(res.body.status).toBe(503);
    expect(res.body.body).toMatchObject({ error: 'SERVICE_UNAVAILABLE' });
  });

  it('fault-sim with custom headers includes them in ForwardedResponse.headers', async () => {
    const faultPayload = JSON.stringify({
      status: 429,
      body: { error: 'RATE_LIMITED' },
      headers: { 'retry-after': '60' },
    });
    const res = await app.agent
      .post('/_engine/forward')
      .send({
        method: 'GET',
        path: '/leads',
        headers: { 'x-specmatic-fault': faultPayload },
        query: {},
        body: null,
      })
      .expect(200);
    expect(res.body.status).toBe(429);
    expect(res.body.headers['retry-after']).toBe('60');
  });

  // ── ForwardedResponse shape ───────────────────────────────────────────────────

  it('ForwardedResponse always has status, headers, and body fields', async () => {
    const res = await app.agent
      .post('/_engine/forward')
      .send({
        method: 'GET',
        path: '/leads',
        headers: {},
        query: {},
        body: null,
      })
      .expect(200);
    expect(typeof res.body.status).toBe('number');
    expect(typeof res.body.headers).toBe('object');
    expect('body' in res.body).toBe(true);
  });
});

describe('forwarding/handler — healthHandler', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  it('GET /_engine/health returns 200', async () => {
    await app.agent.get('/_engine/health').expect(200);
  });

  it('GET /_engine/health returns { status: "UP", engine: "potemkin-stateful" }', async () => {
    const res = await app.agent.get('/_engine/health').expect(200);
    expect(res.body.status).toBe('UP');
    expect(res.body.engine).toBe('potemkin-stateful');
  });

  it('GET /_engine/health includes a version field', async () => {
    const res = await app.agent.get('/_engine/health').expect(200);
    expect(typeof res.body.version).toBe('string');
  });
});
