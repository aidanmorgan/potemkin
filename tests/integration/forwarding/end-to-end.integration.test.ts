/**
 * Integration tests for POST /_engine/forward and GET /_engine/health.
 *
 * These tests boot the banking fixture and exercise the forwarding surface
 * end-to-end, verifying that the engine correctly processes forwarded
 * requests and returns well-formed ForwardedResponse objects.
 *
 * Scenarios:
 *  1. POST /_engine/forward with method=POST, path=/customers → 201 + state graph updated.
 *  2. The cascade case: POST /loans dispatches secondary cmd to Customer (loanIds updated).
 *  3. Idempotency-key honoured: second identical forwarded request replays cached response.
 *  4. GET /_engine/health returns expected shape.
 *  5. GET /customers via forwarding returns all seeded customers.
 *  6. 404 for entity not found via forwarding.
 *  7. 412 for ConcurrencyConflictError via forwarding.
 *  8. Fault simulation via forwarded x-specmatic-fault header.
 */

import request from 'supertest';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { resetSystem } from '../../../src/engine/reset.js';
import { resetIdempotencyStore } from '../../../src/idempotency/store.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { compileDsl } from '../../../src/dsl/parser.js';
import type { BootedSystem, BootInput } from '../../../src/engine/boot.js';
import type { ForwardedRequest } from '../../../src/forwarding/types.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';

const ACME_COFFEE_ID = '00000000-0000-7000-8000-000000000001';

describe('/_engine/forward — end-to-end integration', () => {
  let sys: BootedSystem;
  let agent: ReturnType<typeof request>;

  beforeAll(async () => {
    const fixture = await loadBankingFixture();
    sys = await bootSystem(fixture);
    const app = createGateway(sys);
    agent = request(app);
  });

  afterEach(() => {
    resetSystem(sys);
    resetIdempotencyStore();
  });

  // ── 1. Create customer via forwarding ─────────────────────────────────────────

  it('POST /customers via forwarding returns 201 and the new customer in body', async () => {
    const fwd: ForwardedRequest = {
      method: 'POST',
      path: '/customers',
      headers: {},
      query: {},
      body: { name: 'Integration Corp', riskBand: 'LOW' },
    };

    const res = await agent.post('/_engine/forward').send(fwd).expect(200);

    expect(res.body.status).toBe(201);
    expect(res.body.body.name).toBe('Integration Corp');
    expect(res.body.body.riskBand).toBe('LOW');
    expect(typeof res.body.body.id).toBe('string');
  });

  it('state graph contains the new customer after creation via forwarding', async () => {
    const fwd: ForwardedRequest = {
      method: 'POST',
      path: '/customers',
      headers: {},
      query: {},
      body: { name: 'Graph Check Corp', riskBand: 'MED' },
    };

    const res = await agent.post('/_engine/forward').send(fwd).expect(200);
    const customerId = res.body.body.id as string;

    const stateNode = sys.graph.get(customerId);
    expect(stateNode).not.toBeNull();
    expect(stateNode!['name']).toBe('Graph Check Corp');
  });

  // ── 2. Cascade: creating a loan updates customer loanIds ──────────────────────

  it('POST /loans via forwarding dispatches cascade to Customer (loanIds updated)', async () => {
    const fwd: ForwardedRequest = {
      method: 'POST',
      path: '/loans',
      headers: {},
      query: {},
      body: { customerId: ACME_COFFEE_ID, principal: 10000 },
    };

    const res = await agent.post('/_engine/forward').send(fwd).expect(200);
    expect(res.body.status).toBe(201);

    const loanId = res.body.body.id as string;

    // Customer's loanIds should now contain the new loan
    const customer = sys.graph.get(ACME_COFFEE_ID);
    expect(customer).not.toBeNull();
    const loanIds = customer!['loanIds'] as string[];
    expect(loanIds).toContain(loanId);
  });

  // ── 3. Idempotency key is honoured (tested in dedicated describe below) ────────

  // ── 4. Health endpoint ───────────────────────────────────────────────────────

  it('GET /_engine/health returns { status: "UP", engine: "potemkin-stateful" }', async () => {
    const res = await agent.get('/_engine/health').expect(200);
    expect(res.body.status).toBe('UP');
    expect(res.body.engine).toBe('potemkin-stateful');
    expect(typeof res.body.version).toBe('string');
  });

  // ── 5. GET /customers via forwarding ─────────────────────────────────────────

  it('GET /customers via forwarding returns all seeded customers', async () => {
    const fwd: ForwardedRequest = {
      method: 'GET',
      path: '/customers',
      headers: {},
      query: {},
      body: null,
    };

    const res = await agent.post('/_engine/forward').send(fwd).expect(200);
    expect(res.body.status).toBe(200);
    expect(Array.isArray(res.body.body)).toBe(true);
    expect((res.body.body as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  // ── 6. 404 for entity not found ──────────────────────────────────────────────

  it('returns ForwardedResponse.status 404 when entity does not exist', async () => {
    const unknownId = nextUuidv7();
    const fwd: ForwardedRequest = {
      method: 'GET',
      path: `/loans/${unknownId}`,
      headers: {},
      query: {},
      body: null,
    };

    const res = await agent.post('/_engine/forward').send(fwd).expect(200);
    expect(res.body.status).toBe(404);
  });

  // ── 7. 412 for ConcurrencyConflictError ──────────────────────────────────────

  it('returns ForwardedResponse.status 412 when If-Match version mismatches', async () => {
    // Create a loan first
    const createRes = await agent.post('/_engine/forward').send({
      method: 'POST',
      path: '/loans',
      headers: {},
      query: {},
      body: { customerId: ACME_COFFEE_ID, principal: 5000 },
    } as ForwardedRequest).expect(200);
    expect(createRes.body.status).toBe(201);
    const loanId = createRes.body.body.id as string;

    // Disburse with wrong version
    const res = await agent.post('/_engine/forward').send({
      method: 'POST',
      path: `/loans/${loanId}/disburse`,
      headers: { 'if-match': '9999' },
      query: {},
      body: {},
    } as ForwardedRequest).expect(200);
    expect(res.body.status).toBe(412);
  });

  // ── 8. Fault simulation ──────────────────────────────────────────────────────

  it('x-specmatic-fault header causes fault-sim response in ForwardedResponse', async () => {
    const faultPayload = JSON.stringify({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } });
    const fwd: ForwardedRequest = {
      method: 'GET',
      path: '/customers',
      headers: { 'x-specmatic-fault': faultPayload },
      query: {},
      body: null,
    };

    const res = await agent.post('/_engine/forward').send(fwd).expect(200);
    expect(res.body.status).toBe(503);
    expect(res.body.body).toMatchObject({ error: 'SERVICE_UNAVAILABLE' });
  });

  // ── 9. Inner GET forwarded correctly (method param drives intent) ─────────────

  it('forwarding always uses POST to /_engine/forward regardless of inner method', async () => {
    // The endpoint is always POST /_engine/forward; the inner method is in the body.
    const fwd: ForwardedRequest = {
      method: 'GET',
      path: '/customers',
      headers: {},
      query: {},
      body: null,
    };

    // Using GET to /_engine/forward should 404 (not registered)
    await agent.get('/_engine/forward').expect(404);

    // Using POST with GET inner method works correctly
    const res = await agent.post('/_engine/forward').send(fwd).expect(200);
    expect(res.body.status).toBe(200);
  });

  // ── 10. ETag header present in ForwardedResponse for mutations ───────────────

  it('ForwardedResponse contains etag header for creation commands', async () => {
    const fwd: ForwardedRequest = {
      method: 'POST',
      path: '/customers',
      headers: {},
      query: {},
      body: { name: 'ETag Integration Corp', riskBand: 'HIGH' },
    };

    const res = await agent.post('/_engine/forward').send(fwd).expect(200);
    expect(res.body.status).toBe(201);
    expect(res.body.headers['etag']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Idempotency via forwarding — requires an idempotency-enabled DSL fixture
// ---------------------------------------------------------------------------

const IDEM_OPENAPI_YAML = `
openapi: '3.0.3'
info:
  title: Idempotency Forwarding Test
  version: '1.0.0'
paths:
  /widgets:
    post:
      operationId: createWidget
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Widget'
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Widget'
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

const IDEM_DSL_YAML = `
boundary: Widget
contract_path: /widgets
identity:
  creation:
    generate: '$uuidv7()'
behaviors:
  - name: createWidget
    match:
      intent: creation
      condition: 'true'
    emit: WidgetCreated
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: command.targetId
      label: command.payload.label
reducers:
  - on: WidgetCreated
    assign:
      id: event.payload.id
      label: event.payload.label
`;

const IDEM_GLOBAL_YAML = `
idempotency:
  enabled: true
  ttl_seconds: 86400
  hash_includes_body: true
`;

describe('/_engine/forward — idempotency-key honoured', () => {
  afterEach(() => {
    resetIdempotencyStore();
  });

  async function buildIdempotencyApp(): Promise<ReturnType<typeof createGateway>> {
    resetIdempotencyStore();
    const openapi = await loadOpenApi(IDEM_OPENAPI_YAML);
    const dsl = await compileDsl([{ name: 'widget', yaml: IDEM_DSL_YAML }], IDEM_GLOBAL_YAML);
    const input: BootInput = { openapi, dslModules: [{ name: 'widget', yaml: IDEM_DSL_YAML }] };
    const sys = await bootSystem(input);
    // Patch the compiled DSL to include idempotency config (mirrors existing test pattern)
    (sys as unknown as { dsl: typeof dsl }).dsl = dsl;
    return createGateway(sys);
  }

  it('second forwarded request with same idempotency-key returns x-idempotency-replay: true', async () => {
    const app = await buildIdempotencyApp();
    const KEY = `fwd-idem-${Date.now()}`;

    const fwd: ForwardedRequest = {
      method: 'POST',
      path: '/widgets',
      headers: { 'idempotency-key': KEY },
      query: {},
      body: { label: 'Alpha Widget' },
    };

    const first = await request(app).post('/_engine/forward').send(fwd).expect(200);
    expect(first.body.status).toBe(201);
    const firstId = first.body.body.id as string;

    const second = await request(app).post('/_engine/forward').send(fwd).expect(200);
    expect(second.body.status).toBe(201);
    expect(second.body.body.id).toBe(firstId);
    expect(second.body.headers['x-idempotency-replay']).toBe('true');
  });
});
