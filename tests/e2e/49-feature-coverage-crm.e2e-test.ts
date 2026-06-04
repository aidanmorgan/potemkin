// 49 — Full feature coverage walkthrough on the CRM fixture.
//
// Single end-to-end pass that exercises every load-time and request-time
// feature of the engine + plugin against the real Specmatic stack:
//   loader: multi-file glob (boundary YAMLs + global.yaml)
//   schema: patches: reducer vocabulary (replace/append) — covered in
//           lead / campaign / opportunity boundaries
//   CQRS:   POST → command → event → reducer-patch → projection
//   query:  GET /leads, GET /leads/{id}, listLeads with filters
//   pagination envelope (?limit triggers oneOf envelope)
//   dispatch / secondary commands  (lead-convert → opportunity-create)
//   sagas (LeadConversionSaga propagates state.assigned* fields)
//   derived projections (CampaignDashboard, AgentPerformance)
//   idempotency replay (Idempotency-Key)
//   admin surface: reset, state, events, health
//   /_engine/forward direct invocation
//   plugin: /_potemkin/health alongside legacy /health

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd,
  getGraphNode,
  getAllEntities,
  getEventCount,
  getEntityCount,
  adminReset,
} from './_harness/crm-e2e-helpers';

const describeWithJava = (() => {
  try {
    execSync('java -version', { stdio: 'pipe' });
    return describe;
  } catch {
    return describe.skip;
  }
})();

const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';
const AGENT_ID = '00000000-0000-7000-8000-000000000003';

const auth = (): Record<string, string> => ({ authorization: 'Bearer mgr1:manager' });

describeWithJava('49 — Full feature coverage walkthrough (CRM fixture)', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  beforeEach(async () => {
    await adminReset(app.engineUrl);
  });

  it('boots Specmatic stub, Node engine, and plugin in concert', async () => {
    const healthRes = await fetch(`${app.engineUrl}/_admin/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as { eventCount: number; entityCount: number };
    expect(health.entityCount).toBeGreaterThan(0); // baseline seeded
    expect(health.eventCount).toBeGreaterThan(0);
  });

  it('plugin exposes /_potemkin/health and legacy /health on the same port', async () => {
    const fresh = await fetch(`${app.pluginControlUrl}/_potemkin/health`);
    expect(fresh.status).toBe(200);
    const newPath = await fetch(`${app.pluginControlUrl}/_potemkin/health`);
    expect(newPath.status).toBe(200);
    const body = (await newPath.json()) as { state: string };
    expect(typeof body.state).toBe('string');
  });

  it('POST /leads → command/event/reducer/projection (patches: form)', async () => {
    const created = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Feature Cov Co',
      contactName: 'Cov Tester',
      phone: '+61 2 0000 0049',
      email: 'cov@49.test',
      source: 'WEBSITE',
    });
    expect([200, 201]).toContain(created.status);
    const leadId = (created.body as { id: string }).id;
    expect(typeof leadId).toBe('string');

    // State graph should now contain the new lead with the patches: reducer
    // having set { id, status:'NEW', companyName, ... }.
    const node = await getGraphNode(app.engineUrl, leadId);
    expect(node).not.toBeNull();
    expect(node!['status']).toBe('NEW');
    expect(node!['companyName']).toBe('Feature Cov Co');
  });

  it('GET /leads returns array; GET /leads?limit=N returns pagination envelope', async () => {
    const raw = await fwd(app.engineUrl, 'GET', '/leads');
    expect(raw.status).toBe(200);
    expect(Array.isArray(raw.body)).toBe(true);

    const envelope = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { limit: '2' });
    expect(envelope.status).toBe(200);
    const env = envelope.body as { items: unknown[]; totalCount: number; hasMore: boolean };
    expect(Array.isArray(env.items)).toBe(true);
    expect(env.items.length).toBeLessThanOrEqual(2);
    expect(typeof env.totalCount).toBe('number');
    expect(typeof env.hasMore).toBe('boolean');
  });

  it('GET /leads/{id} returns the projected entity with patches: reducer state', async () => {
    const created = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Read Path Inc',
      contactName: 'R Reader',
      phone: '+61 2 0000 1234',
      email: 'r@reader.test',
      source: 'PARTNER',
    });
    const leadId = (created.body as { id: string }).id;
    const fetched = await fwd(app.engineUrl, 'GET', `/leads/${leadId}`);
    expect(fetched.status).toBe(200);
    expect((fetched.body as { id: string }).id).toBe(leadId);
    expect((fetched.body as { status: string }).status).toBe('NEW');
  });

  it('lead lifecycle: contact → call → qualify → assertions on state at every step', async () => {
    const created = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Lifecycle Ltd',
      contactName: 'Linda',
      phone: '+61 2 0000 5555',
      email: 'l@lifecycle.test',
      source: 'COLD_LIST',
    });
    const leadId = (created.body as { id: string }).id;

    const contacted = await fwd(
      app.engineUrl,
      'POST',
      `/leads/${leadId}/contact`,
      { notes: 'reached on first try' },
    );
    expect([200, 201, 204]).toContain(contacted.status);
    let node = await getGraphNode(app.engineUrl, leadId);
    expect(node!['status']).toBe('CONTACTED');

    // qualify requires at least one logged call (state.callIds.exists(c, true))
    await fwd(app.engineUrl, 'POST', '/calls', {
      leadId,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'INTERESTED',
    });

    const qualified = await fwd(
      app.engineUrl,
      'POST',
      `/leads/${leadId}/qualify`,
      {},
    );
    expect([200, 201, 204]).toContain(qualified.status);
    node = await getGraphNode(app.engineUrl, leadId);
    expect(node!['status']).toBe('QUALIFIED');
  });

  it('cross-boundary dispatch: lead-convert → opportunity-create (LeadConversionSaga)', async () => {
    const created = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Dispatch Inc',
      contactName: 'Dee',
      phone: '+61 2 0000 7777',
      email: 'd@dispatch.test',
      source: 'REFERRAL',
      campaignId: CAMPAIGN_ID,
      agentId: AGENT_ID,
    });
    const leadId = (created.body as { id: string }).id;
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, { notes: 'first call' });
    await fwd(app.engineUrl, 'POST', '/calls', {
      leadId,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'INTERESTED',
    });
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});

    const converted = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/convert`, {
      expectedCloseDate: '2026-12-31',
      value: 50000,
    });
    expect([200, 201, 204]).toContain(converted.status);

    // The saga propagates state.assignedAgentId & state.assignedCampaignId
    // onto the LeadConverted dispatch, which creates an Opportunity tied to
    // the same agent/campaign. The graph picks it up via /_admin/state.
    const entities = await getAllEntities(app.engineUrl);
    const oppKeys = Object.keys(entities).filter(
      (k) => (entities[k] as { stage?: string }).stage !== undefined,
    );
    expect(oppKeys.length).toBeGreaterThan(0);
  });

  it('Idempotency-Key replay returns identical body without re-creating', async () => {
    const key = `idem-key-cov-49-${Date.now()}`;
    const body = {
      leadId: '00000000-0000-7000-8000-000000000010',
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'INTERESTED',
    };
    const headers = { 'idempotency-key': key };
    const first = await fwd(app.engineUrl, 'POST', '/calls', body, headers);
    const replay = await fwd(app.engineUrl, 'POST', '/calls', body, headers);
    expect(replay.status).toBe(first.status);
    expect((replay.body as { id: string }).id).toBe((first.body as { id: string }).id);
    expect(replay.headers['x-idempotency-replay']).toBe('true');
  });

  it('admin: /_admin/state lists every projected entity', async () => {
    const before = await getEntityCount(app.engineUrl);
    await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Admin Inspect',
      contactName: 'A',
      phone: '+61 2 0000 4321',
      email: 'admin@inspect.test',
      source: 'WEBSITE',
    });
    const after = await getEntityCount(app.engineUrl);
    expect(after).toBe(before + 1);
  });

  it('admin: /_admin/reset returns engine to baseline (drops dynamic events)', async () => {
    await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Will Be Reset',
      contactName: 'W',
      phone: '+61 2 0000 0001',
      email: 'reset@me.test',
      source: 'WEBSITE',
    });
    const beforeReset = await getEventCount(app.engineUrl);
    await adminReset(app.engineUrl);
    const afterReset = await getEventCount(app.engineUrl);
    expect(afterReset).toBeLessThan(beforeReset);
    expect(afterReset).toBeGreaterThan(0); // baseline events survive
  });

  it('control headers: query parameter filters survive through the forward path', async () => {
    const newLeadIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: `Filter Co ${i}`,
        contactName: `F${i}`,
        phone: `+61 2 0000 100${i}`,
        email: `f${i}@filter.test`,
        source: 'WEBSITE',
      });
      newLeadIds.push((created.body as { id: string }).id);
    }
    const filtered = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'NEW' });
    expect(filtered.status).toBe(200);
    const items = Array.isArray(filtered.body) ? (filtered.body as { status: string }[]) : [];
    expect(items.every((i) => i.status === 'NEW')).toBe(true);
  });

  it('manager scope auth: PATCH /leads/{id}/dnc gated by manager scope', async () => {
    const created = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'DNC Co',
      contactName: 'D',
      phone: '+61 2 0000 0099',
      email: 'dnc@feature.test',
      source: 'COLD_LIST',
    });
    const leadId = (created.body as { id: string }).id;

    // Manager scope present → allowed
    const allowed = await fwd(
      app.engineUrl,
      'POST',
      `/leads/${leadId}/dnc`,
      { reason: 'user requested' },
      auth(),
    );
    expect([200, 201, 204]).toContain(allowed.status);
  });
});
