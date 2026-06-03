/**
 * 61 — identity.key: aggregate id extracted from a request header.
 *
 * Demonstrates that identity.key.from: header lets a boundary derive its
 * aggregate id from a request header instead of a URL path parameter.
 *
 * Fixture: tests/fixtures/identity-key
 *
 *   Boundary Token (POST /tokens):
 *     identity.key.from: header, name: x-token-id
 *     identity.creation.generate: $uuidv7()   ← fallback when header absent
 *
 *   Boundary TokenById (GET /tokens/{id}):
 *     standard path-param lookup — reads back what the POST stored.
 *
 * Test assertions:
 *   1. POST with X-Token-Id: <explicit-id> → 201, body.id === explicit-id.
 *   2. GET /tokens/<explicit-id>            → 200, entity retrieved by that id.
 *   3. POST without X-Token-Id header       → 201, body.id is a generated UUIDv7
 *      (proves identity.key + identity.creation.generate coexist).
 *   4. GET /tokens/<explicit-id> after a second POST with a different header
 *      value → 200, proves each call is keyed independently by its header value.
 *
 * Transport: engine-only (startEngineOnlyApp) — no Specmatic JVM required.
 */

import { startEngineOnlyApp } from './_harness/engine-only-app';
import type { EngineOnlyApp } from './_harness/engine-only-app';
import { fwd, getGraphNode } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

// A deterministic token id that cannot be confused with a UUIDv7.
const EXPLICIT_TOKEN_ID = 'tok_header_derived_001';

describe('61 — identity.key: header-derived aggregate id (engine-only)', () => {
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
});
