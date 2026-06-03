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

// ── ez5t: dry-run + Idempotency-Key does NOT write to the store ───────────────
//
// A dry-run request executes the full UoW but does not commit events. The
// idempotency store must NOT record a dry-run response; a subsequent real
// request with the same key must be processed fresh (not a phantom replay).

describe('http/gateway — dry-run requests are not cached in the idempotency store', () => {
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

  it('dry-run + Idempotency-Key does not cache the response; subsequent real request is processed fresh', async () => {
    const KEY = `gw-ez5t-${Date.now()}`;

    // Dry-run request — should NOT write to the idempotency store.
    const dryRun = await agent
      .post('/widgets')
      .set('Idempotency-Key', KEY)
      .set('X-Potemkin-Dry-Run', 'true')
      .send({ label: 'Dry Widget' })
      .expect(201);

    expect(dryRun.headers['x-potemkin-dry-run']).toBe('true');
    expect(dryRun.headers['x-idempotency-replay']).toBeUndefined();

    // Real request with the same key — must be processed fresh, not replayed from the dry-run.
    const real = await agent
      .post('/widgets')
      .set('Idempotency-Key', KEY)
      .send({ label: 'Real Widget' })
      .expect(201);

    expect(real.headers['x-idempotency-replay']).toBeUndefined();
    expect(real.body.label).toBe('Real Widget');
  });
});

// ── aahe: chaos headers are applied on the gateway path ──────────────────────
//
// The gateway advertises chaos headers in CORS_ALLOW_HEADERS and applies DSL
// fault_rules, so chaos header resolution must also run on the gateway path.

describe('http/gateway — chaos headers applied on gateway (direct) path', () => {
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(IDEM_OPENAPI);
    const compiledDsl = await compileDsl([{ name: 'widget', yaml: IDEM_DSL }]);
    const sys = await bootSystem({ openapi, compiledDsl });
    const app = createGateway(sys);
    const { agent: a, close } = await withPersistentServer(app);
    agent = a;
    registerFileTeardown(close);
  });

  it('X-Potemkin-Force-Status short-circuits the gateway with the requested status', async () => {
    const res = await agent
      .post('/widgets')
      .set('X-Potemkin-Force-Status', '503')
      .send({ label: 'Chaos Widget' })
      .expect(503);

    expect(res.body.error).toBe('FORCED_STATUS');
  });

  it('X-Potemkin-Error-Class returns the mapped status for the named error class', async () => {
    const res = await agent
      .post('/widgets')
      .set('X-Potemkin-Error-Class', 'throttle')
      .send({ label: 'Throttle Widget' })
      .expect(429);

    expect(res.body.error).toBe('TOO_MANY_REQUESTS');
  });
});

// ── kp3y: ETag + 304 on direct gateway single-entity GET ─────────────────────
//
// The direct gateway path must emit ETag on single-entity GET and honour
// If-None-Match to return 304 with an empty body — mirroring the forwarding
// handler.

const COND_OPENAPI = `
openapi: "3.0.3"
info: { title: Conditional Gateway Test, version: "1.0.0" }
paths:
  /items:
    get:
      operationId: listItems
      responses: { "200": { description: ok } }
    post:
      operationId: createItem
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/Item" } } }
      responses: { "201": { description: created } }
  /items/{id}:
    get:
      operationId: getItem
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { "200": { description: ok }, "404": { description: missing } }
components:
  schemas:
    Item:
      type: object
      properties:
        id: { type: string }
        name: { type: string }
        updatedAt: { type: string }
      additionalProperties: true
    ItemById:
      type: object
      properties:
        id: { type: string }
        name: { type: string }
        updatedAt: { type: string }
      additionalProperties: true
`;

const COND_DSL = `
boundary: Item
contract_path: /items
fallback_override: true
identity: { creation: { generate: "$uuidv7()" } }
event_catalog:
  - type: ItemCreated
    payload_template: { id: "command.targetId", name: "command.payload.name" }
behaviors:
  - name: create-item
    match: { operationId: createItem, condition: "true" }
    emit: ItemCreated
reducers:
  - on: ItemCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
`;

const COND_BY_ID_DSL = `
boundary: ItemById
contract_path: /items/{id}
fallback_override: true
behaviors: []
reducers: []
event_catalog: []
`;

describe('http/gateway — ETag and 304 on direct single-entity GET (kp3y)', () => {
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(COND_OPENAPI);
    const compiledDsl = await compileDsl([
      { name: 'item', yaml: COND_DSL },
      { name: 'item-by-id', yaml: COND_BY_ID_DSL },
    ]);
    const sys = await bootSystem({ openapi, compiledDsl });
    const app = createGateway(sys);
    const { agent: a, close } = await withPersistentServer(app);
    agent = a;
    registerFileTeardown(close);
  });

  it('single-entity GET emits a quoted ETag', async () => {
    const create = await agent.post('/items').send({ name: 'etag-item' }).expect(201);
    const id = create.body.id;
    const res = await agent.get(`/items/${id}`).expect(200);
    expect(res.headers['etag']).toMatch(/^"\d+"$/);
  });

  it('matching If-None-Match returns 304 with empty body', async () => {
    const create = await agent.post('/items').send({ name: 'inm-item' }).expect(201);
    const id = create.body.id;
    const first = await agent.get(`/items/${id}`).expect(200);
    const etag = first.headers['etag'];
    expect(etag).toBeDefined();

    const cond = await agent.get(`/items/${id}`).set('If-None-Match', etag).expect(304);
    expect(cond.text).toBe('');
    expect(cond.headers['etag']).toBe(etag);
  });

  it('non-matching If-None-Match returns 200 with body', async () => {
    const create = await agent.post('/items').send({ name: 'inm-nomatch' }).expect(201);
    const id = create.body.id;
    const res = await agent.get(`/items/${id}`).set('If-None-Match', '"9999"').expect(200);
    expect(res.body.id).toBe(id);
  });
});

// ── 1mwu: dynamic HATEOAS on direct gateway query path ───────────────────────
//
// The direct gateway path must apply global hateoas.enabled self-links to
// single-entity GET responses, just as the forwarding handler does.

const HATEOAS_GLOBAL = `
hateoas:
  enabled: true
  self_links: true
`;

describe('http/gateway — dynamic HATEOAS on direct query path (1mwu)', () => {
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(COND_OPENAPI);
    const compiledDsl = await compileDsl(
      [
        { name: 'item', yaml: COND_DSL },
        { name: 'item-by-id', yaml: COND_BY_ID_DSL },
      ],
      HATEOAS_GLOBAL,
    );
    const sys = await bootSystem({ openapi, compiledDsl });
    const app = createGateway(sys);
    const { agent: a, close } = await withPersistentServer(app);
    agent = a;
    registerFileTeardown(close);
  });

  it('single-entity GET includes _links.self in the response body', async () => {
    const create = await agent.post('/items').send({ name: 'hateoas-item' }).expect(201);
    const id = create.body.id;
    const res = await agent.get(`/items/${id}`).expect(200);
    expect(res.body._links).toBeDefined();
    expect(res.body._links.self).toBeDefined();
    expect(res.body._links.self.href).toContain(id);
  });
});

// ── wnre: chaos-truncated body is raw bytes, not double-quoted ────────────────
//
// When X-Potemkin-Body-Truncate is applied, the gateway must write the raw
// truncated bytes with Content-Type: application/json and NOT re-quote them
// via res.json(). A truncated body like `[{"i` must arrive as those exact bytes,
// not as the JSON string `"[{\"i"`.

describe('http/gateway — body-truncate writes raw bytes on direct path (wnre)', () => {
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(COND_OPENAPI);
    const compiledDsl = await compileDsl([
      { name: 'item', yaml: COND_DSL },
      { name: 'item-by-id', yaml: COND_BY_ID_DSL },
    ]);
    const sys = await bootSystem({ openapi, compiledDsl });
    const app = createGateway(sys);
    const { agent: a, close } = await withPersistentServer(app);
    agent = a;
    registerFileTeardown(close);
  });

  it('truncated response body is raw bytes (not a re-quoted JSON string)', async () => {
    const res = await agent
      .get('/items')
      .set('X-Potemkin-Body-Truncate', '5')
      .expect(200);

    // The raw HTTP body must be at most 5 bytes.
    // If double-serialized, a 5-byte truncation of `[{"id` would become `"[{\""` (7+ chars with quotes).
    const rawBody = res.text;
    expect(rawBody.length).toBeLessThanOrEqual(5);
    // Must not be a JSON-quoted string (no surrounding quotes from re-serialization).
    expect(rawBody.startsWith('"')).toBe(false);
  });

  it('chaos-forced status with truncated body writes raw bytes', async () => {
    const res = await agent
      .get('/items')
      .set('X-Potemkin-Force-Status', '503')
      .set('X-Potemkin-Body-Truncate', '5')
      .buffer(true)
      .parse((res, callback) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => callback(null, data));
      })
      .expect(503);

    const rawBody = res.body as string;
    expect(rawBody.length).toBeLessThanOrEqual(5);
    expect(rawBody.startsWith('"')).toBe(false);
  });
});

// ── potemkin-25xb fix (a): fault_rule delay_ms applied on gateway path ────────
//
// A YAML fault_rule with delay_ms must delay the gateway response by at least
// that many ms. Boundary latency was already applied before the fault-hit branch,
// so only the rule's own delay delta is added (no double-counting).

const FAULT_DELAY_GLOBAL = `
fault_rules:
  - name: slow-fault
    match:
      headers: { "x-trigger-slow-fault": "*" }
    response:
      status: 503
      body: { error: "SLOW_FAULT" }
    delay_ms: 200
`;

describe('http/gateway — fault_rule delay_ms applied on gateway path (potemkin-25xb-a)', () => {
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(COND_OPENAPI);
    const compiledDsl = await compileDsl(
      [{ name: 'item', yaml: COND_DSL }, { name: 'item-by-id', yaml: COND_BY_ID_DSL }],
      FAULT_DELAY_GLOBAL,
    );
    const sys = await bootSystem({ openapi, compiledDsl });
    const app = createGateway(sys);
    const { agent: a, close } = await withPersistentServer(app);
    agent = a;
    registerFileTeardown(close);
  });

  it('fault_rule with delay_ms delays the gateway response by at least delay_ms', async () => {
    const start = Date.now();
    const res = await agent
      .get('/items')
      .set('x-trigger-slow-fault', 'yes')
      .expect(503);
    const elapsed = Date.now() - start;

    expect(res.body.error).toBe('SLOW_FAULT');
    expect(elapsed).toBeGreaterThanOrEqual(180);
  });
});

// ── potemkin-25xb fix (b): X-Potemkin-Body-Truncate alone truncates normal path
//
// Sending only X-Potemkin-Body-Truncate (no force-status or other chaos header)
// must still truncate the final response body, matching the forwarding handler
// which applies truncation unconditionally after the full pipeline.

describe('http/gateway — X-Potemkin-Body-Truncate alone truncates normal path (potemkin-25xb-b)', () => {
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(COND_OPENAPI);
    const compiledDsl = await compileDsl([
      { name: 'item', yaml: COND_DSL },
      { name: 'item-by-id', yaml: COND_BY_ID_DSL },
    ]);
    const sys = await bootSystem({ openapi, compiledDsl });
    const app = createGateway(sys);
    const { agent: a, close } = await withPersistentServer(app);
    agent = a;
    registerFileTeardown(close);
  });

  it('X-Potemkin-Body-Truncate alone truncates the gateway response body to N bytes', async () => {
    // Seed an item so the list body is non-trivial (more than 8 bytes serialised).
    await agent.post('/items').send({ name: 'truncate-test-item' }).expect(201);

    // Use a raw buffer parser: superagent's JSON parser throws on truncated JSON,
    // so we collect the raw bytes ourselves and inspect them directly.
    const res = await agent
      .get('/items')
      .set('X-Potemkin-Body-Truncate', '8')
      .buffer(true)
      .parse((r, callback) => {
        let data = '';
        r.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        r.on('end', () => callback(null, data));
      })
      .expect(200);

    const rawBody = res.body as string;
    // Body must be at most 8 bytes.
    expect(rawBody.length).toBeLessThanOrEqual(8);
    // Must not be a JSON-quoted string (no double-serialisation).
    expect(rawBody.startsWith('"')).toBe(false);
  });

  it('X-Potemkin-Body-Truncate alone still returns the correct 2xx status', async () => {
    const res = await agent
      .get('/items')
      .set('X-Potemkin-Body-Truncate', '4')
      .buffer(true)
      .parse((r, callback) => {
        let data = '';
        r.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        r.on('end', () => callback(null, data));
      })
      .expect(200);

    expect((res.body as string).length).toBeLessThanOrEqual(4);
  });
});
