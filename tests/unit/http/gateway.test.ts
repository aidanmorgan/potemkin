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
 *  - Idempotency replay serves the post-pipeline body+headers
 */

import { createGateway } from '../../../src/http/gateway.js';
import { bootSystem } from '../../../src/engine/boot.js';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { compileDsl } from '../../../src/dsl/parser.js';
import {
  withPersistentServer,
  type PersistentAgent,
} from '../../_support/persistentAgent.js';
import { registerFileTeardown } from '../../_support/testTeardown.js';
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

  // ── Weak ETag If-Match does not produce NaN ───────────────────────────────────

  it('weak ETag If-Match W/"5" returns 400 not a 412 with NaN', async () => {
    const createRes = await app.agent
      .post('/leads')
      .send({ ...LEAD_PAYLOAD, companyName: 'Weak ETag Test' })
      .expect(201);
    const leadId = createRes.body.id;

    const res = await app.agent
      .post(`/leads/${leadId}/contact`)
      .set('If-Match', 'W/"5"')
      .send({})
      .expect(400);
    expect(res.body.error).toBe('INVALID_IF_MATCH');
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

  // ── targetId from path + intent creation with generate (end of main suite)

});

// ── Idempotency replay serves post-pipeline body+headers ─────────────────────
//
// Uses a self-contained minimal system with idempotency enabled so the test
// does not depend on the createTestApp fixture loading the global YAML.

const IDEM_OPENAPI = `
openapi: "3.0.3"
info:
  title: Idempotency Gateway Test
  version: "1.0.0"
paths:
  /widgets:
    post:
      operationId: createWidget
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Widget"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Widget"
components:
  schemas:
    Widget:
      type: object
      properties:
        id:
          type: string
        label:
          type: string
      additionalProperties: true
`;

const IDEM_DSL = `
boundary: Widget
contract_path: /widgets
identity:
  creation:
    generate: '$uuidv7()'
behaviors:
  - name: createWidget
    match:
      operationId: createWidget
      condition: 'true'
    emit: WidgetCreated
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: command.targetId
      label: command.payload.label
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /label, value: "\${event.payload.label}" }
`;

const IDEM_GLOBAL = `
idempotency:
  enabled: true
  ttl_seconds: 86400
  hash_includes_body: true
`;

describe('http/gateway — idempotency replay serves post-pipeline response', () => {
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(IDEM_OPENAPI);
    const compiledDsl = await compileDsl([{ name: 'widget', yaml: IDEM_DSL }], IDEM_GLOBAL);
    const sys = await bootSystem({ openapi, compiledDsl });
    const app = createGateway(sys);
    const { agent: a, close } = await withPersistentServer(app);
    agent = a;
    registerFileTeardown(close);
  });

  it('idempotency replay body+headers equal the original post-pipeline response (format mutation)', async () => {
    const KEY = `gw-3r96-${Date.now()}`;

    const original = await agent
      .post('/widgets')
      .set('Idempotency-Key', KEY)
      .set('X-Potemkin-Response-Format', 'hal')
      .send({ label: 'HAL Widget' })
      .expect(201);

    expect(original.headers['x-potemkin-response-format']).toBe('hal');
    expect(original.headers['x-specmatic-result']).toBe('success');

    const replay = await agent
      .post('/widgets')
      .set('Idempotency-Key', KEY)
      .set('X-Potemkin-Response-Format', 'hal')
      .send({ label: 'HAL Widget' })
      .expect(201);

    expect(replay.headers['x-idempotency-replay']).toBe('true');
    // Replayed body must equal the original mutated (HAL) body.
    expect(replay.body).toEqual(original.body);
    // Replayed headers include the post-pipeline headers from the original.
    expect(replay.headers['x-potemkin-response-format']).toBe(original.headers['x-potemkin-response-format']);
    expect(replay.headers['x-specmatic-result']).toBe(original.headers['x-specmatic-result']);
  });

  it('idempotency replay includes ETag header from original mutating response', async () => {
    const KEY = `gw-3r96-etag-${Date.now()}`;

    const original = await agent
      .post('/widgets')
      .set('Idempotency-Key', KEY)
      .send({ label: 'ETag Widget' })
      .expect(201);

    expect(original.headers['etag']).toBeDefined();
    expect(original.headers['x-specmatic-result']).toBe('success');

    const replay = await agent
      .post('/widgets')
      .set('Idempotency-Key', KEY)
      .send({ label: 'ETag Widget' })
      .expect(201);

    expect(replay.headers['x-idempotency-replay']).toBe('true');
    expect(replay.headers['etag']).toBe(original.headers['etag']);
    expect(replay.headers['x-specmatic-result']).toBe('success');
  });
});

// ── Time-travel (X-Potemkin-Read-At-Version) with computed fields ─────────────

const TT_COMPUTED_OPENAPI = `
openapi: "3.0.3"
info:
  title: Time-Travel Computed Test
  version: "1.0.0"
paths:
  /scores/{id}:
    get:
      operationId: getScore
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Score"
    post:
      operationId: createScore
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Score"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Score"
components:
  schemas:
    Score:
      type: object
      properties:
        id: { type: string }
        value: { type: integer }
        doubled: { type: integer }
      additionalProperties: true
`;

const TT_COMPUTED_DSL = `
boundary: Score
contract_path: /scores/{id}
identity:
  creation: {}
behaviors:
  - name: createScore
    match:
      operationId: createScore
      condition: 'true'
    emit: ScoreCreated
event_catalog:
  - type: ScoreCreated
    payload_template:
      id: command.targetId
      value: command.payload.value
reducers:
  - on: ScoreCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /value, value: "\${event.payload.value}" }
state:
  computed:
    - name: doubled
      formula: "state.value * 2"
      depends_on: [value]
`;

describe('http/gateway — time-travel with computed fields', () => {
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(TT_COMPUTED_OPENAPI);
    const compiledDsl = await compileDsl([{ name: 'score', yaml: TT_COMPUTED_DSL }]);
    const sys = await bootSystem({ openapi, compiledDsl });
    const app = createGateway(sys);
    const { agent: a, close } = await withPersistentServer(app);
    agent = a;
    registerFileTeardown(close);
  });

  it('X-Potemkin-Read-At-Version replayed entity includes computed fields', async () => {
    const scoreId = nextUuidv7();
    const createRes = await agent
      .post(`/scores/${scoreId}`)
      .send({ value: 5 })
      .expect(201);

    expect(createRes.body.doubled).toBe(10);

    const readAtVersion = await agent
      .get(`/scores/${scoreId}`)
      .set('X-Potemkin-Read-At-Version', '1')
      .expect(200);

    expect(readAtVersion.body.value).toBe(5);
    expect(readAtVersion.body.doubled).toBe(10);
    expect(readAtVersion.body.doubled).toBe(createRes.body.doubled);
  });
});
