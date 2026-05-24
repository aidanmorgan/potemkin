/**
 * Integration tests for GET /_engine/routes.
 *
 * Boots the banking fixture and exercises the routes discovery endpoint
 * end-to-end via supertest, verifying that the engine returns the correct
 * set of banking contract paths with correct response shape and headers.
 *
 * Scenarios:
 *  1. GET /_engine/routes returns HTTP 200.
 *  2. Response contains the expected banking paths, sorted alphabetically.
 *  3. ETag header is non-empty and equal to the body checksum.
 *  4. Two successive calls with no boot-state change → same ETag.
 *  5. If-None-Match with the current ETag → 304 Not Modified.
 *  6. Response ttlSeconds defaults to 30 (no env override).
 *  7. engine field is 'potemkin-stateful'.
 */

import request from 'supertest';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';
import type { BootedSystem } from '../../../src/engine/boot.js';
import type { RoutesDiscoveryResponse } from '../../../src/forwarding/types.js';

// Expected banking contract paths (sorted alphabetically).
const EXPECTED_BANKING_PATHS = [
  '/customers',
  '/customers/{id}',
  '/loans',
  '/loans/{id}',
  '/loans/{id}/disburse',
  '/loans/{id}/repay',
];

describe('GET /_engine/routes — integration', () => {
  let sys: BootedSystem;
  let agent: ReturnType<typeof request>;

  beforeAll(async () => {
    const fixture = await loadBankingFixture();
    sys = await bootSystem(fixture);
    const app = createGateway(sys);
    agent = request(app);
  });

  afterAll(() => {
    delete process.env['ENGINE_ROUTES_TTL_SECONDS'];
  });

  // ── 1. HTTP 200 ──────────────────────────────────────────────────────────────

  it('responds with HTTP 200', async () => {
    await agent.get('/_engine/routes').expect(200);
  });

  // ── 2. Correct banking paths, sorted ─────────────────────────────────────────

  it('returns all banking contract paths sorted alphabetically', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    const body = res.body as RoutesDiscoveryResponse;

    expect(Array.isArray(body.paths)).toBe(true);
    expect(body.paths).toEqual(EXPECTED_BANKING_PATHS);
  });

  // ── 3. ETag header is non-empty and equals checksum ──────────────────────────

  it('ETag header is non-empty and matches the body checksum', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    const body = res.body as RoutesDiscoveryResponse;
    const etag = res.headers['etag'] as string;

    expect(etag).toBeTruthy();
    expect(etag.length).toBeGreaterThan(0);
    expect(etag).toBe(body.checksum);
  });

  // ── 4. Two successive calls → same ETag ──────────────────────────────────────

  it('returns the same ETag on two successive calls without state change', async () => {
    const res1 = await agent.get('/_engine/routes').expect(200);
    const res2 = await agent.get('/_engine/routes').expect(200);

    expect(res1.headers['etag']).toBe(res2.headers['etag']);
    expect((res1.body as RoutesDiscoveryResponse).checksum)
      .toBe((res2.body as RoutesDiscoveryResponse).checksum);
  });

  // ── 5. Conditional request → 304 ─────────────────────────────────────────────

  it('responds 304 when If-None-Match matches the current ETag', async () => {
    const first = await agent.get('/_engine/routes').expect(200);
    const etag = first.headers['etag'] as string;

    const second = await agent
      .get('/_engine/routes')
      .set('If-None-Match', etag)
      .expect(304);

    expect(second.text).toBe('');
  });

  // ── 6. Default ttlSeconds ─────────────────────────────────────────────────────

  it('returns ttlSeconds of 30 by default', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    expect((res.body as RoutesDiscoveryResponse).ttlSeconds).toBe(30);
  });

  // ── 7. engine field ───────────────────────────────────────────────────────────

  it('returns engine field equal to "potemkin-stateful"', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    expect((res.body as RoutesDiscoveryResponse).engine).toBe('potemkin-stateful');
  });

  // ── 8. Cache-Control header ───────────────────────────────────────────────────

  it('includes Cache-Control: max-age=30, public header', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    expect(res.headers['cache-control']).toBe('max-age=30, public');
  });
});
