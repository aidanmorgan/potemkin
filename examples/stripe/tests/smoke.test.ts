/**
 * Stripe example — consumer-side harness smoke. Validates that form-encoded
 * Stripe requests and the Stripe response shapes forward through the Specmatic
 * stub (contract-enforced) before the richer scenarios (bead potemkin-4c8z.3).
 */
import { startExampleStack, type ExampleStack } from '../../_harness/example-stack';
import { ConsumerClient } from '../../_harness/consumer-client';

describe('Stripe example — consumer-side harness smoke', () => {
  let stack: ExampleStack;
  let api: ConsumerClient;

  beforeAll(async () => {
    stack = await startExampleStack({ exampleName: 'stripe' });
    api = new ConsumerClient(stack.stubUrl);
  }, 90_000);

  afterAll(async () => {
    if (stack) await stack.shutdown();
  });

  beforeEach(async () => {
    await stack.reset();
  });

  it('creates a customer through the stub (form-encoded, HTTP 200) and reads it back', async () => {
    const created = await api.post('/v1/customers', { form: { email: 'acme@example.com', name: 'Acme Inc' } });
    expect(created.status).toBe(200);
    const customer = created.body as Record<string, unknown>;
    expect(customer['object']).toBe('customer');
    expect((customer['id'] as string).startsWith('cus_')).toBe(true);

    const fetched = await api.get(`/v1/customers/${customer['id'] as string}`);
    expect(fetched.status).toBe(200);
    expect((fetched.body as Record<string, unknown>)['email']).toBe('acme@example.com');
  });
});
