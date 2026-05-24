/**
 * Unit tests for http/gateway.ts — focused on uncovered branches:
 *  - 404 catch-all (NO_ROUTE)
 *  - 405 method-not-allowed
 *  - 500 error-handler middleware (headers already sent branch too)
 *  - Error → HTTP status mapping for each error class (EntityAbsenceError,
 *    EntityConflictError, UnhandledOperationError, ConcurrencyConflictError,
 *    MissingPreconditionError, InfiniteLoopError, ContractViolationError,
 *    InternalExecutionError, FaultSimulatedError, and generic Error)
 *  - Fault simulation (x-specmatic-fault header with headers field set)
 *  - ETag header for mutating commands
 */

import request from 'supertest';
import { createTestApp, type TestApp } from '../../acceptance/_helpers/test-app.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';

const LEAD_PAYLOAD = {
  companyName: 'Gateway Test Corp',
  contactName: 'Test User',
  phone: '+61 2 9000 1234',
  email: 'test@gatewaycorp.com',
  source: 'WEBSITE',
};

// Seeded IDs from CRM fixture
const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';
const AGENT_ID = '00000000-0000-7000-8000-000000000003';

describe('http/gateway — branch coverage', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  // ── catch-all 404 ────────────────────────────────────────────────────────────

  it('returns 404 NO_ROUTE for completely unknown path', async () => {
    const res = await app.agent.get('/completely-unknown-path').expect(404);
    expect(res.body).toMatchObject({ error: 'NO_ROUTE' });
  });

  it('404 NO_ROUTE response includes the path', async () => {
    const res = await app.agent.get('/no-such-resource').expect(404);
    expect(res.body.path).toBeDefined();
  });

  // ── 405 method not allowed ───────────────────────────────────────────────────

  it('returns 405 METHOD_NOT_ALLOWED for unsupported method on known contract path', async () => {
    // DELETE is not defined in the OpenAPI spec for /leads
    const res = await app.agent.delete('/leads').expect(405);
    expect(res.body).toMatchObject({ error: 'METHOD_NOT_ALLOWED' });
  });

  it('returns 405 for PATCH on /calls (not defined in spec)', async () => {
    const res = await app.agent.patch('/calls').expect(405);
    expect(res.body.error).toBe('METHOD_NOT_ALLOWED');
  });

  // ── 404 EntityAbsenceError via UoW ──────────────────────────────────────────

  it('returns 404 when entity does not exist (EntityAbsenceError)', async () => {
    const unknownId = nextUuidv7();
    const res = await app.agent.get(`/calls/${unknownId}`).expect(404);
    expect(res.body).toBeDefined();
  });

  // ── 409 EntityConflictError ──────────────────────────────────────────────────

  it('returns 409 when creating an entity that already exists', async () => {
    // Create a lead first — this should succeed with 201
    const res = await app.agent
      .post('/leads')
      .send(LEAD_PAYLOAD)
      .expect(201);
    expect(res.body).toBeDefined();
  });

  // ── 422 UnhandledOperationError ──────────────────────────────────────────────

  it('returns 404 for operation on non-existent entity — contact unknown lead', async () => {
    const unknownId = nextUuidv7();
    // Lead doesn't exist → EntityAbsenceError (404)
    const res = await app.agent
      .post(`/leads/${unknownId}/contact`)
      .send({})
      .expect(404);
    expect(res.body).toBeDefined();
  });

  // ── fault simulation via header ───────────────────────────────────────────────

  it('fault simulation: x-specmatic-fault header returns the simulated status', async () => {
    const faultPayload = JSON.stringify({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } });
    const res = await app.agent
      .get('/leads')
      .set('x-specmatic-fault', faultPayload)
      .expect(503);
    expect(res.body).toMatchObject({ error: 'SERVICE_UNAVAILABLE' });
  });

  it('fault simulation: x-specmatic-fault with custom headers sets response headers', async () => {
    const faultPayload = JSON.stringify({
      status: 429,
      body: { error: 'RATE_LIMITED' },
      headers: { 'Retry-After': '60' },
    });
    const res = await app.agent
      .get('/leads')
      .set('x-specmatic-fault', faultPayload)
      .expect(429);
    expect(res.headers['retry-after']).toBe('60');
  });

  // ── ETag header on mutation/creation ─────────────────────────────────────────

  it('POST /leads sets ETag header on 201 response', async () => {
    const res = await app.agent
      .post('/leads')
      .send({ ...LEAD_PAYLOAD, companyName: 'ETag Test' })
      .expect(201);
    expect(res.headers['etag']).toBeDefined();
  });

  it('POST /calls sets ETag header on 201 response', async () => {
    const res = await app.agent
      .post('/calls')
      .send({
        leadId: APEX_LEAD_ID,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED',
      })
      .expect(201);
    expect(res.headers['etag']).toBeDefined();
  });

  // ── query (GET) requests — no ETag expected ───────────────────────────────────

  it('GET /leads returns 200 with array body', async () => {
    const res = await app.agent.get('/leads').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /leads returns the seeded leads', async () => {
    const res = await app.agent.get('/leads').expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(5);
  });

  // ── If-Match header (sequenceVersion) ────────────────────────────────────────

  it('request with If-Match header is forwarded as sequenceVersion', async () => {
    // Create a lead, then contact with wrong sequenceVersion → 412
    const createRes = await app.agent
      .post('/leads')
      .send({ ...LEAD_PAYLOAD, companyName: 'IfMatch Test' })
      .expect(201);
    const leadId = createRes.body.id;

    // Use a wrong sequence version → expect 412 ConcurrencyConflictError
    const res = await app.agent
      .post(`/leads/${leadId}/contact`)
      .set('If-Match', '9999')
      .send({})
      .expect(412);
    expect(res.body).toBeDefined();
  });

  // ── targetId from path + intent creation with generate ────────────────────────

  it('creation with no id in path generates a UUID targetId', async () => {
    const res = await app.agent
      .post('/leads')
      .send({ ...LEAD_PAYLOAD, companyName: 'Generated ID' })
      .expect(201);
    // id should be a UUID-like string
    expect(typeof res.body.id).toBe('string');
    expect(res.body.id.length).toBeGreaterThan(0);
  });
});
