/**
 * Stripe example — consumer-side, contract-driven integration tests.
 *
 * The test plays a service integrating with Stripe. It drives the Specmatic stub
 * (Specmatic enforces the OpenAPI contract) and forces known states THROUGH the
 * stub using the four mechanisms Potemkin exposes:
 *   1. declarative seeding (initialization: in the DSL)
 *   2. fault injection (a Stripe-faithful card decline)
 *   3. idempotency retries (Idempotency-Key)
 *   4. clock control (X-Potemkin-Clock-Offset) + reset-through-stub
 */
import { startExampleStack, type ExampleStack } from '../../_harness/example-stack';
import { ConsumerClient } from '../../_harness/consumer-client';

const SEEDED_CUSTOMER = 'cus_seed000000000000000001';

describe('Stripe example — consumer integration', () => {
  let stack: ExampleStack;
  let stripe: ConsumerClient;

  beforeAll(async () => {
    stack = await startExampleStack({ exampleName: 'stripe' });
    stripe = new ConsumerClient(stack.stubUrl);
  }, 90_000);

  afterAll(async () => {
    if (stack) await stack.shutdown();
  });

  beforeEach(async () => {
    await stack.reset();
  });

  // 1. Declarative seeding ----------------------------------------------------
  it('starts from a known seeded customer (declarative initialization)', async () => {
    const res = await stripe.get(`/v1/customers/${SEEDED_CUSTOMER}`);
    expect(res.status).toBe(200);
    const customer = res.body as Record<string, unknown>;
    expect(customer['email']).toBe('seeded@example.com');
    expect(customer['name']).toBe('Seeded Customer');
  });

  // 2. Fault injection --------------------------------------------------------
  it('handles a card decline: confirming with the decline token returns a 402 card_error', async () => {
    const pi = (await stripe.post('/v1/payment_intents', {
      form: { amount: 2000, currency: 'usd', payment_method: 'pm_card_chargeDeclined' },
    })).body as Record<string, unknown>;
    expect(pi['status']).toBe('requires_confirmation');

    const declined = await stripe.post(`/v1/payment_intents/${pi['id'] as string}/confirm`, {
      form: { payment_method: 'pm_card_chargeDeclined' },
    });
    expect(declined.status).toBe(402);
    const error = (declined.body as Record<string, unknown>)['error'] as Record<string, unknown>;
    expect(error['type']).toBe('card_error');
    expect(error['code']).toBe('card_declined');

    // The consumer can recover: a good card on a fresh intent succeeds.
    const ok = (await stripe.post('/v1/payment_intents', {
      form: { amount: 2000, currency: 'usd', payment_method: 'pm_card_visa' },
    })).body as Record<string, unknown>;
    const confirmed = await stripe.post(`/v1/payment_intents/${ok['id'] as string}/confirm`, { form: {} });
    expect(confirmed.status).toBe(200);
    expect((confirmed.body as Record<string, unknown>)['status']).toBe('succeeded');
  });

  // 3. Idempotency ------------------------------------------------------------
  it('retrying a create with the same Idempotency-Key does not duplicate the customer', async () => {
    const key = 'consumer-create-customer-001';
    const headers = { 'Idempotency-Key': key };

    const first = await stripe.post('/v1/customers', { form: { email: 'idem@example.com' }, headers });
    expect(first.status).toBe(200);
    const firstId = (first.body as Record<string, unknown>)['id'] as string;

    // Simulated retry (e.g. the consumer timed out and retried) — same key.
    const retry = await stripe.post('/v1/customers', { form: { email: 'idem@example.com' }, headers });
    expect(retry.status).toBe(200);
    expect((retry.body as Record<string, unknown>)['id']).toBe(firstId);
    expect(retry.headers.get('x-idempotency-replay')).toBe('true');

    // And the collection holds exactly one such customer.
    const list = (await stripe.get('/v1/customers', { query: { email: 'idem@example.com' } })).body as Record<string, unknown>;
    expect((list['data'] as unknown[]).length).toBe(1);
  });

  // 4. Clock control ----------------------------------------------------------
  it('forces the created timestamp forward with X-Potemkin-Clock-Offset', async () => {
    const baseline = (await stripe.post('/v1/customers', { form: { email: 'now@example.com' } })).body as Record<string, unknown>;
    const baseCreated = baseline['created'] as number;

    const offsetMs = 365 * 24 * 60 * 60 * 1000; // +1 year
    const shifted = (await stripe.post('/v1/customers', {
      form: { email: 'future@example.com' },
      headers: { 'X-Potemkin-Clock-Offset': String(offsetMs) },
    })).body as Record<string, unknown>;
    const shiftedCreated = shifted['created'] as number;

    // ~1 year (in seconds) ahead of the un-shifted create.
    expect(shiftedCreated - baseCreated).toBeGreaterThan(360 * 24 * 60 * 60);
  });
});
