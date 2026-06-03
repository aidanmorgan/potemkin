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
 *   Job boundary (/jobs)           — latency: { fixed_ms: 60 }
 *   JobById boundary (/jobs/{id})  — no latency config (contrast)
 *   JobRanged boundary (/jobs/ranged) — latency: { min_ms: 40, max_ms: 80 }
 *   JobStacked boundary (/jobs/stacked) — latency: { fixed_ms: 20, min_ms: 30, max_ms: 60 }
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

// Uniform-random range boundary: latency: { min_ms: 40, max_ms: 80 }
const RANGE_MIN_MS = 40;
const RANGE_MAX_MS = 80;
// Timer slack: allow up to 10ms below the declared floor for OS scheduling jitter.
const RANGE_FLOOR_MS = RANGE_MIN_MS - 10;
// Generous ceiling: min_ms/max_ms range is small; add 2s headroom for CI load.
const RANGE_CEILING_MS = RANGE_MAX_MS + 2_000;

// Stacked latency boundary: latency: { fixed_ms: 20, min_ms: 30, max_ms: 60 }
// Total delay = fixed_ms + uniform([min_ms, max_ms]) = 20 + [30..60] = [50..80]
const STACK_FIXED_MS = 20;
const STACK_MIN_MS = 30;
const STACK_MAX_MS = 60;
const STACK_FLOOR_MS = STACK_FIXED_MS + STACK_MIN_MS - 10; // 40ms with 10ms slack
const STACK_CEILING_MS = STACK_FIXED_MS + STACK_MAX_MS + 2_000; // 80ms + CI headroom

// Number of requests to sample for range assertions.
const RANGE_SAMPLE_COUNT = 7;

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

  describe('JobRanged boundary (latency: { min_ms: 40, max_ms: 80 })', () => {
    it('every POST /jobs/ranged response is delayed within the declared uniform-random range', async () => {
      const delays: number[] = [];

      for (let i = 0; i < RANGE_SAMPLE_COUNT; i++) {
        const start = Date.now();
        const res = await fwd(app.engineUrl, 'POST', '/jobs/ranged', { name: `range-probe-${i}` });
        const elapsed = Date.now() - start;

        expect(res.status).toBe(201);
        delays.push(elapsed);
      }

      for (const elapsed of delays) {
        // Lower bound: allow 10ms timer slack below the declared min_ms.
        expect(elapsed).toBeGreaterThanOrEqual(RANGE_FLOOR_MS);
        // Upper bound: declared max_ms plus generous CI headroom.
        expect(elapsed).toBeLessThan(RANGE_CEILING_MS);
      }
    }, 60_000);

    it('POST /jobs/ranged response body contains the submitted job id and name', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/jobs/ranged', { name: 'range-body-check' });
      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      expect(typeof body['id']).toBe('string');
      expect((body['id'] as string).length).toBeGreaterThan(0);
      expect(body['name']).toBe('range-body-check');
    }, 30_000);
  });

  describe('JobStacked boundary (latency: { fixed_ms: 20, min_ms: 30, max_ms: 60 })', () => {
    it('every POST /jobs/stacked response is delayed at least fixed_ms + min_ms', async () => {
      const delays: number[] = [];

      for (let i = 0; i < RANGE_SAMPLE_COUNT; i++) {
        const start = Date.now();
        const res = await fwd(app.engineUrl, 'POST', '/jobs/stacked', { name: `stack-probe-${i}` });
        const elapsed = Date.now() - start;

        expect(res.status).toBe(201);
        delays.push(elapsed);
      }

      for (const elapsed of delays) {
        // Stacking: total >= fixed_ms + min_ms (with 10ms timer slack).
        expect(elapsed).toBeGreaterThanOrEqual(STACK_FLOOR_MS);
        // Upper bound: fixed_ms + max_ms plus generous CI headroom.
        expect(elapsed).toBeLessThan(STACK_CEILING_MS);
      }
    }, 60_000);
  });
});
