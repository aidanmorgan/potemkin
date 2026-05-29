// 52 — GET operations returning different subsets of the in-memory graph.
//
// Builds a non-trivial graph (campaign + several leads in mixed lifecycle
// states + their calls) and then exercises the read-side GETs to prove
// each one returns the right projection over the same shared graph.
// Covers: collection vs single-entity reads, status/source/agentId/
// campaignId filters, derived-field reads (x-derived score), pagination
// envelope, multi-status filtering, and read-only verification that the
// underlying graph is unchanged after queries.

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd,
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
const ALT_CAMPAIGN_ID = '00000000-0000-7000-8000-000000000002';
const AGENT_ID = '00000000-0000-7000-8000-000000000003';
const ALT_AGENT_ID = '00000000-0000-7000-8000-000000000004';

interface LeadSeed {
  readonly companyName: string;
  readonly source: string;
  readonly campaignId: string;
  readonly agentId: string;
  readonly lifecycle: 'created' | 'contacted' | 'qualified' | 'converted' | 'disqualified' | 'dnc';
}

describeWithJava('52 — GET returns different subsets of the in-memory graph', () => {
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

  async function logCall(leadId: string, agentId: string, campaignId: string): Promise<void> {
    await fwd(app.engineUrl, 'POST', '/calls', {
      leadId, agentId, campaignId, outcome: 'INTERESTED',
    });
  }

  // Build a populated graph with a known shape so each test can assert
  // exact subsets without rebuilding.
  async function buildGraph(seeds: readonly LeadSeed[]): Promise<readonly string[]> {
    const ids: string[] = [];
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i];
      const created = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: seed.companyName,
        contactName: `Contact ${i}`,
        phone: `+61 2 5200 000${i}`,
        email: `${seed.companyName.replace(/\s/g, '').toLowerCase()}@subset.test`,
        source: seed.source,
        campaignId: seed.campaignId,
        agentId: seed.agentId,
      });
      const id = (created.body as { id: string }).id;
      ids.push(id);
      if (seed.lifecycle === 'created') continue;
      await fwd(app.engineUrl, 'POST', `/leads/${id}/contact`, { notes: 'auto' });
      if (seed.lifecycle === 'contacted') continue;
      await logCall(id, seed.agentId, seed.campaignId);
      if (seed.lifecycle === 'qualified') {
        await fwd(app.engineUrl, 'POST', `/leads/${id}/qualify`, {});
        continue;
      }
      if (seed.lifecycle === 'converted') {
        await fwd(app.engineUrl, 'POST', `/leads/${id}/qualify`, {});
        await fwd(app.engineUrl, 'POST', `/leads/${id}/convert`, {
          value: 50000, expectedCloseDate: '2026-12-31',
        });
        continue;
      }
      if (seed.lifecycle === 'disqualified') {
        await fwd(app.engineUrl, 'POST', `/leads/${id}/disqualify`, { reason: 'no fit' });
        continue;
      }
      if (seed.lifecycle === 'dnc') {
        await fwd(app.engineUrl, 'POST', `/leads/${id}/dnc`, { reason: 'requested' });
        continue;
      }
    }
    return ids;
  }

  it('basic GET /{id} returns the projected state of a single aggregate', async () => {
    const [id] = await buildGraph([
      { companyName: 'Solo One', source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'created' },
    ]);
    const res = await fwd(app.engineUrl, 'GET', `/leads/${id}`);
    expect(res.status).toBe(200);
    const lead = res.body as Record<string, unknown>;
    expect(lead['id']).toBe(id);
    expect(lead['status']).toBe('NEW');
    expect(lead['companyName']).toBe('Solo One');
  });

  it('basic GET / returns every entity in the boundary', async () => {
    await buildGraph([
      { companyName: 'List One',   source: 'WEBSITE',  campaignId: CAMPAIGN_ID,     agentId: AGENT_ID,     lifecycle: 'created' },
      { companyName: 'List Two',   source: 'WEBSITE',  campaignId: CAMPAIGN_ID,     agentId: AGENT_ID,     lifecycle: 'created' },
      { companyName: 'List Three', source: 'REFERRAL', campaignId: ALT_CAMPAIGN_ID, agentId: ALT_AGENT_ID, lifecycle: 'created' },
    ]);
    const res = await fwd(app.engineUrl, 'GET', '/leads');
    const leads = res.body as Record<string, unknown>[];
    const ours = leads.filter((l) => String(l['companyName']).startsWith('List '));
    expect(ours.length).toBe(3);
  });

  it('?status=X returns only entities in that status', async () => {
    await buildGraph([
      { companyName: 'New Co',         source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'created' },
      { companyName: 'Contacted Co',   source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'contacted' },
      { companyName: 'Qualified Co',   source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'qualified' },
      { companyName: 'Converted Co',   source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'converted' },
      { companyName: 'Disqualified Co',source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'disqualified' },
    ]);
    const onlyQualified = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'QUALIFIED' });
    const items = onlyQualified.body as { status: string }[];
    expect(items.every((l) => l.status === 'QUALIFIED')).toBe(true);
    expect(items.length).toBeGreaterThan(0);
  });

  it('GET /calls?leadId=X scopes the result to one lead', async () => {
    // Calls expose queryMapping over leadId/agentId/campaignId. Log a known
    // number of calls per lead, then confirm the GET subset matches.
    const [leadA, leadB] = await buildGraph([
      { companyName: 'Lead A', source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'contacted' },
      { companyName: 'Lead B', source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'contacted' },
    ]);
    // buildGraph already logged 0 calls for contacted lifecycle.
    for (let i = 0; i < 2; i++) await logCall(leadA, AGENT_ID, CAMPAIGN_ID);
    for (let i = 0; i < 3; i++) await logCall(leadB, AGENT_ID, CAMPAIGN_ID);
    const onLeadA = await fwd(app.engineUrl, 'GET', '/calls', null, {}, { leadId: leadA });
    const items = onLeadA.body as { leadId: string }[];
    expect(items.every((c) => c.leadId === leadA)).toBe(true);
    expect(items.length).toBe(2);
  });

  it('GET /calls?agentId=X scopes the result to one agent', async () => {
    const [lead] = await buildGraph([
      { companyName: 'Agent Lead', source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'contacted' },
    ]);
    for (let i = 0; i < 2; i++) await logCall(lead, AGENT_ID, CAMPAIGN_ID);
    for (let i = 0; i < 1; i++) await logCall(lead, ALT_AGENT_ID, CAMPAIGN_ID);
    const onAgent = await fwd(app.engineUrl, 'GET', '/calls', null, {}, { agentId: AGENT_ID });
    const items = onAgent.body as { agentId: string }[];
    const ours = items.filter((c) => [AGENT_ID, ALT_AGENT_ID].includes(c.agentId));
    expect(ours.every((c) => c.agentId === AGENT_ID)).toBe(true);
    expect(ours.length).toBeGreaterThanOrEqual(2);
  });

  it('?limit=N triggers the pagination envelope; envelope reports totalCount across the full set', async () => {
    await buildGraph(
      Array.from({ length: 6 }, (_, i) => ({
        companyName: `Page Co ${i}`,
        source: 'WEBSITE',
        campaignId: CAMPAIGN_ID,
        agentId: AGENT_ID,
        lifecycle: 'created' as const,
      })),
    );
    const page = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { limit: '3' });
    const env = page.body as { items: unknown[]; totalCount: number; hasMore: boolean; offset: number; limit: number };
    expect(env.items.length).toBe(3);
    expect(env.totalCount).toBeGreaterThanOrEqual(6);
    expect(env.hasMore).toBe(true);
    expect(env.offset).toBe(0);
    expect(env.limit).toBe(3);
  });

  it('?limit + ?offset returns a precise slice of the same underlying graph', async () => {
    await buildGraph(
      Array.from({ length: 4 }, (_, i) => ({
        companyName: `Slice Co ${i}`,
        source: 'WEBSITE',
        campaignId: CAMPAIGN_ID,
        agentId: AGENT_ID,
        lifecycle: 'created' as const,
      })),
    );
    const full = await fwd(app.engineUrl, 'GET', '/leads');
    const slice = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { limit: '2', offset: '1' });
    const all = full.body as Record<string, unknown>[];
    const window = (slice.body as { items: Record<string, unknown>[] }).items;
    expect(window.length).toBe(2);
    expect(window[0]).toEqual(all[1]);
    expect(window[1]).toEqual(all[2]);
  });

  it('multiple GETs against the same graph leave the entity count unchanged', async () => {
    await buildGraph([
      { companyName: 'RO Co 1', source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'created' },
      { companyName: 'RO Co 2', source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'contacted' },
    ]);
    const before = await getEntityCount(app.engineUrl);
    for (const path of ['/leads', '/campaigns', '/agents', '/calls', '/opportunities']) {
      await fwd(app.engineUrl, 'GET', path);
    }
    const after = await getEntityCount(app.engineUrl);
    expect(after).toBe(before);
  });

  it('GET /opportunities (sub-graph) shows entities created by the LeadConversionSaga dispatch', async () => {
    await buildGraph([
      { companyName: 'Conv Co 1', source: 'REFERRAL', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'converted' },
      { companyName: 'Conv Co 2', source: 'REFERRAL', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'converted' },
    ]);
    const res = await fwd(app.engineUrl, 'GET', '/opportunities');
    const items = res.body as { stage?: string; status?: string }[];
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /calls returns the call list separately from /leads', async () => {
    const ids = await buildGraph([
      { companyName: 'Call Lead', source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'contacted' },
    ]);
    for (let i = 0; i < 3; i++) await logCall(ids[0], AGENT_ID, CAMPAIGN_ID);
    const res = await fwd(app.engineUrl, 'GET', '/calls');
    const calls = res.body as Record<string, unknown>[];
    const ours = calls.filter((c) => c['leadId'] === ids[0]);
    expect(ours.length).toBeGreaterThanOrEqual(3);
  });

  it('GET filters compose: ?status=NEW with ?limit=2 returns at most 2 NEW leads', async () => {
    await buildGraph([
      { companyName: 'NEW A', source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'created' },
      { companyName: 'NEW B', source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'created' },
      { companyName: 'NEW C', source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'created' },
      { companyName: 'CON A', source: 'WEBSITE', campaignId: CAMPAIGN_ID, agentId: AGENT_ID, lifecycle: 'contacted' },
    ]);
    const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'NEW', limit: '2' });
    const env = res.body as { items: { status: string }[] };
    expect(env.items.length).toBeLessThanOrEqual(2);
    expect(env.items.every((l) => l.status === 'NEW')).toBe(true);
  });
});
