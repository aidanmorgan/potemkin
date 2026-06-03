/**
 * 65 — Per-boundary latency injection (engine-only).
 *
 * Demonstrates `latency: { fixed_ms: N }` declared in a boundary DSL file.
 * The engine applies the delay before every response on that boundary.
 * Supported keys:
 *   fixed_ms  — deterministic additive delay (integer ms).
 *   min_ms    — lower bound of a uniform-random range.
 *   max_ms    — upper bound of a uniform-random range.
 * All three are additive: fixed_ms + uniform-random([min, max]).
 *
 * Fixture: tests/fixtures/latency/
 *   Job boundary (/jobs)        — latency: { fixed_ms: 60 }
 *   JobById boundary (/jobs/id) — no latency config (contrast)
 */

import { startEngineOnlyApp } from './_harness/engine-only-app';
import type { EngineOnlyApp } from './_harness/engine-only-app';
import { fwd } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const CONFIGURED_LATENCY_MS = 60;
// Allow 10ms of timer slack so a slightly early wake doesn't flake the test.
const LATENCY_FLOOR_MS = CONFIGURED_LATENCY_MS - 10;
// Generous upper bound: keeps CI from being brittle under load.
const LATENCY_CEILING_MS = CONFIGURED_LATENCY_MS + 2_000;

describe('65 — Per-boundary latency injection (engine-only)', () => {
  let app: EngineOnlyApp;

  beforeAll(async () => {
    app = await startEngineOnlyApp({ fixtureName: 'latency' });
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  describe('Job boundary (latency: { fixed_ms: 60 })', () => {
    it('POST /jobs response is delayed by at least the configured fixed_ms floor', async () => {
      const start = Date.now();
      const res = await fwd(app.engineUrl, 'POST', '/jobs', { name: 'latency-probe' });
      const elapsed = Date.now() - start;

      expect(res.status).toBe(201);
      expect(elapsed).toBeGreaterThanOrEqual(LATENCY_FLOOR_MS);
      expect(elapsed).toBeLessThan(LATENCY_CEILING_MS);
    }, 30_000);

    it('submitted job id is present in the response body', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/jobs', { name: 'id-check' });
      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      expect(typeof body['id']).toBe('string');
      expect((body['id'] as string).length).toBeGreaterThan(0);
      expect(body['name']).toBe('id-check');
    }, 30_000);
  });

  describe('JobById boundary (no latency config)', () => {
    it('GET /jobs/{id} responds well under the latency floor (contrast)', async () => {
      // Create a job first so there is a real entity to fetch.
      const createRes = await fwd(app.engineUrl, 'POST', '/jobs', { name: 'contrast-probe' });
      expect(createRes.status).toBe(201);
      const jobId = (createRes.body as JsonObject)['id'] as string;

      const start = Date.now();
      const res = await fwd(app.engineUrl, 'GET', `/jobs/${jobId}`);
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);
      // The JobById boundary has no latency config; it should be materially
      // faster than the configured floor, even accounting for HTTP overhead.
      expect(elapsed).toBeLessThan(CONFIGURED_LATENCY_MS);
    }, 30_000);
  });
});
