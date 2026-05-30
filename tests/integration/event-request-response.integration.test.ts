/**
 * Integration tests for event request/response capture and reducer history
 * access (the recently-added event-sourcing extensions).
 */

import request from 'supertest';
import type { BootedSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { resetSystem } from '../../src/engine/reset.js';
import { bootCrmSystem } from './_helpers/crm-boot.js';

const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';

describe('Event request/response capture', () => {
  let sys: BootedSystem;
  let agent: ReturnType<typeof request>;

  beforeAll(async () => {
    sys = await bootCrmSystem();
    const app = createGateway(sys);
    agent = request(app);
  });

  beforeEach(() => {
    resetSystem(sys);
  });

  it('records the originating request snapshot on every emitted event', async () => {
    const beforeCount = sys.events.size();
    const res = await agent.post('/leads').send({
      companyName: 'ReqCap Corp', contactName: 'RC',
      phone: '+61 2 9111 0001', email: 'reqcap@test.com', source: 'WEBSITE',
    });
    expect([200, 201]).toContain(res.status);
    const leadId = res.body.id as string;

    const newEvents = sys.events.all().slice(beforeCount);
    expect(newEvents.length).toBeGreaterThan(0);
    const created = newEvents.find(e => e.aggregateId === leadId && e.type === 'LeadCreated');
    expect(created).toBeDefined();

    expect(created!.request).toBeDefined();
    expect(created!.request!.method).toBe('POST');
    expect(created!.request!.path).toBe('/leads');
    expect(created!.request!.payload.companyName).toBe('ReqCap Corp');
    expect(created!.request!.payload.source).toBe('WEBSITE');
  });

  it('records the response snapshot on the committed events after the UoW returns', async () => {
    const beforeCount = sys.events.size();
    const res = await agent.post('/leads').send({
      companyName: 'RespCap Corp', contactName: 'RC',
      phone: '+61 2 9111 0002', email: 'respcap@test.com', source: 'REFERRAL',
    });
    expect([200, 201]).toContain(res.status);
    const leadId = res.body.id as string;

    const newEvents = sys.events.all().slice(beforeCount);
    const created = newEvents.find(e => e.aggregateId === leadId && e.type === 'LeadCreated');
    expect(created).toBeDefined();
    expect(created!.response).toBeDefined();
    expect(created!.response!.status).toBe(201);
    expect((created!.response!.body as Record<string, unknown>)['companyName']).toBe('RespCap Corp');
  });

  it('captures headers (lowercased) and actor identity on the event request', async () => {
    const beforeCount = sys.events.size();
    await agent.post('/leads')
      .set('Authorization', 'Bearer admin-1:admin')
      .set('X-Custom-Header', 'tenant-acme')
      .send({
        companyName: 'HeaderCap', contactName: 'H',
        phone: '+61 2 9111 0003', email: 'hc@test.com', source: 'WEBSITE',
      });

    const newEvents = sys.events.all().slice(beforeCount);
    const created = newEvents.find(e => e.type === 'LeadCreated');
    expect(created).toBeDefined();
    expect(created!.request!.headers['x-custom-header']).toBe('tenant-acme');
    expect(created!.request!.actorId).toBe('admin-1');
    expect(created!.request!.actorScopes).toContain('admin');
  });

  it('records request snapshot for sub-path mutations (e.g. lead contact)', async () => {
    const beforeCount = sys.events.size();
    await agent.post(`/leads/${APEX_LEAD_ID}/contact`).send({});

    const newEvents = sys.events.all().slice(beforeCount);
    const contacted = newEvents.find(e => e.type === 'LeadContacted');
    expect(contacted).toBeDefined();
    expect(contacted!.request!.path).toBe(`/leads/${APEX_LEAD_ID}/contact`);
    expect(contacted!.request!.method).toBe('POST');
  });
});

describe('Reducer history access', () => {
  let sys: BootedSystem;

  beforeAll(async () => {
    sys = await bootCrmSystem();
  });

  beforeEach(() => {
    resetSystem(sys);
  });

  it('history list is populated with prior events of the same aggregate', async () => {
    // We can't easily assert from a reducer; instead verify the store has
    // multiple events for the same aggregate after a multi-step lifecycle,
    // which the projection's history feature can iterate over.
    const app = createGateway(sys);
    const a = request(app);

    const create = await a.post('/leads').send({
      companyName: 'History Corp', contactName: 'H',
      phone: '+61 0', email: 'h@t.com', source: 'WEBSITE',
    });
    const leadId = create.body.id as string;

    await a.post(`/leads/${leadId}/contact`).send({});
    await a.post('/calls').send({
      leadId,
      agentId: '00000000-0000-7000-8000-000000000003',
      campaignId: '00000000-0000-7000-8000-000000000001',
      outcome: 'INTERESTED', durationSeconds: 60,
    });
    await a.post(`/leads/${leadId}/qualify`).send({});

    const events = sys.events.byAggregate(leadId);
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.map(e => e.type)).toEqual(
      expect.arrayContaining(['LeadCreated', 'LeadContacted', 'LeadQualified']),
    );
    for (let i = 1; i < events.length; i++) {
      // Monotonic sequence versions allow history.filter(e, e.sequenceVersion < N) usage in reducers.
      expect(events[i].sequenceVersion).toBeGreaterThan(events[i - 1].sequenceVersion);
    }
  });
});
