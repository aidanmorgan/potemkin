/**
 * Unit tests for the GET /_engine/routes handler (createRoutesHandler).
 *
 * Tests:
 *  - Response includes all paths from dsl.byContractPath, sorted alphabetically.
 *  - Response shape matches RoutesDiscoveryResponse interface.
 *  - Checksum is a stable hex string that is consistent across multiple calls.
 *  - If-None-Match with matching checksum → 304 Not Modified with empty body.
 *  - If-None-Match with stale/non-matching checksum → 200 with full body.
 *  - Cache-Control header is set to max-age=<ttl>, public.
 *  - ETag header equals the checksum.
 *  - ttlSeconds defaults to 30 when ENGINE_ROUTES_TTL_SECONDS is not set.
 *  - ttlSeconds honours ENGINE_ROUTES_TTL_SECONDS env var override.
 */

import express from 'express';
import { createHash } from 'node:crypto';
import { createRoutesHandler } from '../../../src/forwarding/handler.js';
import type { BootedSystem } from '../../../src/engine/boot.js';
import type { RoutesDiscoveryResponse } from '../../../src/forwarding/types.js';
import {
  withPersistentServer,
  type PersistentAgent,
} from '../../_support/persistentAgent.js';
import { registerFileTeardown } from '../../_support/testTeardown.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal BootedSystem stub with a known dsl.byContractPath map.
 * Only the fields accessed by createRoutesHandler are populated.
 */
function makeStubSystem(contractPaths: string[]): BootedSystem {
  const byContractPath: Record<string, unknown> = {};
  for (const p of contractPaths) {
    byContractPath[p] = {};
  }

  return {
    dsl: {
      byContractPath,
    },
  } as unknown as BootedSystem;
}

/**
 * Create a minimal Express app wired with the routes handler, served by ONE
 * persistent keep-alive server (closed at file end) instead of supertest's
 * per-call ephemeral app.listen(0).
 */
async function makeAgent(sys: BootedSystem): Promise<PersistentAgent> {
  const app = express();
  app.get('/_engine/routes', createRoutesHandler(sys));
  const persistent = await withPersistentServer(app);
  registerFileTeardown(persistent.close);
  return persistent.agent;
}

/**
 * Compute the expected checksum for a sorted list of paths (mirrors handler implementation).
 */
function expectedChecksum(sortedPaths: string[]): string {
  return createHash('sha256').update(sortedPaths.join('\n')).digest('hex');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('createRoutesHandler — GET /_engine/routes', () => {
  const CONTRACT_PATHS = ['/customers', '/loans', '/loans/{id}'];
  const SORTED_PATHS = [...CONTRACT_PATHS].sort(); // ['/customers', '/loans', '/loans/{id}']

  let sys: BootedSystem;
  let agent: PersistentAgent;

  beforeEach(async () => {
    // Clear any env override before each test.
    delete process.env['ENGINE_ROUTES_TTL_SECONDS'];
    sys = makeStubSystem(CONTRACT_PATHS);
    agent = await makeAgent(sys);
  });

  afterEach(() => {
    delete process.env['ENGINE_ROUTES_TTL_SECONDS'];
  });

  // ── Response shape ──────────────────────────────────────────────────────────

  it('returns HTTP 200', async () => {
    await agent.get('/_engine/routes').expect(200);
  });

  it('returns all contract paths sorted alphabetically', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    const body = res.body as RoutesDiscoveryResponse;
    expect(body.paths).toEqual(SORTED_PATHS);
  });

  it('returns engine field equal to "potemkin-stateful"', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    expect((res.body as RoutesDiscoveryResponse).engine).toBe('potemkin-stateful');
  });

  it('returns a non-empty version string', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    expect(typeof (res.body as RoutesDiscoveryResponse).version).toBe('string');
    expect((res.body as RoutesDiscoveryResponse).version.length).toBeGreaterThan(0);
  });

  it('returns a generatedAt ISO-8601 timestamp', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    const { generatedAt } = res.body as RoutesDiscoveryResponse;
    expect(typeof generatedAt).toBe('string');
    expect(() => new Date(generatedAt)).not.toThrow();
    expect(new Date(generatedAt).toISOString()).toBe(generatedAt);
  });

  it('returns a checksum that is a 64-char hex string', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    const { checksum } = res.body as RoutesDiscoveryResponse;
    expect(typeof checksum).toBe('string');
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns checksum equal to sha256 of sorted paths joined with newlines', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    expect((res.body as RoutesDiscoveryResponse).checksum).toBe(expectedChecksum(SORTED_PATHS));
  });

  // ── Checksum stability ─────────────────────────────────────────────────────

  it('returns the same checksum on two successive calls without boot state change', async () => {
    const res1 = await agent.get('/_engine/routes').expect(200);
    const res2 = await agent.get('/_engine/routes').expect(200);
    expect((res1.body as RoutesDiscoveryResponse).checksum)
      .toBe((res2.body as RoutesDiscoveryResponse).checksum);
  });

  // ── Cache headers ──────────────────────────────────────────────────────────

  it('includes Cache-Control: max-age=30, public header by default', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    expect(res.headers['cache-control']).toBe('max-age=30, public');
  });

  it('includes ETag header wrapped in double-quotes (potemkin-2x2c)', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    const { checksum } = res.body as RoutesDiscoveryResponse;
    expect(res.headers['etag']).toBe(`"${checksum}"`);
  });

  // ── Conditional requests (If-None-Match) ──────────────────────────────────

  it('responds 304 when If-None-Match is the quoted ETag echoed from a prior 200 (potemkin-2x2c)', async () => {
    const first = await agent.get('/_engine/routes').expect(200);
    const etag = first.headers['etag'] as string; // e.g. '"<hex>"'

    const res = await agent
      .get('/_engine/routes')
      .set('If-None-Match', etag)
      .expect(304);

    expect(res.text).toBe('');
  });

  it('responds 304 when If-None-Match is the bare checksum (quote-tolerant compare)', async () => {
    const first = await agent.get('/_engine/routes').expect(200);
    const checksum = (first.body as RoutesDiscoveryResponse).checksum;

    const res = await agent
      .get('/_engine/routes')
      .set('If-None-Match', checksum)
      .expect(304);

    expect(res.text).toBe('');
  });

  it('responds 200 with full body when If-None-Match does not match', async () => {
    const staleChecksum = 'a'.repeat(64); // a checksum that won't match

    const res = await agent
      .get('/_engine/routes')
      .set('If-None-Match', staleChecksum)
      .expect(200);

    expect((res.body as RoutesDiscoveryResponse).paths).toEqual(SORTED_PATHS);
  });

  // ── TTL / ttlSeconds ───────────────────────────────────────────────────────

  it('returns default ttlSeconds of 30 when env var is not set', async () => {
    const res = await agent.get('/_engine/routes').expect(200);
    expect((res.body as RoutesDiscoveryResponse).ttlSeconds).toBe(30);
  });

  it('honours ENGINE_ROUTES_TTL_SECONDS env var for ttlSeconds', async () => {
    process.env['ENGINE_ROUTES_TTL_SECONDS'] = '60';
    // Rebuild app so the handler reads the updated env var.
    const agentWithOverride = await makeAgent(makeStubSystem(CONTRACT_PATHS));

    const res = await agentWithOverride.get('/_engine/routes').expect(200);
    expect((res.body as RoutesDiscoveryResponse).ttlSeconds).toBe(60);
    expect(res.headers['cache-control']).toBe('max-age=60, public');
  });

  it('falls back to default TTL of 30 when ENGINE_ROUTES_TTL_SECONDS is not a positive integer', async () => {
    process.env['ENGINE_ROUTES_TTL_SECONDS'] = 'not-a-number';
    const agentWithBadEnv = await makeAgent(makeStubSystem(CONTRACT_PATHS));

    const res = await agentWithBadEnv.get('/_engine/routes').expect(200);
    expect((res.body as RoutesDiscoveryResponse).ttlSeconds).toBe(30);
  });

  // ── Paths are sorted regardless of insertion order ────────────────────────

  it('sorts paths alphabetically regardless of insertion order in dsl.byContractPath', async () => {
    const unsortedPaths = ['/loans/{id}', '/customers', '/loans'];
    const agentUnsorted = await makeAgent(makeStubSystem(unsortedPaths));

    const res = await agentUnsorted.get('/_engine/routes').expect(200);
    expect((res.body as RoutesDiscoveryResponse).paths).toEqual([...unsortedPaths].sort());
  });
});
