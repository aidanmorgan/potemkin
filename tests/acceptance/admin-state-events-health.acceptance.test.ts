/**
 * admin-state-events-health.acceptance.test.ts
 *
 * Acceptance test: GET /_admin/state, /_admin/events, /_admin/health
 * all return reasonable JSON.
 */

import { createTestApp, type TestApp } from './_helpers/test-app.js';

// CRM baseline: 5 Leads + 2 Campaigns + 3 Agents = 10 seeded entities
const BASELINE_ENTITY_COUNT = 10;
const BASELINE_EVENT_COUNT = 10;

// Seeded entity IDs
const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';
const BLUESKY_LEAD_ID = '00000000-0000-7000-8000-000000000011';

describe('admin-state-events-health.acceptance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  // ── /_admin/state ─────────────────────────────────────────────────────────

  it('GET /_admin/state returns 200', async () => {
    await app.agent.get('/_admin/state').expect(200);
  });

  it('GET /_admin/state returns JSON with an entities field', async () => {
    const res = await app.agent.get('/_admin/state').expect(200);

    expect(res.body).toHaveProperty('entities');
    expect(typeof res.body.entities).toBe('object');
  });

  it('GET /_admin/state entities contain seeded leads and other CRM entities', async () => {
    const res = await app.agent.get('/_admin/state').expect(200);

    const keys = Object.keys(res.body.entities);
    expect(keys).toContain(APEX_LEAD_ID);
    expect(keys).toContain(BLUESKY_LEAD_ID);
  });

  it('GET /_admin/state entity count matches graph size', async () => {
    const stateRes = await app.agent.get('/_admin/state').expect(200);
    const healthRes = await app.agent.get('/_admin/health').expect(200);

    const entityCountFromState = Object.keys(stateRes.body.entities).length;
    const entityCountFromHealth = healthRes.body.entityCount;

    expect(entityCountFromState).toBe(entityCountFromHealth);
  });

  // ── /_admin/events ────────────────────────────────────────────────────────

  it('GET /_admin/events returns 200', async () => {
    await app.agent.get('/_admin/events').expect(200);
  });

  it('GET /_admin/events returns JSON with an events array', async () => {
    const res = await app.agent.get('/_admin/events').expect(200);

    expect(res.body).toHaveProperty('events');
    expect(Array.isArray(res.body.events)).toBe(true);
  });

  it('GET /_admin/events baseline has correct seeded event count', async () => {
    const res = await app.agent.get('/_admin/events').expect(200);

    expect(res.body.events.length).toBe(BASELINE_EVENT_COUNT);
  });

  it('GET /_admin/events each event has eventId, boundary, aggregateId, type, sequenceVersion', async () => {
    const res = await app.agent.get('/_admin/events').expect(200);

    for (const evt of res.body.events) {
      expect(typeof evt.eventId).toBe('string');
      expect(typeof evt.boundary).toBe('string');
      expect(typeof evt.aggregateId).toBe('string');
      expect(typeof evt.type).toBe('string');
      expect(typeof evt.sequenceVersion).toBe('number');
    }
  });

  it('GET /_admin/events?aggregateId=X filters events by aggregate', async () => {
    const res = await app.agent.get(`/_admin/events?aggregateId=${APEX_LEAD_ID}`).expect(200);

    expect(Array.isArray(res.body.events)).toBe(true);
    for (const evt of res.body.events) {
      expect(evt.aggregateId).toBe(APEX_LEAD_ID);
    }
  });

  // ── /_admin/health ────────────────────────────────────────────────────────

  it('GET /_admin/health returns 200', async () => {
    await app.agent.get('/_admin/health').expect(200);
  });

  it('GET /_admin/health returns status ok', async () => {
    const res = await app.agent.get('/_admin/health').expect(200);

    expect(res.body.status).toBe('ok');
  });

  it('GET /_admin/health returns entityCount and eventCount numbers', async () => {
    const res = await app.agent.get('/_admin/health').expect(200);

    expect(typeof res.body.entityCount).toBe('number');
    expect(typeof res.body.eventCount).toBe('number');
  });

  it('GET /_admin/health entityCount is correct at baseline', async () => {
    const res = await app.agent.get('/_admin/health').expect(200);

    expect(res.body.entityCount).toBe(BASELINE_ENTITY_COUNT);
  });

  it('GET /_admin/health eventCount is correct at baseline', async () => {
    const res = await app.agent.get('/_admin/health').expect(200);

    expect(res.body.eventCount).toBe(BASELINE_EVENT_COUNT);
  });

  it('GET /_admin/health returns an uptime field', async () => {
    const res = await app.agent.get('/_admin/health').expect(200);

    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });
});
