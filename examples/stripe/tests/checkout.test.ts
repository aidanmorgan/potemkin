/**
 * Stripe example — a realistic end-to-end CHECKOUT + REFUND flow, driven from the
 * consumer side through the Specmatic stub. Exercises most of the simulated API
 * (customer, product, price, payment_intent, charge, refund) and several Potemkin
 * features at once: the resource aggregate (Customer), response shaping, the
 * PaymentIntent state machine, reaction-materialised Charges, and the refund
 * reaction that accrues amount_refunded on the charge.
 */
import { startExampleStack, type ExampleStack } from '../../_harness/example-stack';
import { ConsumerClient } from '../../_harness/consumer-client';

type Obj = Record<string, unknown>;

describe('Stripe example — checkout + refund flow', () => {
  let stack: ExampleStack;
  let stripe: ConsumerClient;

  beforeAll(async () => {
    stack = await startExampleStack({ exampleName: 'stripe' });
    stripe = new ConsumerClient(stack.stubUrl);
  }, 90_000);

  afterAll(async () => { if (stack) await stack.shutdown(); });
  beforeEach(async () => { await stack.reset(); });

  it('a customer buys a product: catalog -> intent -> charge -> partial refund reconciles', async () => {
    // 1. A customer.
    const customer = (await stripe.post('/v1/customers', { form: { email: 'buyer@example.com', name: 'Buyer' } })).body as Obj;
    expect((customer['id'] as string).startsWith('cus_')).toBe(true);

    // 2. A product + a price for it.
    const product = (await stripe.post('/v1/products', { form: { name: 'Pro Plan' } })).body as Obj;
    const price = (await stripe.post('/v1/prices', { form: { product: product['id'], currency: 'usd', unit_amount: 4200 } })).body as Obj;
    expect(price['product']).toBe(product['id']);
    expect(price['unit_amount']).toBe(4200);

    // 3. A PaymentIntent for the customer at that price, with a good card.
    const pi = (await stripe.post('/v1/payment_intents', {
      form: { amount: price['unit_amount'] as number, currency: 'usd', customer: customer['id'], payment_method: 'pm_card_visa' },
    })).body as Obj;
    expect(pi['status']).toBe('requires_confirmation');
    expect(pi['customer']).toBe(customer['id']);

    // 4. Confirm -> succeeded, and a Charge is materialised by the reaction.
    const confirmed = (await stripe.post(`/v1/payment_intents/${pi['id'] as string}/confirm`, { form: {} })).body as Obj;
    expect(confirmed['status']).toBe('succeeded');
    expect(confirmed['amount_received']).toBe(4200);
    const chargeId = confirmed['latest_charge'] as string;
    expect(chargeId.startsWith('ch_')).toBe(true);

    const charge = (await stripe.get(`/v1/charges/${chargeId}`)).body as Obj;
    expect(charge['amount']).toBe(4200);
    expect(charge['captured']).toBe(true);
    expect(charge['payment_intent']).toBe(pi['id']);
    expect(charge['refunded']).toBe(false);

    // 5. A partial refund accrues on the charge.
    const refund1 = (await stripe.post('/v1/refunds', { form: { charge: chargeId, amount: 1200 } })).body as Obj;
    expect((refund1['id'] as string).startsWith('re_')).toBe(true);
    let reconciled = (await stripe.get(`/v1/charges/${chargeId}`)).body as Obj;
    expect(reconciled['amount_refunded']).toBe(1200);
    expect(reconciled['refunded']).toBe(false);

    // 6. A second refund for the remainder fully refunds the charge.
    await stripe.post('/v1/refunds', { form: { charge: chargeId, amount: 3000 } });
    reconciled = (await stripe.get(`/v1/charges/${chargeId}`)).body as Obj;
    expect(reconciled['amount_refunded']).toBe(4200);
    expect(reconciled['refunded']).toBe(true);

    // 7. The refunds list for the charge shows both, as a Stripe envelope.
    const refunds = (await stripe.get('/v1/refunds', { query: { charge: chargeId } })).body as Obj;
    expect(refunds['object']).toBe('list');
    expect((refunds['data'] as unknown[]).length).toBe(2);
  });

  it('a declined card never produces a charge; the consumer recovers on a new intent', async () => {
    const pi = (await stripe.post('/v1/payment_intents', {
      form: { amount: 5000, currency: 'usd', payment_method: 'pm_card_chargeDeclined' },
    })).body as Obj;
    const declined = await stripe.post(`/v1/payment_intents/${pi['id'] as string}/confirm`, { form: { payment_method: 'pm_card_chargeDeclined' } });
    expect(declined.status).toBe(402);
    expect(((declined.body as Obj)['error'] as Obj)['code']).toBe('card_declined');

    // No charge was created for the declined intent.
    const charges = (await stripe.get('/v1/charges', { query: { payment_intent: pi['id'] as string } })).body as Obj;
    expect((charges['data'] as unknown[]).length).toBe(0);

    // Recovery: a fresh intent with a good card succeeds and yields a charge.
    const ok = (await stripe.post('/v1/payment_intents', { form: { amount: 5000, currency: 'usd', payment_method: 'pm_card_visa' } })).body as Obj;
    const confirmed = (await stripe.post(`/v1/payment_intents/${ok['id'] as string}/confirm`, { form: {} })).body as Obj;
    expect(confirmed['status']).toBe('succeeded');
    expect((confirmed['latest_charge'] as string).startsWith('ch_')).toBe(true);
  });
});
