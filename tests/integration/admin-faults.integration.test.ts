/**
 * admin-faults.integration.test.ts
 *
 * Integration test for the dynamic fault-injection admin API:
 *  - POST   /_admin/faults      registers a rule (201 { id, name })
 *  - GET    /_admin/faults      lists active rules ([{ id, rule }])
 *  - DELETE /_admin/faults/:id  removes a rule (204; 404 for unknown id)
 *  - POST   /_admin/reset       clears all dynamic fault rules
 *
 * Drives the gateway through a persistent server (no Specmatic / JVM).
 */

import type { BootedSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { bootCrmSystem } from './_helpers/crm-boot.js';
import {
  withPersistentServer,
  type PersistentAgent,
  type PersistentServer,
} from '../_support/persistentAgent.js';

const SAMPLE_RULE = {
  name: 'query-blocker',
  match: { condition: 'true', intent: 'query' as const },
  response: { status: 503, body: { error: 'UNAVAILABLE' } },
};

describe('admin fault-injection API — integration', () => {
  let sys: BootedSystem;
  let agent: PersistentAgent;
  let persistent: PersistentServer;

  beforeAll(async () => {
    sys = await bootCrmSystem();
    const app = createGateway(sys);
    persistent = await withPersistentServer(app);
    agent = persistent.agent;
  });

  afterAll(async () => {
    await persistent.close();
  });

  beforeEach(() => {
    sys.faultStore.clear();
  });

  it('POST /_admin/faults registers a rule and returns 201 { id, name }', async () => {
    const res = await agent.post('/_admin/faults').send(SAMPLE_RULE).expect(201);

    expect(res.body.id).toBeDefined();
    expect(typeof res.body.id).toBe('string');
    expect(res.body.name).toBe('query-blocker');
    expect(sys.faultStore.list()).toHaveLength(1);
  });

  it('POST /_admin/faults with no match/response returns 400', async () => {
    await agent.post('/_admin/faults').send({ name: 'bad' }).expect(400);
    expect(sys.faultStore.list()).toHaveLength(0);
  });

  it('GET /_admin/faults lists active rules as [{ id, rule }]', async () => {
    const addRes = await agent.post('/_admin/faults').send(SAMPLE_RULE).expect(201);

    const res = await agent.get('/_admin/faults').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(addRes.body.id);
    expect(res.body[0].rule.name).toBe('query-blocker');
    expect(res.body[0].rule.response.status).toBe(503);
  });

  it('DELETE /_admin/faults/:id removes a rule and returns 204', async () => {
    const addRes = await agent.post('/_admin/faults').send(SAMPLE_RULE).expect(201);
    const id = addRes.body.id as string;

    await agent.delete(`/_admin/faults/${id}`).expect(204);

    const listRes = await agent.get('/_admin/faults').expect(200);
    expect(listRes.body.some((f: { id: string }) => f.id === id)).toBe(false);
  });

  it('DELETE /_admin/faults/:id with an unknown id returns 404', async () => {
    await agent.delete('/_admin/faults/does-not-exist').expect(404);
  });

  it('POST /_admin/reset clears all dynamic fault rules', async () => {
    await agent.post('/_admin/faults').send(SAMPLE_RULE).expect(201);
    expect(sys.faultStore.list()).toHaveLength(1);

    await agent.post('/_admin/reset').expect(204);

    expect(sys.faultStore.list()).toHaveLength(0);
    const listRes = await agent.get('/_admin/faults').expect(200);
    expect(listRes.body).toHaveLength(0);
  });

  it('a registered dynamic fault fires on a matching gateway request', async () => {
    // Baseline: GET /leads succeeds before any dynamic fault is registered.
    await agent.get('/leads').expect(200);

    // Register a dynamic fault that blocks all query-intent requests.
    await agent.post('/_admin/faults').send(SAMPLE_RULE).expect(201);

    // The same query now returns the fault response (503 UNAVAILABLE), proving
    // the gateway passes sys.faultStore.all() as dynamicFaults to evaluateFaultRules.
    const blocked = await agent.get('/leads').expect(503);
    expect(blocked.body.error).toBe('UNAVAILABLE');
  });

  it('a removed dynamic fault no longer fires on a matching request', async () => {
    const addRes = await agent.post('/_admin/faults').send(SAMPLE_RULE).expect(201);
    await agent.get('/leads').expect(503);

    await agent.delete(`/_admin/faults/${addRes.body.id as string}`).expect(204);
    await agent.get('/leads').expect(200);
  });
});
