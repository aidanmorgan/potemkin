/**
 * Integration tests for GET /_engine/routes.
 *
 * Boots the CRM fixture and exercises the routes discovery endpoint
 * end-to-end via supertest, verifying that the engine returns the correct
 * set of CRM contract paths with correct response shape and headers.
 *
 * Scenarios:
 *  1. GET /_engine/routes returns HTTP 200.
 *  2. Response contains the expected CRM paths, sorted alphabetically.
 *  3. ETag header is non-empty and equal to the body checksum.
 *  4. Two successive calls with no boot-state change → same ETag.
 *  5. If-None-Match with the current ETag → 304 Not Modified.
 *  6. Response ttlSeconds defaults to 30 (no env override).
 *  7. engine field is 'potemkin-stateful'.
 */

import type { RoutesDiscoveryResponse } from '../../../src/forwarding/types.js';
import { bootCrmAgent, type CrmAgent } from '../_helpers/crm-boot.js';

// Expected CRM contract paths (sorted alphabetically).
const EXPECTED_CRM_PATHS = [
  '/agents',
  '/agents/{id}',
  '/agents/{id}/status',
  '/calls',
  '/calls/{id}',
  '/calls/{id}/transcript',
  '/campaigns',
  '/campaigns/{id}',
  '/campaigns/{id}/activate',
  '/campaigns/{id}/complete',
  '/campaigns/{id}/pause',
  '/leads',
  '/leads/{id}',
  '/leads/{id}/contact',
  '/leads/{id}/convert',
  '/leads/{id}/disqualify',
  '/leads/{id}/dnc',
  '/leads/{id}/notes',
  '/leads/{id}/qualify',
  '/opportunities',
  '/opportunities/{id}',
  '/opportunities/{id}/advance',
  '/opportunities/{id}/close',
  '/opportunities/{id}/line-items',
];

describe('GET /_engine/routes — integration', () => {
  let agent: CrmAgent['agent'];

  beforeAll(async () => {
    const booted = await bootCrmAgent();
    agent = booted.agent;
  });

  afterAll(() => {
    delete process.env['ENGINE_ROUTES_TTL_SECONDS'];
  });

  // ── 1. HTTP 200 ──────────────────────────────────────────────────────────────

  it('responds with HTTP 200', async () => {
    await agent.get('/_engine/routes').expect(200);
  });

  // ── 2. Correct CRM paths, sorted ─────────────────────────────────────────────

  it('returns all CRM contract paths sorted alphabetically', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    const body = res.body as RoutesDiscoveryResponse;

    expect(Array.isArray(body.paths)).toBe(true);
    expect(body.paths).toEqual(EXPECTED_CRM_PATHS);
  });

  // ── 3. ETag header is non-empty and equals checksum ──────────────────────────

  it('ETag header is non-empty and matches the body checksum', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    const body = res.body as RoutesDiscoveryResponse;
    const etag = res.headers['etag'] as string;

    expect(etag).toBeTruthy();
    expect(etag.length).toBeGreaterThan(0);
    // ETag is an RFC 7232 quoted-string wrapping the body checksum.
    expect(etag).toBe(`"${body.checksum}"`);
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
