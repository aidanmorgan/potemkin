/**
 * Harness smoke test for the CRM example, written from the CONSUMER side.
 *
 * Proves the full consumer-side stack works end to end: the test (the consumer)
 * drives the Specmatic stub URL, the plugin forwards owned paths to the engine
 * (forwarding-readiness gate), and state is forced THROUGH the stub via the
 * plugin-proxied /_admin/reset. The richer consumer scenarios live alongside
 * this file (bead potemkin-4c8z.5).
 */
import { startExampleStack, type ExampleStack } from '../../_harness/example-stack';
import { ConsumerClient } from '../../_harness/consumer-client';

const SEEDED_LEAD_ID = '00000000-0000-7000-8000-000000000010';

describe('CRM example — consumer-side harness smoke', () => {
  let stack: ExampleStack;
  let api: ConsumerClient;

  beforeAll(async () => {
    stack = await startExampleStack({ exampleName: 'crm' });
    api = new ConsumerClient(stack.stubUrl);
  }, 90_000);

  afterAll(async () => {
    if (stack) await stack.shutdown();
  });

  beforeEach(async () => {
    // Force a known baseline THROUGH the stub before each scenario.
    await stack.reset();
  });

  it('reads a seeded lead through the stub (engine state, not a Specmatic example)', async () => {
    const res = await api.get(`/leads/${SEEDED_LEAD_ID}`);
    expect(res.status).toBe(200);
    const lead = res.body as Record<string, unknown>;
    expect(lead['id']).toBe(SEEDED_LEAD_ID);
    expect(lead['companyName']).toBe('Apex Solutions Ltd');
  });

  it('creates a lead through the stub (contract-validated) and reads it back', async () => {
    const created = await api.post('/leads', {
      json: {
        companyName: 'Harness Test Co',
        contactName: 'Dana Reed',
        phone: '+61 2 9000 9999',
        email: 'dana@harness.test',
        source: 'WEBSITE',
      },
    });
    expect(created.status).toBe(201);
    const id = (created.body as Record<string, unknown>)['id'] as string;
    expect(typeof id).toBe('string');

    const fetched = await api.get(`/leads/${id}`);
    expect(fetched.status).toBe(200);
    expect((fetched.body as Record<string, unknown>)['companyName']).toBe('Harness Test Co');
  });

  it('reset-through-stub restores the baseline (created leads gone, seeds remain)', async () => {
    const created = await api.post('/leads', {
      json: {
        companyName: 'Ephemeral Inc',
        contactName: 'Pat Lee',
        phone: '+61 2 9000 0000',
        email: 'pat@ephemeral.test',
        source: 'WEBSITE',
      },
    });
    const id = (created.body as Record<string, unknown>)['id'] as string;
    expect((await api.get(`/leads/${id}`)).status).toBe(200);

    await stack.reset();

    expect((await api.get(`/leads/${id}`)).status).toBe(404);
    // The seeded baseline lead is back.
    expect((await api.get(`/leads/${SEEDED_LEAD_ID}`)).status).toBe(200);
  });
});
