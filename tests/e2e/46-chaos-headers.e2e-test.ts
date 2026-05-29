/**
 * 46 — Header-triggered chaos behaviors via full Specmatic stack.
 *
 * Verifies the three direct chaos headers complement (and stack with) the
 * YAML-defined chaos rules:
 *
 *   - X-Potemkin-Force-Latency: <ms>
 *       Stack additional latency on top of any boundary-level `latency:` config.
 *
 *   - X-Potemkin-Force-Status: <int 100..599>
 *       Short-circuit with the requested status and a generic body. YAML
 *       fault matching via `headers:` takes precedence when configured.
 *
 *   - X-Potemkin-Use-Fault: <rule-name>
 *       Invoke a named YAML fault rule by `name:` regardless of its own match
 *       conditions, returning the rule's response verbatim.
 *
 * All three headers are emitted by clients as opt-in chaos signals — the YAML
 * still owns the response shape for `Use-Fault`.
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { fwd, javaAvailable } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';

describeWithJava('46 — Header-triggered chaos (full Specmatic stack)', () => {
  let app: E2eApp;
  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ── X-Potemkin-Force-Status ─────────────────────────────────────────────

  describe('X-Potemkin-Force-Status forces an HTTP status', () => {
    it('value 503 returns a 503 response with a generic body', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-force-status': '503' },
      );
      expect(res.status).toBe(503);
      expect((res.body as JsonObject)['error']).toBe('FORCED_STATUS');
      expect((res.body as JsonObject)['status']).toBe(503);
    }, 60_000);

    it('value 418 (teapot) is honoured', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`, null,
        { 'x-potemkin-force-status': '418' },
      );
      expect(res.status).toBe(418);
    }, 60_000);

    it('non-numeric value is ignored — normal response returned', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-force-status': 'not-a-number' },
      );
      expect(res.status).toBe(200);
    }, 60_000);

    it('out-of-range value (e.g. 999) is ignored — normal response returned', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-force-status': '999' },
      );
      expect(res.status).toBe(200);
    }, 60_000);
  });

  // ── X-Potemkin-Force-Latency ─────────────────────────────────────────────

  describe('X-Potemkin-Force-Latency adds latency to the response', () => {
    it('value 300ms causes the response to take >= 250ms', async () => {
      const start = Date.now();
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-force-latency': '300' },
      );
      const elapsed = Date.now() - start;
      expect(res.status).toBe(200);
      expect(elapsed).toBeGreaterThanOrEqual(250);
    }, 60_000);

    it('latency stacks with boundary-level latency on LeadAddNote (50ms baseline)', async () => {
      const start = Date.now();
      const res = await fwd(
        app.engineUrl, 'POST', `/leads/${APEX_LEAD_ID}/notes`,
        { text: 'latency stack test', author: 'Chaos' },
        { 'x-potemkin-force-latency': '200' },
      );
      const elapsed = Date.now() - start;
      expect(res.status).toBe(200);
      // LeadAddNote has fixed_ms: 50; chaos adds 200; total >= 200.
      expect(elapsed).toBeGreaterThanOrEqual(200);
    }, 60_000);

    it('latency without status override returns normal body', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`, null,
        { 'x-potemkin-force-latency': '100' },
      );
      expect(res.status).toBe(200);
      expect((res.body as JsonObject)['id']).toBe(APEX_LEAD_ID);
    }, 60_000);

    it('non-numeric latency value is ignored — no delay applied', async () => {
      const start = Date.now();
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-force-latency': 'fast' },
      );
      const elapsed = Date.now() - start;
      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(500);
    }, 60_000);
  });

  // ── X-Potemkin-Use-Fault ─────────────────────────────────────────────────

  describe('X-Potemkin-Use-Fault invokes a named YAML rule by name', () => {
    it('"rate-limit-via-header" returns the YAML-defined 429 response', async () => {
      // The global.yaml rule name is "rate-limit-via-header". Even though
      // its OWN match.condition would not normally fire on this request,
      // X-Potemkin-Use-Fault invokes the response directly.
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-use-fault': 'rate-limit-via-header' },
      );
      expect(res.status).toBe(429);
      expect((res.body as JsonObject)['error']).toBe('RATE_LIMITED');
      expect(res.headers['retry-after']).toBe('30');
    }, 60_000);

    it('"maintenance-mode-via-header" returns the YAML-defined 503 response', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`, null,
        { 'x-potemkin-use-fault': 'maintenance-mode-via-header' },
      );
      expect(res.status).toBe(503);
      expect((res.body as JsonObject)['error']).toBe('SERVICE_UNAVAILABLE');
    }, 60_000);

    it('unknown rule name is ignored — normal response returned', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-use-fault': 'rule-that-does-not-exist' },
      );
      expect(res.status).toBe(200);
    }, 60_000);
  });

  // ── Precedence & combination ─────────────────────────────────────────────

  describe('Precedence: Use-Fault > Force-Status; Force-Latency stacks', () => {
    it('Use-Fault takes precedence over Force-Status when both present', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        {
          'x-potemkin-use-fault': 'rate-limit-via-header',
          'x-potemkin-force-status': '500',
        },
      );
      // Use-Fault wins — 429 from the YAML rule, not 500.
      expect(res.status).toBe(429);
    }, 60_000);

    it('Use-Fault + Force-Latency: latency is applied before the rule response', async () => {
      const start = Date.now();
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        {
          'x-potemkin-use-fault': 'rate-limit-via-header',
          'x-potemkin-force-latency': '250',
        },
      );
      const elapsed = Date.now() - start;
      expect(res.status).toBe(429);
      expect(elapsed).toBeGreaterThanOrEqual(200);
    }, 60_000);
  });

  // ── YAML response wins over chaos defaults ───────────────────────────────

  describe('YAML rules can define the response when chaos headers fire', () => {
    it('Force-Status=599 with a matching YAML rule returns the YAML body, not the generic forced-status body', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-force-status': '599' },
      );
      expect(res.status).toBe(599);
      const body = res.body as JsonObject;
      // YAML-defined fields override the generic body
      expect(body['error']).toBe('UPSTREAM_BACKPRESSURE');
      expect(body['hint']).toBe('Client should back off and retry with a smaller batch.');
      // Generic body would have set error: 'FORCED_STATUS' — confirm it didn't
      expect(body['error']).not.toBe('FORCED_STATUS');
      // YAML-defined headers come through
      expect(res.headers['retry-after']).toBe('15');
    }, 60_000);

    it('Force-Status=500 with NO matching YAML rule falls back to the generic body', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-force-status': '500' },
      );
      expect(res.status).toBe(500);
      const body = res.body as JsonObject;
      // No YAML rule matches force_status=500 → engine emits the generic shape
      expect(body['error']).toBe('FORCED_STATUS');
      expect(body['status']).toBe(500);
    }, 60_000);

    it('Force-Latency=750 with a matching YAML rule returns the YAML 202 body after the requested delay', async () => {
      const start = Date.now();
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-force-latency': '750' },
      );
      const elapsed = Date.now() - start;
      expect(res.status).toBe(202);
      const body = res.body as JsonObject;
      expect(body['accepted']).toBe(true);
      expect(body['delayed']).toBe(true);
      // The configured latency is applied before the YAML response is sent.
      expect(elapsed).toBeGreaterThanOrEqual(700);
    }, 60_000);

    it('Force-Latency=100 with NO matching YAML rule still adds delay but returns normal response', async () => {
      const start = Date.now();
      const res = await fwd(app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-force-latency': '100' });
      const elapsed = Date.now() - start;
      // No YAML rule matches force_latency=100 → normal collection response returns
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(80);
    }, 60_000);
  });

  // ── X-Potemkin-Error-Class — canonical HTTP errors ───────────────────────

  describe('X-Potemkin-Error-Class maps to canonical chaos responses', () => {
    it('"timeout" returns 504 by default', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-error-class': 'timeout' },
      );
      expect(res.status).toBe(504);
      expect((res.body as JsonObject)['error']).toBe('GATEWAY_TIMEOUT');
    }, 60_000);

    it('"outage" returns 503 by default', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-error-class': 'outage' },
      );
      expect(res.status).toBe(503);
      expect((res.body as JsonObject)['error']).toBe('SERVICE_UNAVAILABLE');
    }, 60_000);

    it('"bad_gateway" returns 502 by default', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-error-class': 'bad_gateway' },
      );
      expect(res.status).toBe(502);
      expect((res.body as JsonObject)['error']).toBe('BAD_GATEWAY');
    }, 60_000);

    it('"throttle" with a YAML matcher returns the YAML body, not the canonical 429', async () => {
      // The fixture defines `error-class-throttle-custom` which overrides the canonical
      // 429/TOO_MANY_REQUESTS body with a QUOTA_EXCEEDED variant.
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-error-class': 'throttle' },
      );
      expect(res.status).toBe(429);
      const body = res.body as JsonObject;
      expect(body['error']).toBe('QUOTA_EXCEEDED');
      expect(body['quotaRemaining']).toBe(0);
      expect(res.headers['retry-after']).toBe('45');
    }, 60_000);

    it('unknown error class is ignored — normal response returned', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-error-class': 'gibberish' },
      );
      expect(res.status).toBe(200);
    }, 60_000);
  });

  // ── X-Potemkin-Retry-After — attaches to chaos responses ────────────────

  describe('X-Potemkin-Retry-After is attached to chaos responses', () => {
    it('Force-Status=503 + Retry-After=10 attaches Retry-After header to the response', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        {
          'x-potemkin-force-status': '503',
          'x-potemkin-retry-after': '10',
        },
      );
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('10');
    }, 60_000);

    it('Error-Class=outage + Retry-After=30 attaches Retry-After', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        {
          'x-potemkin-error-class': 'outage',
          'x-potemkin-retry-after': '30',
        },
      );
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('30');
    }, 60_000);
  });

  // ── X-Potemkin-Jitter — uniform-random latency ──────────────────────────

  describe('X-Potemkin-Jitter adds uniform-random latency', () => {
    it('jitter range "200:400" adds 200..400 ms of delay (YAML body wins)', async () => {
      // The fixture defines a `jitter-yaml-response` rule that matches any
      // x-potemkin-jitter value and returns a 200 body with jittered: true.
      const start = Date.now();
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-jitter': '200:400' },
      );
      const elapsed = Date.now() - start;
      expect(res.status).toBe(200);
      expect((res.body as JsonObject)['jittered']).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(180);
    }, 60_000);

    it('jitter single-value "150" treated as 0..150 ms', async () => {
      const start = Date.now();
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-jitter': '150' },
      );
      const elapsed = Date.now() - start;
      expect(res.status).toBe(200);
      // The actual delay is random in 0..150 ms; just assert the request returned.
      expect(elapsed).toBeGreaterThanOrEqual(0);
      expect(elapsed).toBeLessThan(2000);
    }, 60_000);
  });

  // ── X-Potemkin-Success-Rate — probabilistic gate ────────────────────────

  describe('X-Potemkin-Success-Rate is a probabilistic gate', () => {
    it('success_rate=0 always fails through to the YAML override 503', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-success-rate': '0' },
      );
      expect(res.status).toBe(503);
      // YAML override (success-rate-failure-custom) sets a custom error body.
      expect((res.body as JsonObject)['error']).toBe('DEPENDENCY_DEGRADED');
    }, 60_000);

    it('success_rate=1 always passes through to the normal response', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-success-rate': '1' },
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    }, 60_000);

    it('success_rate=100 (percent form) always passes', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-success-rate': '100' },
      );
      expect(res.status).toBe(200);
    }, 60_000);
  });

  // ── X-Potemkin-Slow-Response — synonym for Force-Latency ────────────────

  describe('X-Potemkin-Slow-Response is a synonym for Force-Latency', () => {
    it('slow_response=300 adds delay to a normal response', async () => {
      const start = Date.now();
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-slow-response': '300' },
      );
      const elapsed = Date.now() - start;
      expect(res.status).toBe(200);
      expect(elapsed).toBeGreaterThanOrEqual(250);
    }, 60_000);
  });

  // ── X-Potemkin-Body-Truncate — network shaping ──────────────────────────

  describe('X-Potemkin-Body-Truncate slices the response body', () => {
    it('truncate=20 reduces the response body length to 20 bytes', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-body-truncate': '20' },
      );
      expect(res.status).toBe(200);
      // The truncated body comes back as a serialised string slice — its length
      // (as a string when re-encoded by the forwarding layer) must be <= 20.
      const serialised = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
      expect(serialised.length).toBeLessThanOrEqual(20);
    }, 60_000);

    it('truncate=0 returns an empty body', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-body-truncate': '0' },
      );
      expect(res.status).toBe(200);
      expect(res.body === '' || res.body === null).toBe(true);
    }, 60_000);
  });

  // ── X-Potemkin-Drop-Connection — surfaced via forwarding marker header ──

  describe('X-Potemkin-Drop-Connection surfaces a synthetic 504 via /_engine/forward', () => {
    it('drop=50 returns the forwarding-layer drop marker after the requested delay', async () => {
      const start = Date.now();
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-drop-connection': '50' },
      );
      const elapsed = Date.now() - start;
      // Forwarding layer cannot destroy the upstream socket, so it surfaces a 504
      // and an x-potemkin-dropped marker for the plugin to honour.
      expect(res.status).toBe(504);
      expect(res.headers['x-potemkin-dropped']).toBe('true');
      expect(elapsed).toBeGreaterThanOrEqual(40);
    }, 60_000);
  });
});
