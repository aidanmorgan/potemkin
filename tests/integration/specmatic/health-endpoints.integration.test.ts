/**
 * health-endpoints.integration.test.ts
 *
 * Tests that /_specmatic/health and /actuator/health return the exact Specmatic-expected
 * shape, and that the engine's own /_admin/health is unchanged.
 */

import request from 'supertest';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';

describe('health-endpoints.integration', () => {
  let agent: ReturnType<typeof request>;

  beforeAll(async () => {
    const fixture = await loadBankingFixture();
    const sys = await bootSystem(fixture);
    const app = createGateway(sys);
    agent = request(app);
  });

  // ── /_specmatic/health ────────────────────────────────────────────────────

  it('GET /_specmatic/health → 200', async () => {
    await agent.get('/_specmatic/health').expect(200);
  });

  it('GET /_specmatic/health → body is exactly { "status": "UP" }', async () => {
    const res = await agent.get('/_specmatic/health').expect(200);
    expect(res.body).toEqual({ status: 'UP' });
  });

  it('GET /_specmatic/health → X-Specmatic-Result: success', async () => {
    const res = await agent.get('/_specmatic/health').expect(200);
    expect(res.headers['x-specmatic-result']).toBe('success');
  });

  it('GET /_specmatic/health body has ONLY the status field (exact shape)', async () => {
    const res = await agent.get('/_specmatic/health').expect(200);
    expect(Object.keys(res.body)).toEqual(['status']);
  });

  // ── /actuator/health ──────────────────────────────────────────────────────

  it('GET /actuator/health → 200', async () => {
    await agent.get('/actuator/health').expect(200);
  });

  it('GET /actuator/health → body is exactly { "status": "UP" }', async () => {
    const res = await agent.get('/actuator/health').expect(200);
    expect(res.body).toEqual({ status: 'UP' });
  });

  it('GET /actuator/health → X-Specmatic-Result: success', async () => {
    const res = await agent.get('/actuator/health').expect(200);
    expect(res.headers['x-specmatic-result']).toBe('success');
  });

  it('GET /actuator/health body has ONLY the status field (exact shape)', async () => {
    const res = await agent.get('/actuator/health').expect(200);
    expect(Object.keys(res.body)).toEqual(['status']);
  });

  // ── /_admin/health (engine's own health — unchanged shape) ────────────────

  it('GET /_admin/health → 200', async () => {
    await agent.get('/_admin/health').expect(200);
  });

  it('GET /_admin/health → status is "ok" (engine shape unchanged)', async () => {
    const res = await agent.get('/_admin/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /_admin/health → has entityCount and eventCount (engine shape unchanged)', async () => {
    const res = await agent.get('/_admin/health').expect(200);
    expect(typeof res.body.entityCount).toBe('number');
    expect(typeof res.body.eventCount).toBe('number');
  });

  it('GET /_admin/health does NOT carry X-Specmatic-Result header', async () => {
    const res = await agent.get('/_admin/health').expect(200);
    // The admin health endpoint is NOT a Specmatic endpoint
    expect(res.headers['x-specmatic-result']).toBeUndefined();
  });
});
