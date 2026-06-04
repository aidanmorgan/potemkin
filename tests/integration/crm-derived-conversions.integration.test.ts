/**
 * Regression: the CampaignDashboard derived projection must count REAL
 * conversions. LeadConverted is emitted by the LeadConvert sub-action boundary
 * (/leads/{id}/convert), so the projection subscription must name that boundary
 * — a `Lead:LeadConverted` subscription silently never fires and leaves
 * totalConversions stuck at 0. This drives a full lead→conversion through the
 * gateway (with global.yaml, so derived projections are live) and asserts the
 * counter actually increments.
 *
 * Boots via loadFixtureWithGlobal — loadFixture() omits global.yaml, so derived
 * projections are inert under the plain CRM boot; that omission is exactly why
 * the bug hid from the integration tier.
 */
import { bootSystem } from '../../src/engine/boot';
import { createGateway } from '../../src/http/gateway';
import { loadFixtureWithGlobal } from '../fixtures/index';
import { expandByContractPath } from './_helpers/crm-boot';
import { withPersistentServer, type PersistentServer, type PersistentAgent } from '../_support/persistentAgent';

const SEEDED_CAMPAIGN = '00000000-0000-7000-8000-000000000001';
const SEEDED_AGENT = '00000000-0000-7000-8000-000000000003';

type Obj = Record<string, unknown>;

describe('CRM derived projection — conversion counters (regression)', () => {
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const fixture = await loadFixtureWithGlobal('crm');
    const sys = await bootSystem(fixture);
    expandByContractPath(sys);
    server = await withPersistentServer(createGateway(sys));
    agent = server.agent;
  });
  afterAll(async () => { await server.close(); });

  it('CampaignDashboard.totalConversions increments when a lead is converted', async () => {
    // Create a lead attached to the seeded campaign so the dashboard keys on it.
    const lead = (await agent.post('/leads').send({
      companyName: 'Conv Co', contactName: 'Dana', phone: '+61 2 9000 0000',
      email: 'conv@acme.test', source: 'WEBSITE', assignedCampaignId: SEEDED_CAMPAIGN,
    }).expect(201)).body as Obj;
    const id = lead['id'] as string;

    // Drive the guarded state machine: contact -> record a call -> qualify -> convert.
    await agent.post(`/leads/${id}/contact`).send({}).expect(200);
    await agent.post('/calls').send({
      leadId: id, agentId: SEEDED_AGENT, campaignId: SEEDED_CAMPAIGN, outcome: 'INTERESTED',
    }).expect(201);
    await agent.post(`/leads/${id}/qualify`).send({}).expect(200);
    await agent.post(`/leads/${id}/convert`).send({ value: 5000 }).expect(200);

    const dashboard = (await agent.get('/_admin/derived/CampaignDashboard').expect(200)).body as Record<string, Obj>;
    const entry = dashboard[SEEDED_CAMPAIGN];
    expect(entry).toBeDefined();
    // The working counter (LeadCreated → Lead boundary) — baseline sanity.
    expect(entry!['totalLeads']).toBe(1);
    // The previously-dead counter: LeadConverted is emitted by LeadConvert, and
    // the subscription now names it, so a real conversion is counted.
    expect(entry!['totalConversions']).toBe(1);
  });
});
