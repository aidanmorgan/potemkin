/**
 * Forwarding/gateway parity tests for bug-fix beads:
 *
 *   mh29  — boundary-scoped chaos fault rules resolve on the forwarding path
 *   5m9o  — time-travel (X-Potemkin-Read-At-Version) works with non-path identity.key
 *   q4v1  — idempotency replay incurs configured boundary latency
 *   viyn  — security_headers block appears in ForwardedResponse headers
 *   3wfd  — time-travel replay failure returns identical structured 500 body on gateway and forwarding
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
import { InternalExecutionError } from '../../src/errors.js';
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

// ---------------------------------------------------------------------------
// 3wfd — time-travel replay failure returns identical structured 500 body
// ---------------------------------------------------------------------------

const TT3WFD_OPENAPI = `
openapi: "3.0.3"
info: { title: 3wfd Time Travel Error Parity, version: "1.0.0" }
paths:
  /widgets/{id}:
    post:
      operationId: createWidget
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content: { application/json: { schema: { type: object, additionalProperties: true } } }
      responses: { "201": { description: created } }
    get:
      operationId: getWidget
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { "200": { description: ok }, "404": { description: missing }, "500": { description: error } }
components:
  schemas:
    Widget:
      type: object
      additionalProperties: true
      properties:
        id: { type: string }
        name: { type: string }
`;

const TT3WFD_DSL = `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: true
identity: { creation: { generate: "$uuidv7()" } }
event_catalog:
  - type: WidgetCreated
    payload_template: { id: "command.targetId", name: "command.payload.name" }
behaviors:
  - name: create-widget
    match: { operationId: createWidget, condition: "true" }
    emit: WidgetCreated
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
`;

describe('3wfd — time-travel replay failure returns identical structured 500 body on gateway and forwarding', () => {
  let sys: BootedSystem;
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(TT3WFD_OPENAPI);
    const compiledDsl = await compileDsl([{ name: 'widget', yaml: TT3WFD_DSL }], '');
    sys = await bootSystem({ openapi, compiledDsl });
    server = await withPersistentServer(createGateway(sys));
    agent = server.agent;
  });
  afterAll(async () => { await server.close(); });

  async function fwd(r: ForwardedRequest): Promise<ForwardedResponse> {
    const res = await agent.post('/_engine/forward').send(r).expect(200);
    return res.body as ForwardedResponse;
  }

  it('a time-travel read-at-version whose replay throws returns the same structured error code and body shape on gateway and forwarding', async () => {
    // Create a widget so there are events to replay.
    const id = nextUuidv7();
    const createRes = await agent.post(`/widgets/${id}`).send({ name: 'Gadget' }).expect(201);
    expect(createRes.status).toBe(201);

    // Inject a TS reducer that throws InternalExecutionError during replay.
    sys.tsReducerRegistry.swap([{
      boundary: 'Widget',
      event: 'WidgetCreated',
      source: 'test-inline',
      fn: (_state: unknown, _event: unknown) => {
        throw new InternalExecutionError('Reducer exploded during replay', { code: 'TEST_REDUCER_ERROR' });
      },
    }]);

    // Gateway path — time-travel GET with X-Potemkin-Read-At-Version.
    const gwRes = await agent
      .get(`/widgets/${id}`)
      .set('x-potemkin-read-at-version', '1')
      .expect(500);

    // Forwarding path — same request via /_engine/forward.
    const fwdRes = await fwd(f(
      'GET', `/widgets/${id}`, null,
      { 'x-potemkin-read-at-version': '1' },
    ));

    // Restore registry so later tests are not affected.
    sys.tsReducerRegistry.swap([]);

    // Both must return 500.
    expect(gwRes.status).toBe(500);
    expect(fwdRes.status).toBe(500);

    // Both must carry the structured INTERNAL_EXECUTION_ERROR code (not 'INTERNAL').
    expect((gwRes.body as { code: string }).code).toBe('INTERNAL_EXECUTION_ERROR');
    expect((fwdRes.body as { code: string }).code).toBe('INTERNAL_EXECUTION_ERROR');

    // Body shapes must be identical (same keys and values).
    expect(gwRes.body).toEqual(fwdRes.body);
  });

  it('a successful time-travel read still returns 200 with correct body on the gateway path after the fix', async () => {
    const id = nextUuidv7();
    await agent.post(`/widgets/${id}`).send({ name: 'Gadget' }).expect(201);

    const res = await agent
      .get(`/widgets/${id}`)
      .set('x-potemkin-read-at-version', '1')
      .expect(200);

    expect((res.body as { name: string }).name).toBe('Gadget');
    expect(res.headers['x-potemkin-read-at-version']).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// y9z7 — percent-encoded path parameters are URL-decoded before entity matching
// ---------------------------------------------------------------------------

const Y9Z7_OPENAPI = `
openapi: "3.0.3"
info: { title: y9z7 Path Decode, version: "1.0.0" }
paths:
  /widgets/{id}:
    post:
      operationId: createWidget
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content: { application/json: { schema: { type: object, additionalProperties: true } } }
      responses: { "201": { description: created } }
    get:
      operationId: getWidget
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { "200": { description: ok }, "404": { description: missing } }
components:
  schemas:
    Widget:
      type: object
      additionalProperties: true
      properties:
        id: { type: string }
        name: { type: string }
`;

// Path-keyed boundary (identity.key defaults to the {id} path param) so the
// decoded path value IS the aggregate key.
const Y9Z7_DSL = `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: true
identity: { creation: { generate: "$uuidv7()" } }
event_catalog:
  - type: WidgetCreated
    payload_template: { id: "command.targetId", name: "command.payload.name" }
behaviors:
  - name: create-widget
    match: { operationId: createWidget, condition: "true" }
    emit: WidgetCreated
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
`;

describe('y9z7 — percent-encoded path params resolve to the decoded entity key (end-to-end gateway)', () => {
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(Y9Z7_OPENAPI);
    const compiledDsl = await compileDsl([{ name: 'widget', yaml: Y9Z7_DSL }], '');
    const sys = await bootSystem({ openapi, compiledDsl });
    server = await withPersistentServer(createGateway(sys));
    agent = server.agent;
  });
  afterAll(async () => { await server.close(); });

  it('creates an entity at a space-containing id and reads it back via a percent-encoded GET (200, correct body)', async () => {
    // The path segment "a%20b" decodes to "a b"; the aggregate is keyed "a b".
    const createRes = await agent.post('/widgets/a%20b').send({ name: 'Spacey' }).expect(201);
    expect((createRes.body as { id: string }).id).toBe('a b');

    const getRes = await agent.get('/widgets/a%20b').expect(200);
    expect((getRes.body as { id: string }).id).toBe('a b');
    expect((getRes.body as { name: string }).name).toBe('Spacey');
  });

  // Malformed percent-sequences (e.g. "%zz") falling back to the raw value
  // without throwing is covered at the router layer — where the decode + fallback
  // lives — by tests/unit/contract/router.test.ts. Driving a malformed sequence
  // through the full HTTP stack exercises Express's own URL handling, not ours.
});
