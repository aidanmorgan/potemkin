/**
 * 61 — identity.key: aggregate id extracted from various request sources.
 *
 * Demonstrates all four identity.key.from sources:
 *
 *   from: header  — Boundary Token   (POST /tokens, X-Token-Id header)
 *   from: path    — Boundary Order   (POST /orders/{ref}, path param named "ref")
 *   from: query   — Boundary SessionEvent (POST /session-events?sessionId=...)
 *   from: payload — Boundary Subscription (POST /subscriptions, body.accountId)
 *
 * Each section follows the same pattern:
 *   1. POST to create an entity — assert the response id matches the declared source.
 *   2. GET via the read-back boundary — assert the entity is stored under that id.
 *   3. Two POSTs with different source values create independent aggregates.
 *
 * NOTE: identity.key.cel is NOT supported — the boot validator rejects it at
 * startup (see src/dsl/schema.ts).  The four from: sources cover all use cases.
 *
 * Fixture: tests/fixtures/identity-key
 * Transport: engine-only (startEngineOnlyApp) — no Specmatic JVM required.
 */

import { startEngineOnlyApp } from './_harness/engine-only-app';
import type { EngineOnlyApp } from './_harness/engine-only-app';
import { fwd, getGraphNode } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

// Deterministic ids — chosen to be obviously non-UUIDv7 so failures are readable.
const EXPLICIT_TOKEN_ID = 'tok_header_derived_001';
const EXPLICIT_ORDER_REF = 'ord_path_derived_001';
const EXPLICIT_SESSION_ID = 'sess_query_derived_001';
const EXPLICIT_ACCOUNT_ID = 'acc_payload_derived_001';

describe('61 — identity.key: all non-header sources (engine-only)', () => {
  let app: EngineOnlyApp;

  beforeAll(async () => {
    app = await startEngineOnlyApp({ fixtureName: 'identity-key' });
  }, 60_000);

  afterAll(async () => {
    await app.shutdown();
  }, 15_000);

  // ── Create with explicit header-derived id ────────────────────────────────

  describe('POST /tokens with X-Token-Id header', () => {
    let createdBody: JsonObject;

    it('returns 201 and body.id equals the X-Token-Id header value', async () => {
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/tokens',
        { owner: 'alice', scope: 'read:data' },
        { 'x-token-id': EXPLICIT_TOKEN_ID },
      );
      expect(res.status).toBe(201);
      createdBody = res.body as JsonObject;
      // id must be the value taken from the header, not a generated UUIDv7.
      expect(createdBody['id']).toBe(EXPLICIT_TOKEN_ID);
      expect(createdBody['owner']).toBe('alice');
      expect(createdBody['scope']).toBe('read:data');
      expect(createdBody['status']).toBe('ACTIVE');
    }, 30_000);

    it('GET /tokens/<explicit-id> retrieves the entity by the header-derived key', async () => {
      const res = await fwd(
        app.engineUrl,
        'GET',
        `/tokens/${EXPLICIT_TOKEN_ID}`,
      );
      expect(res.status).toBe(200);
      const body = res.body as JsonObject;
      expect(body['id']).toBe(EXPLICIT_TOKEN_ID);
      expect(body['owner']).toBe('alice');
    }, 30_000);

    it('state graph stores the entity under the header-derived key', async () => {
      const entity = await getGraphNode(app.engineUrl, EXPLICIT_TOKEN_ID);
      expect(entity).not.toBeNull();
      expect(entity!['id']).toBe(EXPLICIT_TOKEN_ID);
    }, 30_000);
  });

  // ── Fallback: no header → UUIDv7 generated ───────────────────────────────

  describe('POST /tokens without X-Token-Id header (fallback to generated id)', () => {
    it('returns 201 and body.id is a generated UUIDv7 (not the explicit id)', async () => {
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/tokens',
        { owner: 'bob', scope: 'write:data' },
        // No x-token-id header — identity.creation.generate: $uuidv7() kicks in.
      );
      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      // Must be a non-empty string distinct from the explicit id.
      expect(typeof body['id']).toBe('string');
      expect((body['id'] as string).length).toBeGreaterThan(0);
      expect(body['id']).not.toBe(EXPLICIT_TOKEN_ID);
      expect(body['owner']).toBe('bob');
    }, 30_000);
  });

  // ── Each header value is an independent aggregate ─────────────────────────

  describe('Two POSTs with different X-Token-Id values create independent entities', () => {
    const ID_A = 'tok_independent_a';
    const ID_B = 'tok_independent_b';

    it('POST with x-token-id: tok_independent_a stores entity A', async () => {
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/tokens',
        { owner: 'charlie', scope: 'admin' },
        { 'x-token-id': ID_A },
      );
      expect(res.status).toBe(201);
      expect((res.body as JsonObject)['id']).toBe(ID_A);
    }, 30_000);

    it('POST with x-token-id: tok_independent_b stores entity B', async () => {
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/tokens',
        { owner: 'diana', scope: 'readonly' },
        { 'x-token-id': ID_B },
      );
      expect(res.status).toBe(201);
      expect((res.body as JsonObject)['id']).toBe(ID_B);
    }, 30_000);

    it('GET /tokens/tok_independent_a returns the correct entity (not B)', async () => {
      const res = await fwd(app.engineUrl, 'GET', `/tokens/${ID_A}`);
      expect(res.status).toBe(200);
      const body = res.body as JsonObject;
      expect(body['id']).toBe(ID_A);
      expect(body['owner']).toBe('charlie');
    }, 30_000);

    it('GET /tokens/tok_independent_b returns the correct entity (not A)', async () => {
      const res = await fwd(app.engineUrl, 'GET', `/tokens/${ID_B}`);
      expect(res.status).toBe(200);
      const body = res.body as JsonObject;
      expect(body['id']).toBe(ID_B);
      expect(body['owner']).toBe('diana');
    }, 30_000);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // from: path — identity.key.from: path, name: ref
  // Boundary Order at POST /orders/{ref}: the path parameter named "ref"
  // (NOT the default "id") is the aggregate key.
  // ════════════════════════════════════════════════════════════════════════════

  describe('identity.key.from: path — aggregate id from a named path parameter', () => {
    it('POST /orders/<ref> returns 201 and body.id equals the path param value', async () => {
      const res = await fwd(
        app.engineUrl,
        'POST',
        `/orders/${EXPLICIT_ORDER_REF}`,
        { product: 'Widget', quantity: 3 },
      );
      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      // id must be the path param value "ord_path_derived_001", not a generated UUIDv7.
      expect(body['id']).toBe(EXPLICIT_ORDER_REF);
      expect(body['product']).toBe('Widget');
      expect(body['status']).toBe('PLACED');
    }, 30_000);

    it('GET /orders/<ref> retrieves the entity stored under the path-derived key', async () => {
      const res = await fwd(
        app.engineUrl,
        'GET',
        `/orders/${EXPLICIT_ORDER_REF}`,
      );
      expect(res.status).toBe(200);
      const body = res.body as JsonObject;
      expect(body['id']).toBe(EXPLICIT_ORDER_REF);
      expect(body['product']).toBe('Widget');
    }, 30_000);

    it('state graph stores the entity under the path-derived key', async () => {
      const entity = await getGraphNode(app.engineUrl, EXPLICIT_ORDER_REF);
      expect(entity).not.toBeNull();
      expect(entity!['id']).toBe(EXPLICIT_ORDER_REF);
    }, 30_000);

    it('two POSTs with different ref values create independent aggregates', async () => {
      const refA = 'ord_path_a';
      const refB = 'ord_path_b';

      const resA = await fwd(app.engineUrl, 'POST', `/orders/${refA}`, { product: 'Gadget', quantity: 1 });
      expect(resA.status).toBe(201);
      expect((resA.body as JsonObject)['id']).toBe(refA);

      const resB = await fwd(app.engineUrl, 'POST', `/orders/${refB}`, { product: 'Gizmo', quantity: 2 });
      expect(resB.status).toBe(201);
      expect((resB.body as JsonObject)['id']).toBe(refB);

      // Each ref routes to its own aggregate.
      const getA = await fwd(app.engineUrl, 'GET', `/orders/${refA}`);
      expect(getA.status).toBe(200);
      expect((getA.body as JsonObject)['product']).toBe('Gadget');

      const getB = await fwd(app.engineUrl, 'GET', `/orders/${refB}`);
      expect(getB.status).toBe(200);
      expect((getB.body as JsonObject)['product']).toBe('Gizmo');
    }, 30_000);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // from: query — identity.key.from: query, name: sessionId
  // Boundary SessionEvent at POST /session-events: the query parameter "sessionId"
  // is the aggregate key.  The URL path has no id segment at all.
  // ════════════════════════════════════════════════════════════════════════════

  describe('identity.key.from: query — aggregate id from a query parameter', () => {
    it('POST /session-events?sessionId=<id> returns 201 and body.id equals the query param', async () => {
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/session-events',
        { eventType: 'PAGE_VIEW', userId: 'user_alice' },
        {},
        { sessionId: EXPLICIT_SESSION_ID },
      );
      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      // id must be the query param value "sess_query_derived_001".
      expect(body['id']).toBe(EXPLICIT_SESSION_ID);
      expect(body['eventType']).toBe('PAGE_VIEW');
      expect(body['status']).toBe('RECORDED');
    }, 30_000);

    it('GET /session-events/<id> retrieves the entity stored under the query-derived key', async () => {
      const res = await fwd(
        app.engineUrl,
        'GET',
        `/session-events/${EXPLICIT_SESSION_ID}`,
      );
      expect(res.status).toBe(200);
      const body = res.body as JsonObject;
      expect(body['id']).toBe(EXPLICIT_SESSION_ID);
      expect(body['userId']).toBe('user_alice');
    }, 30_000);

    it('state graph stores the entity under the query-derived key', async () => {
      const entity = await getGraphNode(app.engineUrl, EXPLICIT_SESSION_ID);
      expect(entity).not.toBeNull();
      expect(entity!['id']).toBe(EXPLICIT_SESSION_ID);
    }, 30_000);

    it('POST without sessionId param falls back to a generated UUIDv7', async () => {
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/session-events',
        { eventType: 'CLICK', userId: 'user_bob' },
        // No sessionId query param — identity.creation.generate: $uuidv7() kicks in.
      );
      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      expect(typeof body['id']).toBe('string');
      expect((body['id'] as string).length).toBeGreaterThan(0);
      expect(body['id']).not.toBe(EXPLICIT_SESSION_ID);
    }, 30_000);

    it('two POSTs with different sessionId values create independent aggregates', async () => {
      const sessA = 'sess_query_a';
      const sessB = 'sess_query_b';

      const resA = await fwd(app.engineUrl, 'POST', '/session-events',
        { eventType: 'LOGIN', userId: 'user_charlie' }, {}, { sessionId: sessA });
      expect(resA.status).toBe(201);
      expect((resA.body as JsonObject)['id']).toBe(sessA);

      const resB = await fwd(app.engineUrl, 'POST', '/session-events',
        { eventType: 'LOGOUT', userId: 'user_diana' }, {}, { sessionId: sessB });
      expect(resB.status).toBe(201);
      expect((resB.body as JsonObject)['id']).toBe(sessB);

      // Each sessionId routes to its own aggregate.
      const getA = await fwd(app.engineUrl, 'GET', `/session-events/${sessA}`);
      expect(getA.status).toBe(200);
      expect((getA.body as JsonObject)['userId']).toBe('user_charlie');

      const getB = await fwd(app.engineUrl, 'GET', `/session-events/${sessB}`);
      expect(getB.status).toBe(200);
      expect((getB.body as JsonObject)['userId']).toBe('user_diana');
    }, 30_000);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // from: payload — identity.key.from: payload, pointer: accountId
  // Boundary Subscription at POST /subscriptions: the "accountId" field in the
  // JSON request body is the aggregate key (dot-path pointer).
  // ════════════════════════════════════════════════════════════════════════════

  describe('identity.key.from: payload — aggregate id from a request body field', () => {
    it('POST /subscriptions with body.accountId returns 201 and body.id equals accountId', async () => {
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/subscriptions',
        { accountId: EXPLICIT_ACCOUNT_ID, plan: 'premium' },
      );
      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      // id must be the value read from body.accountId — "acc_payload_derived_001".
      // The entity does NOT echo accountId as a separate field; the key is the id.
      expect(body['id']).toBe(EXPLICIT_ACCOUNT_ID);
      expect(body['plan']).toBe('premium');
      expect(body['status']).toBe('ACTIVE');
    }, 30_000);

    it('GET /subscriptions/<id> retrieves the entity stored under the payload-derived key', async () => {
      const res = await fwd(
        app.engineUrl,
        'GET',
        `/subscriptions/${EXPLICIT_ACCOUNT_ID}`,
      );
      expect(res.status).toBe(200);
      const body = res.body as JsonObject;
      expect(body['id']).toBe(EXPLICIT_ACCOUNT_ID);
      expect(body['plan']).toBe('premium');
    }, 30_000);

    it('state graph stores the entity under the payload-derived key', async () => {
      const entity = await getGraphNode(app.engineUrl, EXPLICIT_ACCOUNT_ID);
      expect(entity).not.toBeNull();
      expect(entity!['id']).toBe(EXPLICIT_ACCOUNT_ID);
    }, 30_000);

    it('POST without accountId in body falls back to a generated UUIDv7', async () => {
      // accountId omitted — identity.creation.generate: $uuidv7() kicks in.
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/subscriptions',
        { plan: 'basic' },
      );
      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      expect(typeof body['id']).toBe('string');
      expect((body['id'] as string).length).toBeGreaterThan(0);
      expect(body['id']).not.toBe(EXPLICIT_ACCOUNT_ID);
    }, 30_000);

    it('two POSTs with different accountId values create independent aggregates', async () => {
      const accA = 'acc_payload_a';
      const accB = 'acc_payload_b';

      const resA = await fwd(app.engineUrl, 'POST', '/subscriptions',
        { accountId: accA, plan: 'starter' });
      expect(resA.status).toBe(201);
      expect((resA.body as JsonObject)['id']).toBe(accA);

      const resB = await fwd(app.engineUrl, 'POST', '/subscriptions',
        { accountId: accB, plan: 'enterprise' });
      expect(resB.status).toBe(201);
      expect((resB.body as JsonObject)['id']).toBe(accB);

      // Each accountId routes to its own aggregate.
      const getA = await fwd(app.engineUrl, 'GET', `/subscriptions/${accA}`);
      expect(getA.status).toBe(200);
      expect((getA.body as JsonObject)['plan']).toBe('starter');

      const getB = await fwd(app.engineUrl, 'GET', `/subscriptions/${accB}`);
      expect(getB.status).toBe(200);
      expect((getB.body as JsonObject)['plan']).toBe('enterprise');
    }, 30_000);
  });
});
