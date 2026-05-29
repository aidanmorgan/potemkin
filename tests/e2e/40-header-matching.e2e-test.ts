/**
 * 40 — Header Matching in DSL via full Specmatic stack.
 *
 * Verifies the foundational header-matching capability: behaviors and fault rules
 * can match against HTTP request headers using:
 *   - Raw form:     match.headers: { "x-potemkin-scenario": "slow_db" }
 *   - Convenience:  match.potemkin: { rate_limit: "*", force_response: "maintenance" }
 *
 * Both expand to the same internal representation; the convenience form maps short
 * aliases to X-Potemkin-* header constants.
 *
 * All scenarios under test are defined in tests/fixtures/crm/dsl/global.yaml.
 * This test only sends HTTP requests with the trigger headers and asserts the
 * configured responses come back — the YAML is the system under test.
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { fwd, getEventCount, javaAvailable } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';
const AGENT_ID     = '00000000-0000-7000-8000-000000000003';
const CAMPAIGN_ID  = '00000000-0000-7000-8000-000000000001';

describeWithJava('40 — Header Matching in DSL (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ── Convenience form: `potemkin.rate_limit` (presence wildcard) ────────────

  describe('Convenience form: potemkin.rate_limit → X-Potemkin-Rate-Limit', () => {
    it('GET with X-Potemkin-Rate-Limit header returns 429 from YAML config', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-rate-limit': 'true' },
      );
      expect(res.status).toBe(429);
      expect((res.body as JsonObject)['error']).toBe('RATE_LIMITED');
      expect((res.body as JsonObject)['retryAfter']).toBe(30);
    }, 60_000);

    it('429 response includes the headers configured in YAML', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-rate-limit': 'anything' },
      );
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('30');
      expect(res.headers['x-ratelimit-limit']).toBe('100');
      expect(res.headers['x-ratelimit-remaining']).toBe('0');
    }, 60_000);

    it('any non-empty value triggers the rule (presence wildcard "*")', async () => {
      // Different header values all match because YAML uses rate_limit: "*"
      for (const val of ['true', 'simulate', '1', 'exceed']) {
        const res = await fwd(
          app.engineUrl, 'GET', '/leads', null,
          { 'x-potemkin-rate-limit': val },
        );
        expect(res.status).toBe(429);
      }
    }, 60_000);

    it('without the header, requests proceed normally to 200', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    }, 60_000);
  });

  // ── Convenience form: `potemkin.force_response` (exact value) ──────────────

  describe('Convenience form: potemkin.force_response → X-Potemkin-Force-Response (exact)', () => {
    it('exact value "maintenance" returns the configured 503', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-force-response': 'maintenance' },
      );
      expect(res.status).toBe(503);
      expect((res.body as JsonObject)['error']).toBe('SERVICE_UNAVAILABLE');
    }, 60_000);

    it('different value does NOT match the rule', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-force-response': 'something-else' },
      );
      expect(res.status).toBe(200);
    }, 60_000);

    it('header absent does NOT match', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads');
      expect(res.status).toBe(200);
    }, 60_000);
  });

  // ── Convenience form: scoped to boundary + intent ─────────────────────────

  describe('Boundary+intent scoping with potemkin.feature_flag', () => {
    it('feature flag header on Lead query returns the configured 418', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`, null,
        { 'x-potemkin-feature-flag': 'v2-experimental' },
      );
      expect(res.status).toBe(418);
      expect((res.body as JsonObject)['error']).toBe('TEAPOT');
    }, 60_000);

    it('feature flag header on Lead creation does NOT match (intent: query only)', async () => {
      const res = await fwd(
        app.engineUrl, 'POST', '/leads',
        {
          companyName: 'Feature Flag Corp', contactName: 'FF',
          phone: '+61 0', email: 'ff@t.com', source: 'WEBSITE',
        },
        { 'x-potemkin-feature-flag': 'v2-experimental' },
      );
      // Creation succeeds normally (the rule is scoped to intent: query)
      expect([200, 201]).toContain(res.status);
    }, 60_000);

    it('different feature flag value does NOT match', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`, null,
        { 'x-potemkin-feature-flag': 'v1-legacy' },
      );
      expect(res.status).toBe(200);
    }, 60_000);
  });

  // ── Raw `headers:` form (no alias) ────────────────────────────────────────

  describe('Raw headers form: arbitrary X-Potemkin-Scenario header', () => {
    it('Call creation with x-potemkin-scenario: slow_db returns 504', async () => {
      const res = await fwd(
        app.engineUrl, 'POST', '/calls',
        {
          leadId: APEX_LEAD_ID, agentId: AGENT_ID, campaignId: CAMPAIGN_ID,
          outcome: 'INTERESTED', durationSeconds: 60,
        },
        { 'x-potemkin-scenario': 'slow_db' },
      );
      expect(res.status).toBe(504);
      expect((res.body as JsonObject)['error']).toBe('GATEWAY_TIMEOUT');
      expect(res.headers['retry-after']).toBe('5');
    }, 60_000);

    it('different scenario value does NOT match', async () => {
      const res = await fwd(
        app.engineUrl, 'POST', '/calls',
        {
          leadId: APEX_LEAD_ID, agentId: AGENT_ID, campaignId: CAMPAIGN_ID,
          outcome: 'INTERESTED', durationSeconds: 60,
        },
        { 'x-potemkin-scenario': 'normal' },
      );
      expect([200, 201]).toContain(res.status);
    }, 60_000);

    it('scenario header on Lead GET does NOT match (rule scoped to Call/creation)', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        { 'x-potemkin-scenario': 'slow_db' },
      );
      expect(res.status).toBe(200);
    }, 60_000);
  });

  // ── Header matching produces zero events (responses bypass state) ─────────

  describe('Header-matched fault responses emit zero events', () => {
    it('rate-limit response does not mutate state', async () => {
      const before = await getEventCount(app.engineUrl);
      await fwd(
        app.engineUrl, 'POST', '/leads',
        {
          companyName: 'Should Not Exist Corp', contactName: 'SNE',
          phone: '+61 0', email: 'sne@t.com', source: 'WEBSITE',
        },
        { 'x-potemkin-rate-limit': 'true' },
      );
      const after = await getEventCount(app.engineUrl);
      expect(after).toBe(before);
    }, 60_000);

    it('maintenance-mode response does not mutate state', async () => {
      const before = await getEventCount(app.engineUrl);
      await fwd(
        app.engineUrl, 'POST', '/leads',
        {
          companyName: 'Maintenance Test Corp', contactName: 'MT',
          phone: '+61 0', email: 'mt@t.com', source: 'WEBSITE',
        },
        { 'x-potemkin-force-response': 'maintenance' },
      );
      const after = await getEventCount(app.engineUrl);
      expect(after).toBe(before);
    }, 60_000);
  });

  // ── Header matching is case-insensitive ────────────────────────────────────

  describe('Header matching is case-insensitive on header name', () => {
    it('X-Potemkin-Rate-Limit (mixed case) still triggers the rule', async () => {
      const res = await fwd(
        app.engineUrl, 'GET', '/leads', null,
        // Express/Node lowercases incoming header names before they reach the engine,
        // so the rule (which stores keys lowercased) will still match.
        { 'X-Potemkin-Rate-Limit': 'true' },
      );
      expect(res.status).toBe(429);
    }, 60_000);
  });
});
