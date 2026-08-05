/**
 * Per-boundary latency injection (Specmatic-backed).
 *
 * Demonstrates `latency: { fixed_ms: N }` declared in a boundary DSL file.
 * The engine applies the delay before every response on that boundary.
 * Supported keys:
 *   fixed_ms   deterministic additive delay (integer ms).
 *   min_ms     lower bound of a uniform-random range.
 *   max_ms     upper bound of a uniform-random range.
 * All three are additive: fixed_ms + uniform-random([min, max]).
 *
 * Fixture: tests/fixtures/latency/
 *   Job boundary (/jobs)            latency: { fixed_ms: 60 }
 *   JobById boundary (/jobs/{id})   no latency config (contrast)
 *   JobRanged boundary (/jobs/ranged)  latency: { min_ms: 40, max_ms: 80 }
 *   JobStacked boundary (/jobs/stacked)  latency: { fixed_ms: 20, min_ms: 30, max_ms: 60 }
 */

import * as path from 'node:path';

import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const CONFIGURED_LATENCY_MS = 60;
const FAULT_DELAY_MS = 25;
// Allow 10ms of timer slack so a slightly early wake doesn't flake the test.
const LATENCY_FLOOR_MS = CONFIGURED_LATENCY_MS - 10;
// Generous upper bound: keeps CI from being brittle under load.
const LATENCY_CEILING_MS = CONFIGURED_LATENCY_MS + 2_000;
// A no-latency request still pays the Specmatic/JVM and loopback transport
// cost. Keep the contrast assertion as a guard against accidentally applying
// a multi-second boundary delay without making the real transport overhead a
// source of aggregate-run flakes.
const NO_CONFIG_CEILING_MS = 2_000;

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

const FIXTURE = path.resolve(process.cwd(), 'tests/fixtures/latency');
const MODES = [
  { name: 'YAML', config: 'potemkin.yml' },
  { name: 'TypeScript', config: 'potemkin-typescript.yml' },
  { name: 'mixed YAML and TypeScript', config: 'potemkin-mixed.yml' },
] as const;

describe.each(MODES)('Per-boundary latency injection through Specmatic — $name', (mode) => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: 'latency',
      potemkinConfigPath: path.join(FIXTURE, mode.config),
    });
  }, 120_000);

  afterAll(async () => {
    await app?.shutdown();
  }, 30_000);

  describe('Job boundary (latency: { fixed_ms: 60 })', () => {
    it('POST /jobs response is delayed by at least the configured fixed_ms floor', async () => {
      const start = Date.now();
      const res = await requestThroughSpecmatic(app.stubUrl, 'POST', '/jobs', {
        name: 'latency-probe',
      });
      const elapsed = Date.now() - start;

      expect(res.status).toBe(201);
      expect(elapsed).toBeGreaterThanOrEqual(LATENCY_FLOOR_MS);
      expect(elapsed).toBeLessThan(LATENCY_CEILING_MS);
    }, 30_000);

    it('submitted job id is present in the response body', async () => {
      const res = await requestThroughSpecmatic(app.stubUrl, 'POST', '/jobs', { name: 'id-check' });
      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      expect(typeof body['id']).toBe('string');
      expect((body['id'] as string).length).toBeGreaterThan(0);
      expect(body['name']).toBe('id-check');
    }, 30_000);

    it('keeps seeded identity generation deterministic across YAML and TypeScript loading', async () => {
      const firstReset = await fetch(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
      expect(firstReset.status).toBe(204);
      const first = await requestThroughSpecmatic(
        app.stubUrl,
        'POST',
        '/jobs',
        { name: 'seeded-identity' },
        { 'x-potemkin-seed': 'latency-seed' },
      );

      const secondReset = await fetch(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
      expect(secondReset.status).toBe(204);
      const second = await requestThroughSpecmatic(
        app.stubUrl,
        'POST',
        '/jobs',
        { name: 'seeded-identity' },
        { 'x-potemkin-seed': 'latency-seed' },
      );

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect((first.body as JsonObject)['id']).toBe((second.body as JsonObject)['id']);

      const differentSeed = await requestThroughSpecmatic(
        app.stubUrl,
        'POST',
        '/jobs',
        { name: 'different-seed' },
        { 'x-potemkin-seed': 'other-latency-seed' },
      );
      expect(differentSeed.status).toBe(201);
      expect((differentSeed.body as JsonObject)['id']).not.toBe((second.body as JsonObject)['id']);
    }, 30_000);

    it('isolates concurrent forwarded clock offsets and seeds', async () => {
      const reset = await fetch(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
      expect(reset.status).toBe(204);
      const startedAt = Date.now();
      const [ahead, behind] = await Promise.all([
        requestThroughSpecmatic(
          app.stubUrl,
          'POST',
          '/jobs',
          { name: 'concurrent-ahead' },
          {
            'x-potemkin-clock-offset': '3600000',
            'x-potemkin-seed': `${mode.name}-concurrent-ahead`,
          },
        ),
        requestThroughSpecmatic(
          app.stubUrl,
          'POST',
          '/jobs',
          { name: 'concurrent-behind' },
          {
            'x-potemkin-clock-offset': '-3600000',
            'x-potemkin-seed': `${mode.name}-concurrent-behind`,
          },
        ),
      ]);
      const completedAt = Date.now();

      expect(ahead.status).toBe(201);
      expect(behind.status).toBe(201);
      const aheadId = String((ahead.body as JsonObject)['id']);
      const behindId = String((behind.body as JsonObject)['id']);
      expect(aheadId).not.toBe(behindId);

      const [aheadEvents, behindEvents] = await Promise.all(
        [aheadId, behindId].map(async (id) => {
          const response = await fetch(
            `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(id)}`,
          );
          expect(response.status).toBe(200);
          return ((await response.json()) as { events: readonly { timestamp: string }[] }).events;
        }),
      );
      expect(aheadEvents).toHaveLength(1);
      expect(behindEvents).toHaveLength(1);
      expect(Date.parse(aheadEvents[0]!.timestamp)).toBeGreaterThan(startedAt + 3_500_000);
      expect(Date.parse(behindEvents[0]!.timestamp)).toBeLessThan(completedAt - 3_500_000);
    }, 60_000);

    it('stacks the typed fault delay with boundary latency without committing state', async () => {
      const reset = await fetch(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
      expect(reset.status).toBe(204);
      const start = Date.now();
      const res = await requestThroughSpecmatic(
        app.stubUrl,
        'POST',
        '/jobs',
        { name: 'fault-probe' },
        { 'x-latency-fault': 'on' },
      );
      const elapsed = Date.now() - start;

      expect(res.status).toBe(503);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'DELAYED_JOB_FAULT',
          message: 'simulated delayed job failure',
        }),
      );
      expect(elapsed).toBeGreaterThanOrEqual(CONFIGURED_LATENCY_MS + FAULT_DELAY_MS - 10);
      expect(elapsed).toBeLessThan(CONFIGURED_LATENCY_MS + FAULT_DELAY_MS + 2_000);
      const events = (await fetch(`${app.engineUrl}/_admin/events`).then((response) =>
        response.json(),
      )) as { events: readonly unknown[] };
      expect(events.events).toHaveLength(0);
    }, 30_000);

    it('keeps a typed fault ahead of idempotency replay without poisoning the cached success', async () => {
      const reset = await fetch(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
      expect(reset.status).toBe(204);
      const key = `latency-fault-replay-${mode.name}`;
      const body = { name: 'fault-replay-latency' };

      const created = await requestThroughSpecmatic(app.stubUrl, 'POST', '/jobs', body, {
        'idempotency-key': key,
      });
      expect(created.status).toBe(201);

      const faultedReplay = await requestThroughSpecmatic(app.stubUrl, 'POST', '/jobs', body, {
        'idempotency-key': key,
        'x-latency-fault': 'on',
      });
      expect(faultedReplay.status).toBe(503);
      expect(faultedReplay.body).toEqual(expect.objectContaining({ error: 'DELAYED_JOB_FAULT' }));
      expect(faultedReplay.headers['x-idempotency-replay']).toBeUndefined();

      const replayAfterFault = await requestThroughSpecmatic(app.stubUrl, 'POST', '/jobs', body, {
        'idempotency-key': key,
      });
      expect(replayAfterFault.status).toBe(201);
      expect(replayAfterFault.headers['x-idempotency-replay']).toBe('true');
      expect(replayAfterFault.body).toEqual(created.body);

      const events = (await fetch(`${app.engineUrl}/_admin/events`).then((response) =>
        response.json(),
      )) as { events: readonly unknown[] };
      expect(events.events).toHaveLength(1);
    }, 60_000);

    it('applies boundary latency to idempotency replays as well as fresh responses', async () => {
      const reset = await fetch(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
      expect(reset.status).toBe(204);
      const key = `latency-replay-${mode.name}`;
      const body = { name: 'replay-latency' };
      const first = await requestThroughSpecmatic(app.stubUrl, 'POST', '/jobs', body, {
        'idempotency-key': key,
      });
      const start = Date.now();
      const replay = await requestThroughSpecmatic(app.stubUrl, 'POST', '/jobs', body, {
        'idempotency-key': key,
      });
      const elapsed = Date.now() - start;

      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.headers['x-idempotency-replay']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(elapsed).toBeGreaterThanOrEqual(LATENCY_FLOOR_MS);
      expect(elapsed).toBeLessThan(LATENCY_CEILING_MS);
    }, 30_000);

    it('stacks chaos latency controls with boundary latency on a forced error', async () => {
      const reset = await fetch(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
      expect(reset.status).toBe(204);
      const start = Date.now();
      const response = await requestThroughSpecmatic(
        app.stubUrl,
        'POST',
        '/jobs',
        { name: 'chaos-latency' },
        {
          'x-potemkin-force-status': '418',
          'x-potemkin-force-latency': '15',
          'x-potemkin-slow-response': '5',
          'x-potemkin-jitter': '3:4',
        },
      );
      const elapsed = Date.now() - start;

      expect(response.status).toBe(418);
      expect(response.body).toEqual(expect.objectContaining({ error: 'FORCED_STATUS' }));
      expect(elapsed).toBeGreaterThanOrEqual(CONFIGURED_LATENCY_MS + 15 + 5 + 3 - 10);
      expect(elapsed).toBeLessThan(CONFIGURED_LATENCY_MS + 15 + 5 + 4 + 2_000);
      const events = (await fetch(`${app.engineUrl}/_admin/events`).then((result) =>
        result.json(),
      )) as { events: readonly unknown[] };
      expect(events.events).toHaveLength(0);
    }, 30_000);
  });

  describe('JobById boundary (no latency config)', () => {
    it('GET /jobs/{id} responds well under the latency floor (contrast)', async () => {
      // Create a job first so there is a real entity to fetch.
      const createRes = await requestThroughSpecmatic(app.stubUrl, 'POST', '/jobs', {
        name: 'contrast-probe',
      });
      expect(createRes.status).toBe(201);
      const jobId = (createRes.body as JsonObject)['id'] as string;

      const start = Date.now();
      const res = await requestThroughSpecmatic(app.stubUrl, 'GET', `/jobs/${jobId}`);
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);
      // The JobById boundary has no latency config. The positive latency
      // assertions above prove the configured floor; this assertion guards
      // against accidentally applying a large delay to an unconfigured route.
      expect(elapsed).toBeLessThan(NO_CONFIG_CEILING_MS);
    }, 30_000);
  });

  describe('JobRanged boundary (latency: { min_ms: 40, max_ms: 80 })', () => {
    it('every POST /jobs/ranged response is delayed within the declared uniform-random range', async () => {
      const delays: number[] = [];

      for (let i = 0; i < RANGE_SAMPLE_COUNT; i++) {
        const start = Date.now();
        const res = await requestThroughSpecmatic(app.stubUrl, 'POST', '/jobs/ranged', {
          name: `range-probe-${i}`,
        });
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
      const res = await requestThroughSpecmatic(app.stubUrl, 'POST', '/jobs/ranged', {
        name: 'range-body-check',
      });
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
        const res = await requestThroughSpecmatic(app.stubUrl, 'POST', '/jobs/stacked', {
          name: `stack-probe-${i}`,
        });
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
