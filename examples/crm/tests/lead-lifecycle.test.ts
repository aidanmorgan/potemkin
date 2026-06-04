/**
 * CRM example — the Lead lifecycle, driven from the consumer side through the
 * Specmatic stub. Exercises the guarded state machine (new -> contacted ->
 * qualified), the call -> lead.callIds cascade, idempotent create, and reading
 * seeded state — all through the full Specmatic + plugin stack.
 */
import { startExampleStack, type ExampleStack } from '../../_harness/example-stack';
import { ConsumerClient } from '../../_harness/consumer-client';

type Obj = Record<string, unknown>;

const SEEDED_LEAD_NEW = '00000000-0000-7000-8000-000000000010';
const SEEDED_CAMPAIGN_ACTIVE = '00000000-0000-7000-8000-000000000001';
const SEEDED_AGENT = '00000000-0000-7000-8000-000000000003';

describe('CRM example — lead lifecycle (consumer integration)', () => {
  let stack: ExampleStack;
  let crm: ConsumerClient;

  beforeAll(async () => {
    stack = await startExampleStack({ exampleName: 'crm' });
    crm = new ConsumerClient(stack.stubUrl);
  }, 90_000);
  afterAll(async () => { if (stack) await stack.shutdown(); });
  beforeEach(async () => { await stack.reset(); });

  async function createLead(over: Obj = {}): Promise<Obj> {
    return (await crm.post('/leads', {
      json: { companyName: 'Acme', contactName: 'Dana', phone: '+61 2 9000 0000', email: 'dana@acme.test', source: 'WEBSITE', ...over },
    })).body as Obj;
  }

  it('a new lead must be contacted, then needs a recorded call, before it can be qualified', async () => {
    const lead = await createLead();
    const id = lead['id'] as string;
    expect(lead['status']).toBe('NEW');

    // Qualifying a NEW lead is rejected by the must-be-contacted guard.
    expect((await crm.post(`/leads/${id}/qualify`, { json: {} })).status).toBeGreaterThanOrEqual(400);

    // Contact it -> CONTACTED.
    await crm.post(`/leads/${id}/contact`, { json: {} });
    expect(((await crm.get(`/leads/${id}`)).body as Obj)['status']).toBe('CONTACTED');

    // Still cannot qualify — the has-calls guard requires a recorded call.
    expect((await crm.post(`/leads/${id}/qualify`, { json: {} })).status).toBeGreaterThanOrEqual(400);

    // Record a call: it cascades onto the lead's callIds.
    const call = (await crm.post('/calls', {
      json: { leadId: id, agentId: SEEDED_AGENT, campaignId: SEEDED_CAMPAIGN_ACTIVE, outcome: 'INTERESTED' },
    })).body as Obj;
    const afterCall = (await crm.get(`/leads/${id}`)).body as Obj;
    expect(afterCall['callIds']).toContain(call['id']);

    // Now qualification succeeds -> QUALIFIED.
    await crm.post(`/leads/${id}/qualify`, { json: {} });
    expect(((await crm.get(`/leads/${id}`)).body as Obj)['status']).toBe('QUALIFIED');
  });

  it('reads seeded leads from declarative initialization', async () => {
    const seeded = (await crm.get(`/leads/${SEEDED_LEAD_NEW}`)).body as Obj;
    expect(seeded['id']).toBe(SEEDED_LEAD_NEW);
    expect(seeded['companyName']).toBe('Apex Solutions Ltd');
    expect(seeded['status']).toBe('NEW');
  });

  it('retrying a create with the same Idempotency-Key does not duplicate the lead', async () => {
    const headers = { 'Idempotency-Key': 'crm-lead-001' };
    const first = (await crm.post('/leads', { json: { companyName: 'Idem Co', contactName: 'A', phone: '+61 2 9000 0001', email: 'a@idem.test', source: 'WEBSITE' }, headers })).body as Obj;
    const retry = await crm.post('/leads', { json: { companyName: 'Idem Co', contactName: 'A', phone: '+61 2 9000 0001', email: 'a@idem.test', source: 'WEBSITE' }, headers });
    expect((retry.body as Obj)['id']).toBe(first['id']);
    expect(retry.headers.get('x-idempotency-replay')).toBe('true');
  });

  it('reset-through-stub restores the baseline between scenarios', async () => {
    const lead = await createLead({ email: 'ephemeral@acme.test' });
    const id = lead['id'] as string;
    expect((await crm.get(`/leads/${id}`)).status).toBe(200);
    await stack.reset();
    expect((await crm.get(`/leads/${id}`)).status).toBe(404);
    expect((await crm.get(`/leads/${SEEDED_LEAD_NEW}`)).status).toBe(200);
  });
});
