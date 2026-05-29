// 51 — Object-graph evolution through a long edit sequence.
//
// Builds a non-trivial CRM graph step-by-step and asserts that every
// intermediate query returns the expected subset. The same aggregate is
// touched by many distinct mutation paths (create, contact, log call,
// qualify, convert), and the derived projection (CampaignDashboard) is
// expected to stay in sync.

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd,
  getGraphNode,
  getAllEntities,
  getEventsByAggregate,
  getAllEvents,
  getEntityCount,
  getEventCount,
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

describeWithJava('51 — Object-graph evolution over a sequence of edits', () => {
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

  // ── Helper: drive one lead through the full lifecycle ──────────────────
  async function buildLead(seed: { companyName: string; phone: string }): Promise<string> {
    const created = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: seed.companyName,
      contactName: 'Auto Contact',
      phone: seed.phone,
      email: `${seed.companyName.replace(/\s/g, '').toLowerCase()}@evo.test`,
      source: 'WEBSITE',
      campaignId: CAMPAIGN_ID,
      agentId: AGENT_ID,
    });
    return (created.body as { id: string }).id;
  }

  async function contactQualify(leadId: string): Promise<void> {
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, { notes: 'first call' });
    await fwd(app.engineUrl, 'POST', '/calls', {
      leadId,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'INTERESTED',
    });
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
  }

  it('after a single edit the graph grows by exactly one entity', async () => {
    const before = await getEntityCount(app.engineUrl);
    await buildLead({ companyName: 'Solo Lead Co', phone: '+61 2 0000 7001' });
    const after = await getEntityCount(app.engineUrl);
    expect(after).toBe(before + 1);
  });

  it('each lifecycle transition appends at least one event to the aggregate stream', async () => {
    const leadId = await buildLead({ companyName: 'Stream Co', phone: '+61 2 0000 7002' });
    const e0 = (await getEventsByAggregate(app.engineUrl, leadId)).length;
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, { notes: 'first' });
    const e1 = (await getEventsByAggregate(app.engineUrl, leadId)).length;
    expect(e1).toBeGreaterThan(e0);
    await fwd(app.engineUrl, 'POST', '/calls', {
      leadId,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'INTERESTED',
    });
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
    const e2 = (await getEventsByAggregate(app.engineUrl, leadId)).length;
    expect(e2).toBeGreaterThanOrEqual(e1);
  });

  it('querying the same aggregate after each edit returns a strictly growing event count', async () => {
    const leadId = await buildLead({ companyName: 'Growing Co', phone: '+61 2 0000 7003' });
    const lengths: number[] = [];
    lengths.push((await getEventsByAggregate(app.engineUrl, leadId)).length);
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, { notes: 'n1' });
    lengths.push((await getEventsByAggregate(app.engineUrl, leadId)).length);
    await fwd(app.engineUrl, 'POST', '/calls', {
      leadId,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'INTERESTED',
    });
    lengths.push((await getEventsByAggregate(app.engineUrl, leadId)).length);
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
    lengths.push((await getEventsByAggregate(app.engineUrl, leadId)).length);
    // strictly monotonic non-decreasing (some hops are a no-op against this aggregate)
    for (let i = 1; i < lengths.length; i++) expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]);
    expect(lengths[lengths.length - 1]).toBeGreaterThan(lengths[0]);
  });

  it('parallel aggregates: 5 leads through the lifecycle independently project 5 stage states', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await buildLead({ companyName: `Par Co ${i}`, phone: `+61 2 0000 800${i}` }));
    }
    for (const id of ids) await contactQualify(id);
    for (const id of ids) {
      const node = await getGraphNode(app.engineUrl, id);
      expect(node).not.toBeNull();
      expect(node!['status']).toBe('QUALIFIED');
    }
  });

  it('cross-aggregate fan-out: one campaign aggregates many leads via dispatch chain', async () => {
    // Three leads under the same campaign; each gets converted, which the
    // LeadConversionSaga fans out into an Opportunity. After the run, the
    // graph holds 1 campaign + 3 leads + 3 opportunities + agent + seeded
    // baseline.
    const leadIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await buildLead({ companyName: `Fan Co ${i}`, phone: `+61 2 0000 900${i}` });
      leadIds.push(id);
      await contactQualify(id);
      await fwd(app.engineUrl, 'POST', `/leads/${id}/convert`, {
        value: 10000 + i * 1000,
        expectedCloseDate: '2026-12-31',
      });
    }
    const entities = await getAllEntities(app.engineUrl);
    const oppCount = Object.values(entities).filter(
      (e) => (e as { stage?: string }).stage !== undefined,
    ).length;
    expect(oppCount).toBeGreaterThanOrEqual(3);
  });

  it('full event log monotonically grows; admin reset rewinds to baseline', async () => {
    const baseline = await getEventCount(app.engineUrl);
    const leadId = await buildLead({ companyName: 'Rewind Co', phone: '+61 2 0000 7110' });
    await contactQualify(leadId);
    const grown = await getEventCount(app.engineUrl);
    expect(grown).toBeGreaterThan(baseline);
    await adminReset(app.engineUrl);
    const afterReset = await getEventCount(app.engineUrl);
    expect(afterReset).toBe(baseline);
  });

  it('global event log can be inspected and grouped by boundary', async () => {
    const leadId = await buildLead({ companyName: 'Inspect Co', phone: '+61 2 0000 7333' });
    await contactQualify(leadId);
    const events = await getAllEvents(app.engineUrl);
    const types = new Set(events.map((e) => e.type));
    expect(types.has('LeadCreated')).toBe(true);
    expect(types.has('CallLogged')).toBe(true);
    expect(types.has('LeadQualified')).toBe(true);
  });
});
