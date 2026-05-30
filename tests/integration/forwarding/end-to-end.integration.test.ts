/**
 * Integration tests for POST /_engine/forward and GET /_engine/health.
 *
 * These tests boot the CRM fixture and exercise the forwarding surface
 * end-to-end, verifying that the engine correctly processes forwarded
 * requests and returns well-formed ForwardedResponse objects.
 *
 * Scenarios:
 *  1. POST /_engine/forward with method=POST, path=/leads → 201 + state graph updated.
 *  2. The cascade case: POST /calls dispatches secondary cmd to Lead (callIds updated).
 *  3. Idempotency-key honoured: second identical forwarded request replays cached response.
 *  4. GET /_engine/health returns expected shape.
 *  5. GET /leads via forwarding returns all seeded leads.
 *  6. 404 for entity not found via forwarding.
 *  7. 412 for ConcurrencyConflictError via forwarding.
 *  8. Fault simulation via forwarded x-specmatic-fault header.
 */

import request from 'supertest';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { resetSystem } from '../../../src/engine/reset.js';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { compileDsl } from '../../../src/dsl/parser.js';
import type { BootedSystem, BootInput } from '../../../src/engine/boot.js';
import type { ForwardedRequest } from '../../../src/forwarding/types.js';
import { nextUuidv7 } from '../../../src/ids/uuidv7.js';
import { bootCrmSystem } from '../_helpers/crm-boot.js';

// Seeded lead: Apex Solutions (NEW status, no calls)
const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';
// Seeded campaign and agent for call logging
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';
const AGENT_ID = '00000000-0000-7000-8000-000000000003';

describe('/_engine/forward — end-to-end integration', () => {
  let sys: BootedSystem;
  let agent: ReturnType<typeof request>;

  beforeAll(async () => {
    sys = await bootCrmSystem();
    const app = createGateway(sys);
    agent = request(app);
  });

  afterEach(() => {
    resetSystem(sys);
  });

  // ── 1. Create lead via forwarding ─────────────────────────────────────────────

  it('POST /leads via forwarding returns 201 and the new lead in body', async () => {
    const fwd: ForwardedRequest = {
      method: 'POST',
      path: '/leads',
      headers: {},
      query: {},
      body: {
        companyName: 'Integration Corp',
        contactName: 'Integration User',
        phone: '+61 2 9000 1111',
        email: 'integration@integcorp.com',
        source: 'WEBSITE',
      },
    };

    const res = await agent.post('/_engine/forward').send(fwd).expect(200);

    expect(res.body.status).toBe(201);
    expect(res.body.body.companyName).toBe('Integration Corp');
    expect(res.body.body.source).toBe('WEBSITE');
    expect(typeof res.body.body.id).toBe('string');
  });

  it('state graph contains the new lead after creation via forwarding', async () => {
    const fwd: ForwardedRequest = {
      method: 'POST',
      path: '/leads',
      headers: {},
      query: {},
      body: {
        companyName: 'Graph Check Corp',
        contactName: 'Graph Check User',
        phone: '+61 2 9000 2222',
        email: 'graphcheck@corp.com',
        source: 'REFERRAL',
      },
    };

    const res = await agent.post('/_engine/forward').send(fwd).expect(200);
    const leadId = res.body.body.id as string;

    const stateNode = sys.graph.get(leadId);
    expect(stateNode).not.toBeNull();
    expect(stateNode!['companyName']).toBe('Graph Check Corp');
  });

  // ── 2. Cascade: logging a call updates lead callIds ───────────────────────────

  it('POST /calls via forwarding dispatches cascade to Lead (callIds updated)', async () => {
    const fwd: ForwardedRequest = {
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
    };

    const res = await agent.post('/_engine/forward').send(fwd).expect(200);
    expect(res.body.status).toBe(201);

    const callId = res.body.body.id as string;

    // Lead's callIds should now contain the new call
    const lead = sys.graph.get(APEX_LEAD_ID);
    expect(lead).not.toBeNull();
    const callIds = lead!['callIds'] as string[];
    expect(callIds).toContain(callId);
  });

  // ── 4. Health endpoint ───────────────────────────────────────────────────────

  it('GET /_engine/health returns { status: "UP", engine: "potemkin-stateful" }', async () => {
    const res = await agent.get('/_engine/health').expect(200);
    expect(res.body.status).toBe('UP');
    expect(res.body.engine).toBe('potemkin-stateful');
    expect(typeof res.body.version).toBe('string');
  });

  // ── 5. GET /leads via forwarding ─────────────────────────────────────────────

  it('GET /leads via forwarding returns all seeded leads', async () => {
    const fwd: ForwardedRequest = {
      method: 'GET',
      path: '/leads',
      headers: {},
      query: {},
      body: null,
    };

    const res = await agent.post('/_engine/forward').send(fwd).expect(200);
    expect(res.body.status).toBe(200);
    expect(Array.isArray(res.body.body)).toBe(true);
    expect((res.body.body as unknown[]).length).toBeGreaterThanOrEqual(5);
  });

  // ── 6. 404 for entity not found ──────────────────────────────────────────────

  it('returns ForwardedResponse.status 404 when entity does not exist', async () => {
    const unknownId = nextUuidv7();
    const fwd: ForwardedRequest = {
      method: 'GET',
      path: `/leads/${unknownId}`,
      headers: {},
      query: {},
      body: null,
    };

    const res = await agent.post('/_engine/forward').send(fwd).expect(200);
    expect(res.body.status).toBe(404);
  });

  // ── 7. 412 for ConcurrencyConflictError ──────────────────────────────────────

  it('returns ForwardedResponse.status 412 when If-Match version mismatches', async () => {
    // Create a lead first
    const createRes = await agent.post('/_engine/forward').send({
      method: 'POST',
      path: '/leads',
      headers: {},
      query: {},
      body: {
        companyName: 'Concurrency Corp',
        contactName: 'Concurrency User',
        phone: '+61 2 9000 9988',
        email: 'cc@concurrency.com',
        source: 'WEBSITE',
      },
    } as ForwardedRequest).expect(200);
    expect(createRes.body.status).toBe(201);
    const leadId = createRes.body.body.id as string;

    // Contact the lead with wrong version
    const res = await agent.post('/_engine/forward').send({
      method: 'POST',
      path: `/leads/${leadId}/contact`,
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
      path: '/leads',
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
    const fwd: ForwardedRequest = {
      method: 'GET',
      path: '/leads',
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
      path: '/leads',
      headers: {},
      query: {},
      body: {
        companyName: 'ETag Integration Corp',
        contactName: 'ETag User',
        phone: '+61 2 9000 7777',
        email: 'etag@integration.com',
        source: 'PARTNER',
      },
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

const IDEM_GLOBAL_YAML = `
idempotency:
  enabled: true
  ttl_seconds: 86400
  hash_includes_body: true
`;

describe('/_engine/forward — idempotency-key honoured', () => {
  async function buildIdempotencyApp(): Promise<ReturnType<typeof createGateway>> {
    // Each bootSystem() owns a fresh idempotency store — no shared state to reset.
    const openapi = await loadOpenApi(IDEM_OPENAPI_YAML);
    const dsl = await compileDsl([{ name: 'widget', yaml: IDEM_DSL_YAML }], IDEM_GLOBAL_YAML);
    const input: BootInput = { openapi, compiledDsl: await compileDsl([{ name: 'widget', yaml: IDEM_DSL_YAML }]) };
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
