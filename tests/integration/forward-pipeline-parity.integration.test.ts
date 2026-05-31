/**
 * Forwarding pipeline parity — each block proves one feature the /_engine/forward
 * handler must share with the HTTP gateway. Every block FAILS if its feature is
 * removed from the handler:
 *
 *   1. Request-body validation → 400 CONTRACT_VIOLATION (suites 32/33/35).
 *   2. Bulk array body on a creation boundary → results array (suite 31).
 *   3. HEAD (GET semantics, empty body) + OPTIONS (204 + CORS) (suite 31).
 *   4. Conditional requests: ETag + Last-Modified, If-None-Match → 304,
 *      If-Modified-Since (future → 304, malformed → 200), collections/404
 *      never 304 (suite 37).
 *   5. Header-matched DSL fault rules evaluated before the UoW (suite 40).
 *   6. Chaos headers: force-status / force-latency / use-fault / error-class /
 *      retry-after / body-truncate / drop-connection (suite 46).
 *   7. HATEOAS `_links` embedded into query response bodies (suite 44).
 *   8. Boundary `latency:` (fixed_ms) delay before responding (suite 45).
 *   9. Control headers (mask, dry-run, echo, include-events) on forwarded
 *      responses + Tier-7 skip-request-validation admin gating (suite 48).
 *
 * All blocks drive the engine exclusively through POST /_engine/forward using an
 * inline fixture, so they assert the forwarding handler's behaviour directly.
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

const OPENAPI = `
openapi: "3.0.3"
info: { title: Forward Pipeline Parity, version: "1.0.0" }
paths:
  /things:
    get:
      operationId: listThings
      responses: { "200": { description: ok } }
    post:
      operationId: createThing
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/ThingIn" } } }
      responses: { "201": { description: created } }
  /things/{id}:
    get:
      operationId: getThing
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { "200": { description: ok }, "404": { description: missing } }
  /things/{id}/touch:
    post:
      operationId: touchThing
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content: { application/json: { schema: { type: object, additionalProperties: true } } }
      responses: { "200": { description: ok } }
components:
  schemas:
    ThingIn:
      type: object
      additionalProperties: false
      required: [name]
      properties:
        name: { type: string, minLength: 1 }
    Thing:
      type: object
      additionalProperties: true
      properties:
        id: { type: string }
        name: { type: string }
        status: { type: string }
        updatedAt: { type: string }
    ThingById:
      type: object
      additionalProperties: true
      properties:
        id: { type: string }
        name: { type: string }
        status: { type: string }
        updatedAt: { type: string }
    ThingTouch:
      type: object
      additionalProperties: true
      properties:
        id: { type: string }
        name: { type: string }
        status: { type: string }
        updatedAt: { type: string }
`;

// Thing boundary: creation sets id/name/status; touch bumps version + updatedAt.
const DSL = `
boundary: Thing
contract_path: /things
fallback_override: true
identity: { creation: { generate: "$uuidv7()" } }
latency: { fixed_ms: 120 }
event_catalog:
  - type: ThingCreated
    payload_template: { id: "command.targetId", name: "command.payload.name" }
behaviors:
  - name: create-thing
    match: { operationId: createThing, condition: "true" }
    emit: ThingCreated
reducers:
  - on: ThingCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
      - { op: replace, path: /status, value: "\${'NEW'}" }
`;

// A second boundary mapping /things/{id} as its OWN contract_path so a single
// entity GET resolves a targetId (HATEOAS self link + conditional requests).
const DSL_BY_ID = `
boundary: ThingById
contract_path: /things/{id}
fallback_override: true
behaviors: []
reducers: []
event_catalog: []
`;

// touch sub-path boundary: bumps version + writes updatedAt on the SAME aggregate.
const DSL_TOUCH = `
boundary: ThingTouch
contract_path: /things/{id}/touch
fallback_override: true
event_catalog:
  - type: ThingTouched
    payload_template: { id: "command.targetId", updatedAt: "$now()" }
behaviors:
  - name: touch-thing
    match: { operationId: touchThing, condition: "true" }
    emit: ThingTouched
reducers:
  - on: ThingTouched
    patches:
      - { op: replace, path: /status, value: "\${'TOUCHED'}" }
      - { op: replace, path: /updatedAt, value: "\${event.payload.updatedAt}" }
`;

const GLOBAL_YAML = `
hateoas:
  enabled: true
  self_links: true
fault_rules:
  - name: rate-limit-header
    match:
      potemkin: { rate_limit: "*" }
    response:
      status: 429
      body: { error: "RATE_LIMITED", retryAfter: 30 }
      headers: { Retry-After: "30", X-RateLimit-Remaining: "0" }
  - name: force-599-custom
    match:
      headers: { "x-potemkin-force-status": "599" }
    response:
      status: 599
      body: { error: "UPSTREAM_BACKPRESSURE", hint: "back off" }
      headers: { Retry-After: "15" }
`;

async function boot(): Promise<BootedSystem> {
  const openapi = await loadOpenApi(OPENAPI);
  const compiledDsl = await compileDsl(
    [
      { name: 'thing', yaml: DSL },
      { name: 'thing-by-id', yaml: DSL_BY_ID },
      { name: 'thing-touch', yaml: DSL_TOUCH },
    ],
    GLOBAL_YAML,
  );
  return bootSystem({ openapi, compiledDsl });
}

describe('forwarding pipeline parity', () => {
  let sys: BootedSystem;
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    sys = await boot();
    server = await withPersistentServer(createGateway(sys));
    agent = server.agent;
  });
  afterAll(async () => { await server.close(); });

  async function fwd(r: ForwardedRequest): Promise<ForwardedResponse> {
    const res = await agent.post('/_engine/forward').send(r).expect(200);
    return res.body as ForwardedResponse;
  }

  function f(method: string, path: string, body: unknown = null, headers: Record<string, string> = {}, query: Record<string, string> = {}): ForwardedRequest {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    return { method, path, headers: lower, query, body: body as ForwardedRequest['body'] };
  }

  async function createThing(name: string): Promise<string> {
    const res = await fwd(f('POST', '/things', { name }));
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  }

  // 1 — Request-body validation → 400 ----------------------------------------
  describe('request validation', () => {
    it('missing required field on creation → 400 and emits zero events', async () => {
      const before = sys.events.size();
      const res = await fwd(f('POST', '/things', {}));
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe('CONTRACT_VIOLATION');
      expect(sys.events.size()).toBe(before);
    });

    it('an array body where an object is expected (sub-resource) → 400', async () => {
      const id = await createThing('arr-body');
      const res = await fwd(f('POST', `/things/${id}/touch`, []));
      expect(res.status).toBe(400);
    });
  });

  // 2 — Bulk array body on creation boundary ---------------------------------
  describe('bulk creation', () => {
    it('an array body to a creation boundary creates each item and returns an array', async () => {
      const res = await fwd(f('POST', '/things', [{ name: 'bulk-a' }, { name: 'bulk-b' }, { name: 'bulk-c' }]));
      expect([200, 201]).toContain(res.status);
      const results = res.body as Array<{ id: string }>;
      expect(results).toHaveLength(3);
      for (const r of results) {
        const node = sys.graph.get(r.id);
        expect(node).not.toBeNull();
      }
    });

    it('an invalid item aborts the batch with 400 and persists none of it', async () => {
      const before = sys.events.size();
      const res = await fwd(f('POST', '/things', [{ name: 'ok-1' }, { /* missing name */ }]));
      expect(res.status).toBe(400);
      expect(sys.events.size()).toBe(before);
    });
  });

  // 3 — HEAD + OPTIONS --------------------------------------------------------
  describe('HEAD and OPTIONS', () => {
    it('HEAD on a collection returns 200 with an empty body', async () => {
      const res = await fwd(f('HEAD', '/things'));
      expect(res.status).toBe(200);
      expect(res.body === null || res.body === '' || JSON.stringify(res.body) === '{}').toBe(true);
    });

    it('OPTIONS returns 204 with CORS headers', async () => {
      const res = await fwd(f('OPTIONS', '/things'));
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-methods']).toBeDefined();
      expect(res.headers['access-control-allow-headers']).toBeDefined();
      expect(res.headers['access-control-allow-origin']).toBeDefined();
    });
  });

  // 4 — Conditional requests --------------------------------------------------
  describe('conditional requests', () => {
    it('single-entity GET emits a quoted ETag derived from sequenceVersion', async () => {
      const id = await createThing('etag');
      const res = await fwd(f('GET', `/things/${id}`));
      expect(res.status).toBe(200);
      expect(res.headers['etag']).toMatch(/^"\d+"$/);
    });

    it('matching If-None-Match returns 304 with empty body but retains the ETag', async () => {
      const id = await createThing('inm');
      const first = await fwd(f('GET', `/things/${id}`));
      const etag = first.headers['etag'];
      const cond = await fwd(f('GET', `/things/${id}`, null, { 'If-None-Match': etag }));
      expect(cond.status).toBe(304);
      expect(cond.body === null || JSON.stringify(cond.body) === '{}').toBe(true);
      expect(cond.headers['etag']).toBe(etag);
    });

    it('Last-Modified is derived from updatedAt; a future If-Modified-Since → 304', async () => {
      const id = await createThing('lm');
      const touch = await fwd(f('POST', `/things/${id}/touch`, { v: 1 }));
      expect(touch.status).toBe(200);
      const res = await fwd(f('GET', `/things/${id}`));
      expect(res.headers['last-modified']).toBeDefined();
      const future = new Date(Date.now() + 365 * 864e5).toUTCString();
      const cond = await fwd(f('GET', `/things/${id}`, null, { 'If-Modified-Since': future }));
      expect(cond.status).toBe(304);
    });

    it('a malformed If-Modified-Since is ignored (200, not 500)', async () => {
      const id = await createThing('mal');
      const res = await fwd(f('GET', `/things/${id}`, null, { 'If-Modified-Since': 'not a date' }));
      expect(res.status).toBe(200);
    });

    it('collections never 304 and a missing entity beats 304', async () => {
      const coll = await fwd(f('GET', '/things', null, { 'If-None-Match': '"1"' }));
      expect(coll.status).toBe(200);
      expect(coll.headers['etag']).toBeUndefined();
      const miss = await fwd(f('GET', `/things/${nextUuidv7()}`, null, { 'If-None-Match': '"1"' }));
      expect(miss.status).toBe(404);
    });
  });

  // 5 — Header-matched DSL fault rules ---------------------------------------
  describe('header-matched fault rules (evaluated before the UoW)', () => {
    it('x-potemkin-rate-limit short-circuits to the YAML 429 and emits zero events', async () => {
      const before = sys.events.size();
      const res = await fwd(f('POST', '/things', { name: 'should-not-persist' }, { 'x-potemkin-rate-limit': 'true' }));
      expect(res.status).toBe(429);
      expect((res.body as { error: string }).error).toBe('RATE_LIMITED');
      expect(res.headers['retry-after']).toBe('30');
      expect(sys.events.size()).toBe(before);
    });
  });

  // 6 — Chaos headers ---------------------------------------------------------
  describe('chaos headers', () => {
    it('force-status forces a generic body when no YAML rule matches', async () => {
      const res = await fwd(f('GET', '/things', null, { 'x-potemkin-force-status': '503' }));
      expect(res.status).toBe(503);
      expect((res.body as { error: string }).error).toBe('FORCED_STATUS');
    });

    it('a YAML rule matching the forced status wins over the generic body', async () => {
      const res = await fwd(f('GET', '/things', null, { 'x-potemkin-force-status': '599' }));
      expect(res.status).toBe(599);
      expect((res.body as { error: string }).error).toBe('UPSTREAM_BACKPRESSURE');
      expect(res.headers['retry-after']).toBe('15');
    });

    it('error-class maps to a canonical status', async () => {
      const res = await fwd(f('GET', '/things', null, { 'x-potemkin-error-class': 'timeout' }));
      expect(res.status).toBe(504);
      expect((res.body as { error: string }).error).toBe('GATEWAY_TIMEOUT');
    });

    it('retry-after is attached to a chaos response', async () => {
      const res = await fwd(f('GET', '/things', null, { 'x-potemkin-force-status': '503', 'x-potemkin-retry-after': '10' }));
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('10');
    });

    it('force-latency delays a normal response', async () => {
      const start = Date.now();
      const res = await fwd(f('GET', '/things', null, { 'x-potemkin-force-latency': '300' }));
      expect(res.status).toBe(200);
      expect(Date.now() - start).toBeGreaterThanOrEqual(250);
    });

    it('body-truncate slices the serialised body', async () => {
      const res = await fwd(f('GET', '/things', null, { 'x-potemkin-body-truncate': '10' }));
      expect(res.status).toBe(200);
      const s = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
      expect(s.length).toBeLessThanOrEqual(10);
    });

    it('drop-connection surfaces a synthetic 504 marker', async () => {
      const res = await fwd(f('GET', '/things', null, { 'x-potemkin-drop-connection': '20' }));
      expect(res.status).toBe(504);
      expect(res.headers['x-potemkin-dropped']).toBe('true');
    });
  });

  // 7 — HATEOAS ---------------------------------------------------------------
  describe('HATEOAS', () => {
    it('single-entity GET embeds _links.self into the body', async () => {
      const id = await createThing('hateoas');
      const res = await fwd(f('GET', `/things/${id}`));
      expect(res.status).toBe(200);
      const links = (res.body as { _links?: Record<string, { href: string }> })._links;
      expect(links).toBeDefined();
      expect(links!['self'].href).toBe(`/things/${id}`);
    });
  });

  // 8 — Boundary latency ------------------------------------------------------
  describe('boundary latency', () => {
    it('a boundary fixed_ms delay is applied before the response', async () => {
      const start = Date.now();
      const res = await fwd(f('POST', '/things', { name: 'slow' }));
      expect(res.status).toBe(201);
      // fixed_ms: 120 on the Thing boundary.
      expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    });
  });

  // 9 — Control headers -------------------------------------------------------
  describe('control headers', () => {
    it('X-Potemkin-Mask replaces named fields in the response body', async () => {
      const id = await createThing('mask');
      const res = await fwd(f('GET', `/things/${id}`, null, { 'x-potemkin-mask': 'name' }));
      expect(res.status).toBe(200);
      expect((res.body as { name: string }).name).toBe('[MASKED]');
    });

    it('X-Potemkin-Dry-Run skips commit and tags the response', async () => {
      const before = sys.events.size();
      const res = await fwd(f('POST', '/things', { name: 'dry' }, { 'x-potemkin-dry-run': 'true' }));
      expect([200, 201]).toContain(res.status);
      expect(res.headers['x-potemkin-dry-run']).toBe('true');
      expect(sys.events.size()).toBe(before);
    });

    it('X-Potemkin-Include-Events surfaces an _events array', async () => {
      const res = await fwd(f('POST', '/things', { name: 'evs' }, { 'x-potemkin-include-events': 'true' }));
      expect([200, 201]).toContain(res.status);
      expect(Array.isArray((res.body as { _events: unknown[] })._events)).toBe(true);
    });

    it('X-Potemkin-Echo surfaces a _debug snapshot', async () => {
      const id = await createThing('echo');
      const res = await fwd(f('GET', `/things/${id}`, null, { 'x-potemkin-echo': 'true' }));
      expect(res.status).toBe(200);
      const debug = (res.body as { _debug?: { intent: string } })._debug;
      expect(debug).toBeDefined();
      expect(debug!.intent).toBe('query');
    });

    it('Skip-Request-Validation without admin → 401 ADMIN_REQUIRED', async () => {
      const res = await fwd(f('POST', '/things', {}, { 'x-potemkin-skip-request-validation': 'true' }));
      expect(res.status).toBe(401);
      expect((res.body as { error: string }).error).toBe('ADMIN_REQUIRED');
    });

    it('Skip-Request-Validation WITH :admin lets a normally-invalid payload past validation', async () => {
      const res = await fwd(f('POST', '/things', {}, {
        authorization: 'Bearer admin-1:admin',
        'x-potemkin-skip-request-validation': 'true',
      }));
      // Validation is skipped (not 400) and admin auth accepted (not 401).
      expect(res.status).not.toBe(400);
      expect(res.status).not.toBe(401);
    });
  });
});
