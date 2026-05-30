/**
 * crm-boots.test.ts
 *
 * Unit smoke test: boots the CRM fixture and asserts:
 *  - loadFixture() resolves without throwing.
 *  - All 5 boundaries compiled: Lead, Campaign, Agent, Call, Opportunity.
 *  - Schema registry contains entries for all 5 entity schemas.
 *  - Seeded entity counts: 5 Leads, 2 Campaigns, 3 Agents, 0 Calls, 0 Opportunities.
 */

import { loadFixture, loadFixtureWithGlobal } from '../../fixtures/index.js';
import { bootSystem } from '../../../src/engine/boot.js';
import { compileDsl } from '../../../src/dsl/parser.js';

describe('CRM Fixture Boot', () => {
  it('loadFixture() resolves without throwing', async () => {
    await expect(loadFixture()).resolves.not.toThrow();
  });

  it('boots system with all 5 boundaries compiled', async () => {
    const fixture = await loadFixture();
    const sys = await bootSystem(fixture);

    const boundaryNames = sys.dsl.boundaries.map(b => b.boundary);
    expect(boundaryNames).toContain('Lead');
    expect(boundaryNames).toContain('Campaign');
    expect(boundaryNames).toContain('Agent');
    expect(boundaryNames).toContain('Call');
    expect(boundaryNames).toContain('Opportunity');
    expect(boundaryNames).toContain('OpportunityAddLineItem');
    // 5 primary + 5 by-id + 5 lead-action + 3 campaign-action + 1 agent-action + 3 opportunity-action
    expect(sys.dsl.boundaries).toHaveLength(22);
  });

  it('byBoundaryName index contains all 5 boundaries', async () => {
    const fixture = await loadFixture();
    const sys = await bootSystem(fixture);

    expect(sys.dsl.byBoundaryName).toHaveProperty('Lead');
    expect(sys.dsl.byBoundaryName).toHaveProperty('Campaign');
    expect(sys.dsl.byBoundaryName).toHaveProperty('Agent');
    expect(sys.dsl.byBoundaryName).toHaveProperty('Call');
    expect(sys.dsl.byBoundaryName).toHaveProperty('Opportunity');
  });

  it('schema registry contains all 5 entity schemas', async () => {
    const fixture = await loadFixture();
    const sys = await bootSystem(fixture);

    // schemaRegistry is keyed by boundary name under byBoundary
    expect(sys.schemaRegistry.byBoundary).toHaveProperty('Lead');
    expect(sys.schemaRegistry.byBoundary).toHaveProperty('Campaign');
    expect(sys.schemaRegistry.byBoundary).toHaveProperty('Agent');
    expect(sys.schemaRegistry.byBoundary).toHaveProperty('Call');
    expect(sys.schemaRegistry.byBoundary).toHaveProperty('Opportunity');
  });

  it('state graph has 10 seeded entities (5 leads + 2 campaigns + 3 agents)', async () => {
    const fixture = await loadFixture();
    const sys = await bootSystem(fixture);

    expect(sys.graph.size()).toBe(10);
  });

  it('seeded Lead 10 has correct fields', async () => {
    const fixture = await loadFixture();
    const sys = await bootSystem(fixture);

    const lead = sys.graph.get('00000000-0000-7000-8000-000000000010');
    expect(lead).not.toBeNull();
    expect(lead!['companyName']).toBe('Apex Solutions Ltd');
    expect(lead!['status']).toBe('NEW');
    expect(lead!['source']).toBe('WEBSITE');
  });

  it('seeded Campaign 1 has ACTIVE status', async () => {
    const fixture = await loadFixture();
    const sys = await bootSystem(fixture);

    const campaign = sys.graph.get('00000000-0000-7000-8000-000000000001');
    expect(campaign).not.toBeNull();
    expect(campaign!['name']).toBe('Q1 Website Leads');
    expect(campaign!['status']).toBe('ACTIVE');
  });

  it('seeded Agent 3 is Alice Thompson and AVAILABLE', async () => {
    const fixture = await loadFixture();
    const sys = await bootSystem(fixture);

    const agent = sys.graph.get('00000000-0000-7000-8000-000000000003');
    expect(agent).not.toBeNull();
    expect(agent!['name']).toBe('Alice Thompson');
    expect(agent!['currentStatus']).toBe('AVAILABLE');
  });

  it('loads global config with sagas, idempotency, and derived projections', async () => {
    const { dslModules, globalYaml } = await loadFixtureWithGlobal();
    const dsl = await compileDsl(dslModules, globalYaml);

    expect(dsl.sagas).toBeDefined();
    expect(dsl.sagas!.length).toBeGreaterThanOrEqual(1);
    expect(dsl.sagas![0]!.name).toBe('LeadConversionSaga');

    expect(dsl.idempotency).toBeDefined();
    expect(dsl.idempotency!.enabled).toBe(true);

    expect(dsl.derivedProjections).toBeDefined();
    expect(dsl.derivedProjections!.length).toBeGreaterThanOrEqual(1);
    const projNames = dsl.derivedProjections!.map(p => p.name);
    expect(projNames).toContain('CampaignDashboard');
    expect(projNames).toContain('AgentPerformance');
  });
});
