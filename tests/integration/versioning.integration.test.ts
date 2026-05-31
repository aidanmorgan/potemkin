/**
 * Integration tests for API versioning (global `versioning:` block).
 *
 * Boots the crm-versioned fixture (which declares /v1 and /v2 with v2 default)
 * and drives the gateway end-to-end to verify:
 *   - a versioned prefix is stripped before contract routing (/v1/leads → /leads),
 *   - a prefix-less path routes to the default version,
 *   - responses are tagged with X-Potemkin-Version,
 *   - both prefixes reach the same underlying resource.
 */

import type { BootedSystem } from '../../src/engine/boot.js';
import { bootSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { loadFixtureWithGlobal } from '../fixtures/index.js';
import { expandByContractPath } from './_helpers/crm-boot.js';
import {
  withPersistentServer,
  type PersistentAgent,
} from '../_support/persistentAgent.js';
import { registerFileTeardown } from '../_support/testTeardown.js';

const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';

describe('API versioning — full integration', () => {
  let sys: BootedSystem;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const { openapi, compiledDsl } = await loadFixtureWithGlobal('crm-versioned');
    sys = await bootSystem({ openapi, compiledDsl: compiledDsl! });
    expandByContractPath(sys);
    const app = createGateway(sys);
    const persistent = await withPersistentServer(app);
    agent = persistent.agent;
    registerFileTeardown(persistent.close);
  });

  it('strips the /v1 version prefix before contract routing', async () => {
    const res = await agent.get(`/v1/leads/${APEX_LEAD_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(APEX_LEAD_ID);
  });

  it('tags a /v1 response with X-Potemkin-Version: v1', async () => {
    const res = await agent.get(`/v1/leads/${APEX_LEAD_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-potemkin-version']).toBe('v1');
  });

  it('routes a prefix-less path to the default version (v2)', async () => {
    const res = await agent.get(`/leads/${APEX_LEAD_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(APEX_LEAD_ID);
    // v2 is declared default in the fixture.
    expect(res.headers['x-potemkin-version']).toBe('v2');
  });

  it('reaches the same resource via the /v2 explicit prefix', async () => {
    const res = await agent.get(`/v2/leads/${APEX_LEAD_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(APEX_LEAD_ID);
    expect(res.headers['x-potemkin-version']).toBe('v2');
  });

  it('strips the prefix on a versioned collection route', async () => {
    const res = await agent.get('/v1/leads');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('injects the configured security headers on every response', async () => {
    const res = await agent.get(`/v1/leads/${APEX_LEAD_ID}`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['x-custom-sim-header']).toBe('potemkin-sim');
  });

  it('fires a header-matched global fault rule (rate-limit) with the configured 429', async () => {
    // The fixture declares a fault rule that matches X-Potemkin-Rate-Limit and
    // returns 429 with Retry-After. The rule short-circuits before any mutation.
    const res = await agent
      .get(`/v1/leads/${APEX_LEAD_ID}`)
      .set('X-Potemkin-Rate-Limit', '1');
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBe('30');
  });

  it('does not fire the fault rule when the trigger header is absent', async () => {
    const res = await agent.get(`/v1/leads/${APEX_LEAD_ID}`);
    expect(res.status).toBe(200);
  });
});
