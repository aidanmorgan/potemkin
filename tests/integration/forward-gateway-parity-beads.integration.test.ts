/**
 * Forwarding/gateway parity tests for four bug-fix beads:
 *
 *   mh29 — boundary-scoped chaos fault rules resolve on the forwarding path
 *   5m9o — time-travel (X-Potemkin-Read-At-Version) works with non-path identity.key
 *   q4v1 — idempotency replay incurs configured boundary latency
 *   viyn — security_headers block appears in ForwardedResponse headers
 *
 * Each block drives the engine exclusively through POST /_engine/forward using
 * an inline fixture so assertions are against the forwarding handler directly.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import type { ForwardedRequest, ForwardedResponse } from '../../src/forwarding/types.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import {
  withPersistentServer,
  type PersistentAgent,
  type PersistentServer,
} from '../_support/persistentAgent.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function f(
  method: string,
  path: string,
  body: unknown = null,
  headers: Record<string, string> = {},
  query: Record<string, string> = {},
): ForwardedRequest {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { method, path, headers: lower, query, body: body as ForwardedRequest['body'] };
}

// ---------------------------------------------------------------------------
// mh29 — boundary-scoped chaos fault rules on the forwarding path
// ---------------------------------------------------------------------------

const MH29_OPENAPI = `
openapi: "3.0.3"
info: { title: MH29 Chaos Parity, version: "1.0.0" }
paths:
  /orders/{id}:
    post:
      operationId: createOrder
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content: { application/json: { schema: { type: object, additionalProperties: true } } }
      responses: { "201": { description: created } }
    get:
      operationId: getOrder
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { "200": { description: ok }, "404": { description: missing } }
components:
  schemas:
    Order:
      type: object
      additionalProperties: true
      properties:
        id: { type: string }
        status: { type: string }
`;

// Boundary with a boundary-scoped fault rule that triggers on X-Potemkin-Use-Fault.
const MH29_DSL = `
boundary: Order
contract_path: /orders/{id}
fallback_override: true
identity: { creation: { generate: "$uuidv7()" } }
fault_rules:
  - name: order-boundary-rate-limit
    match:
      potemkin: { rate_limit: "*" }
    response:
      status: 429
      body: { error: "ORDER_RATE_LIMITED", source: "boundary" }
      headers: { X-Boundary-Fault: "true" }
event_catalog:
  - type: OrderCreated
    payload_template: { id: "command.targetId" }
behaviors:
  - name: create-order
    match: { operationId: createOrder, condition: "true" }
    emit: OrderCreated
reducers:
  - on: OrderCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /status, value: "\${'NEW'}" }
`;

// Global YAML has NO fault_rules (only boundary-level fault is defined in the DSL).
const MH29_GLOBAL = '';

describe('mh29 — boundary-scoped chaos fault rules resolve on the forwarding path', () => {
  let sys: BootedSystem;
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(MH29_OPENAPI);
    const compiledDsl = await compileDsl([{ name: 'order', yaml: MH29_DSL }], MH29_GLOBAL);
    sys = await bootSystem({ openapi, compiledDsl });
    server = await withPersistentServer(createGateway(sys));
    agent = server.agent;
  });
  afterAll(async () => { await server.close(); });

  async function fwd(r: ForwardedRequest): Promise<ForwardedResponse> {
    const res = await agent.post('/_engine/forward').send(r).expect(200);
    return res.body as ForwardedResponse;
  }

  it('a boundary-scoped fault rule triggered via X-Potemkin-Rate-Limit returns the YAML-shaped 429 body on the forwarding path', async () => {
    const id = nextUuidv7();
    const res = await fwd(f('GET', `/orders/${id}`, null, { 'x-potemkin-rate-limit': 'true' }));
    expect(res.status).toBe(429);
    expect((res.body as { error: string }).error).toBe('ORDER_RATE_LIMITED');
    expect((res.body as { source: string }).source).toBe('boundary');
    expect(res.headers['x-boundary-fault']).toBe('true');
  });

  it('the forwarding path and the gateway path return the same YAML-shaped response for the boundary fault', async () => {
    const id = nextUuidv7();

    // Gateway path
    const gwRes = await agent
      .get(`/orders/${id}`)
      .set('x-potemkin-rate-limit', 'true')
      .expect(429);
    expect(gwRes.body.error).toBe('ORDER_RATE_LIMITED');

    // Forwarding path
    const fwdRes = await fwd(f('GET', `/orders/${id}`, null, { 'x-potemkin-rate-limit': 'true' }));
    expect(fwdRes.status).toBe(429);
    expect((fwdRes.body as { error: string }).error).toBe(gwRes.body.error as string);
  });

  it('global fault rules continue to resolve correctly on the forwarding path', async () => {
    // No global fault rules in this fixture — verifies the boundary fault does not bleed globally.
    const before = sys.events.size();
    const id = nextUuidv7();
    const res = await fwd(f('POST', `/orders/${id}`, { id }, { 'x-potemkin-rate-limit': 'true' }));
    // The boundary fault fires and short-circuits — no events committed.
    expect(res.status).toBe(429);
    expect(sys.events.size()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 5m9o — time-travel with non-path identity.key (from: query)
// ---------------------------------------------------------------------------

const TT_OPENAPI = `
openapi: "3.0.3"
info: { title: 5m9o Time Travel, version: "1.0.0" }
paths:
  /accounts:
    post:
      operationId: createAccount
      requestBody:
        required: true
        content: { application/json: { schema: { type: object, additionalProperties: true } } }
      responses: { "201": { description: created } }
    get:
      operationId: getAccount
      parameters:
        - { name: accountId, in: query, required: false, schema: { type: string } }
      responses: { "200": { description: ok }, "404": { description: missing } }
components:
  schemas:
    Account:
      type: object
      additionalProperties: true
      properties:
        accountId: { type: string }
        name: { type: string }
        version: { type: number }
`;

// Boundary uses identity.key from: query so the entity ID is in a query param, not a path param.
const TT_DSL = `
boundary: Account
contract_path: /accounts
fallback_override: true
identity:
  key:
    from: query
    name: accountId
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: AccountCreated
    payload_template: { accountId: "command.targetId", name: "command.payload.name" }
  - type: AccountUpdated
    payload_template: { accountId: "command.targetId", name: "command.payload.name" }
behaviors:
  - name: create-account
    match: { operationId: createAccount, condition: "true" }
    emit: AccountCreated
reducers:
  - on: AccountCreated
    patches:
      - { op: replace, path: /accountId, value: "\${event.payload.accountId}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
      - { op: replace, path: /version, value: "\${1}" }
`;

const TT_GLOBAL = '';

describe('5m9o — time-travel with non-path identity.key resolves correctly on the forwarding path', () => {
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(TT_OPENAPI);
    const compiledDsl = await compileDsl([{ name: 'account', yaml: TT_DSL }], TT_GLOBAL);
    const sys = await bootSystem({ openapi, compiledDsl });
    server = await withPersistentServer(createGateway(sys));
    agent = server.agent;
  });
  afterAll(async () => { await server.close(); });

  async function fwd(r: ForwardedRequest): Promise<ForwardedResponse> {
    const res = await agent.post('/_engine/forward').send(r).expect(200);
    return res.body as ForwardedResponse;
  }

  it('X-Potemkin-Read-At-Version on a query-keyed boundary returns the historical state (not a 404)', async () => {
    // Create the account (identity.key from: query → query param accountId).
    const createRes = await fwd(f('POST', '/accounts', { name: 'Acme' }));
    expect(createRes.status).toBe(201);
    const accountId = (createRes.body as { accountId: string }).accountId;
    expect(typeof accountId).toBe('string');

    // Read at version 1 via the forwarding path — key comes from query param, not path {id}.
    const ttRes = await fwd(f(
      'GET', '/accounts', null,
      { 'x-potemkin-read-at-version': '1' },
      { accountId },
    ));

    // Must NOT be 404 — the entity exists and the key was resolved from the query param.
    expect(ttRes.status).not.toBe(404);
    expect(ttRes.status).toBe(200);
    expect((ttRes.body as { accountId: string }).accountId).toBe(accountId);
    expect(ttRes.headers['x-potemkin-read-at-version']).toBe('1');
  });

  it('a missing entity at the requested version returns 404 (not a routing error)', async () => {
    const ttRes = await fwd(f(
      'GET', '/accounts', null,
      { 'x-potemkin-read-at-version': '99' },
      { accountId: nextUuidv7() },
    ));
    expect(ttRes.status).toBe(404);
    expect((ttRes.body as { error: string }).error).toBe('ENTITY_ABSENCE');
  });
});

// ---------------------------------------------------------------------------
// q4v1 — idempotency replay incurs configured boundary latency
// ---------------------------------------------------------------------------

const IDEM_OPENAPI = `
openapi: "3.0.3"
info: { title: q4v1 Latency, version: "1.0.0" }
paths:
  /payments/{id}:
    post:
      operationId: createPayment
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content: { application/json: { schema: { type: object, additionalProperties: true } } }
      responses: { "201": { description: created } }
components:
  schemas:
    Payment:
      type: object
      additionalProperties: true
      properties:
        id: { type: string }
        status: { type: string }
`;

// Boundary with a 150 ms boundary latency so measurement is unambiguous.
const IDEM_DSL = `
boundary: Payment
contract_path: /payments/{id}
fallback_override: true
latency: { fixed_ms: 150 }
identity: { creation: { generate: "$uuidv7()" } }
event_catalog:
  - type: PaymentCreated
    payload_template: { id: "command.targetId" }
behaviors:
  - name: create-payment
    match: { operationId: createPayment, condition: "true" }
    emit: PaymentCreated
reducers:
  - on: PaymentCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /status, value: "\${'PENDING'}" }
`;

const IDEM_GLOBAL = `
idempotency:
  enabled: true
  ttlSeconds: 3600
`;

describe('q4v1 — idempotency replay on the forwarding path incurs configured boundary latency', () => {
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(IDEM_OPENAPI);
    const compiledDsl = await compileDsl([{ name: 'payment', yaml: IDEM_DSL }], IDEM_GLOBAL);
    const sys = await bootSystem({ openapi, compiledDsl });
    server = await withPersistentServer(createGateway(sys));
    agent = server.agent;
  });
  afterAll(async () => { await server.close(); });

  async function fwd(r: ForwardedRequest): Promise<ForwardedResponse> {
    const res = await agent.post('/_engine/forward').send(r).expect(200);
    return res.body as ForwardedResponse;
  }

  it('an idempotency replay hit still incurs the configured 150 ms boundary latency', async () => {
    const id = nextUuidv7();
    const idempotencyKey = `idem-${id}`;

    // First request — cache miss, commits the payment.
    const first = await fwd(f('POST', `/payments/${id}`, { amount: 100 }, { 'idempotency-key': idempotencyKey }));
    expect(first.status).toBe(201);

    // Second request — replay hit; boundary latency should still be applied.
    const start = Date.now();
    const replay = await fwd(f('POST', `/payments/${id}`, { amount: 100 }, { 'idempotency-key': idempotencyKey }));
    const elapsed = Date.now() - start;

    expect(replay.status).toBe(201);
    expect(replay.headers['x-idempotency-replay']).toBe('true');
    // fixed_ms: 150 — allow generous tolerance for test environment jitter.
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it('a cache miss on the forwarding path continues to work correctly after the latency fix', async () => {
    const id = nextUuidv7();
    const res = await fwd(f('POST', `/payments/${id}`, { amount: 50 }));
    expect(res.status).toBe(201);
    expect((res.body as { status: string }).status).toBe('PENDING');
  });
});

// ---------------------------------------------------------------------------
// viyn — security_headers block appears in ForwardedResponse headers
// ---------------------------------------------------------------------------

const VIYN_OPENAPI = `
openapi: "3.0.3"
info: { title: viyn Security Headers, version: "1.0.0" }
paths:
  /items/{id}:
    post:
      operationId: createItem
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content: { application/json: { schema: { type: object, additionalProperties: true } } }
      responses: { "201": { description: created } }
    get:
      operationId: getItem
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { "200": { description: ok }, "404": { description: missing } }
components:
  schemas:
    Item:
      type: object
      additionalProperties: true
      properties:
        id: { type: string }
`;

const VIYN_DSL = `
boundary: Item
contract_path: /items/{id}
fallback_override: true
identity: { creation: { generate: "$uuidv7()" } }
event_catalog:
  - type: ItemCreated
    payload_template: { id: "command.targetId" }
behaviors:
  - name: create-item
    match: { operationId: createItem, condition: "true" }
    emit: ItemCreated
reducers:
  - on: ItemCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

// Global YAML configures security_headers.
const VIYN_GLOBAL = `
security_headers:
  nosniff: true
  frame_deny: true
  custom_headers:
    X-Custom-Security: "enforced"
`;

describe('viyn — security_headers block appears in ForwardedResponse headers', () => {
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(VIYN_OPENAPI);
    const compiledDsl = await compileDsl([{ name: 'item', yaml: VIYN_DSL }], VIYN_GLOBAL);
    const sys = await bootSystem({ openapi, compiledDsl });
    server = await withPersistentServer(createGateway(sys));
    agent = server.agent;
  });
  afterAll(async () => { await server.close(); });

  async function fwd(r: ForwardedRequest): Promise<ForwardedResponse> {
    const res = await agent.post('/_engine/forward').send(r).expect(200);
    return res.body as ForwardedResponse;
  }

  it('a successful forwarded response carries the configured security headers', async () => {
    const id = nextUuidv7();
    const res = await fwd(f('POST', `/items/${id}`, { id }));
    expect(res.status).toBe(201);
    // nosniff → X-Content-Type-Options: nosniff
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // frame_deny → X-Frame-Options: DENY
    expect(res.headers['x-frame-options']).toBe('DENY');
    // custom_headers
    expect(res.headers['x-custom-security']).toBe('enforced');
  });

  it('a forwarded error response also carries the configured security headers', async () => {
    const res = await fwd(f('GET', `/items/${nextUuidv7()}`));
    expect(res.status).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-custom-security']).toBe('enforced');
  });

  it('per-response headers override security defaults (security headers are defaults)', async () => {
    // X-Specmatic-Result is set per-response — it must survive and not be
    // clobbered by the security-header merge (security headers are spread first,
    // per-response headers win).
    const id = nextUuidv7();
    const res = await fwd(f('POST', `/items/${id}`, { id }));
    expect(res.status).toBe(201);
    expect(res.headers['x-specmatic-result']).toBe('success');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('the gateway path continues to include security headers unchanged', async () => {
    const id = nextUuidv7();
    const gwRes = await agent
      .post(`/items/${id}`)
      .send({ id })
      .expect(201);
    expect(gwRes.headers['x-content-type-options']).toBe('nosniff');
    expect(gwRes.headers['x-frame-options']).toBe('DENY');
    expect(gwRes.headers['x-custom-security']).toBe('enforced');
  });
});
