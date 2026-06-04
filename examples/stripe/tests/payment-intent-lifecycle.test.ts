/**
 * Stripe example — the PaymentIntent state machine, driven from the consumer side
 * through the Specmatic stub. Exercises the requires-guarded transitions across
 * the confirm/capture/cancel sub-action boundaries and the Charge reactions.
 */
import { startExampleStack, type ExampleStack } from '../../_harness/example-stack';
import { ConsumerClient } from '../../_harness/consumer-client';

type Obj = Record<string, unknown>;

describe('Stripe example — PaymentIntent lifecycle', () => {
  let stack: ExampleStack;
  let stripe: ConsumerClient;

  beforeAll(async () => {
    stack = await startExampleStack({ exampleName: 'stripe' });
    stripe = new ConsumerClient(stack.stubUrl);
  }, 90_000);
  afterAll(async () => { if (stack) await stack.shutdown(); });
  beforeEach(async () => { await stack.reset(); });

  async function createPI(form: Obj): Promise<Obj> {
    return (await stripe.post('/v1/payment_intents', { form })).body as Obj;
  }

  it('automatic capture: confirm -> succeeded with a captured charge', async () => {
    const pi = await createPI({ amount: 2000, currency: 'usd', payment_method: 'pm_card_visa' });
    const c = (await stripe.post(`/v1/payment_intents/${pi['id'] as string}/confirm`, { form: {} })).body as Obj;
    expect(c['status']).toBe('succeeded');
    const charge = (await stripe.get(`/v1/charges/${c['latest_charge'] as string}`)).body as Obj;
    expect(charge['captured']).toBe(true);
    expect(charge['amount_captured']).toBe(2000);
  });

  it('manual capture: confirm -> requires_capture (uncaptured charge), capture -> succeeded', async () => {
    const pi = await createPI({ amount: 1000, currency: 'usd', payment_method: 'pm_card_visa', capture_method: 'manual' });
    const id = pi['id'] as string;
    const confirmed = (await stripe.post(`/v1/payment_intents/${id}/confirm`, { form: {} })).body as Obj;
    expect(confirmed['status']).toBe('requires_capture');
    const before = (await stripe.get(`/v1/charges/${confirmed['latest_charge'] as string}`)).body as Obj;
    expect(before['captured']).toBe(false);
    expect(before['amount_captured']).toBe(0);

    const captured = (await stripe.post(`/v1/payment_intents/${id}/capture`, { form: {} })).body as Obj;
    expect(captured['status']).toBe('succeeded');
    const after = (await stripe.get(`/v1/charges/${captured['latest_charge'] as string}`)).body as Obj;
    expect(after['captured']).toBe(true);
    expect(after['amount_captured']).toBe(1000);
  });

  it('cancel moves a non-terminal intent to canceled with a reason', async () => {
    const pi = await createPI({ amount: 700, currency: 'usd' });
    const canceled = (await stripe.post(`/v1/payment_intents/${pi['id'] as string}/cancel`, { form: { cancellation_reason: 'abandoned' } })).body as Obj;
    expect(canceled['status']).toBe('canceled');
    expect(canceled['cancellation_reason']).toBe('abandoned');
  });

  it('guards reject invalid transitions: confirm/cancel/capture on a terminal intent', async () => {
    const pi = await createPI({ amount: 300, currency: 'usd', payment_method: 'pm_card_visa' });
    const id = pi['id'] as string;
    await stripe.post(`/v1/payment_intents/${id}/confirm`, { form: {} }); // -> succeeded

    const reConfirm = await stripe.post(`/v1/payment_intents/${id}/confirm`, { form: {} });
    expect(reConfirm.status).toBeGreaterThanOrEqual(400);
    expect(((reConfirm.body as Obj)['details'] as Obj)['code']).toBe('PAYMENT_INTENT_UNEXPECTED_STATE');

    const cancel = await stripe.post(`/v1/payment_intents/${id}/cancel`, { form: {} });
    expect(cancel.status).toBeGreaterThanOrEqual(400);

    // capture requires requires_capture; a succeeded (auto-captured) intent rejects it.
    const capture = await stripe.post(`/v1/payment_intents/${id}/capture`, { form: {} });
    expect(capture.status).toBeGreaterThanOrEqual(400);
  });

  it('cannot update a terminal intent (guarded by requires)', async () => {
    const pi = await createPI({ amount: 300, currency: 'usd', payment_method: 'pm_card_visa' });
    const id = pi['id'] as string;
    await stripe.post(`/v1/payment_intents/${id}/confirm`, { form: {} });
    const update = await stripe.post(`/v1/payment_intents/${id}`, { form: { description: 'too late' } });
    expect(update.status).toBeGreaterThanOrEqual(400);
  });

  it('GET retrieves the intent and the collection lists it (Stripe envelope)', async () => {
    const pi = await createPI({ amount: 1234, currency: 'usd' });
    const got = (await stripe.get(`/v1/payment_intents/${pi['id'] as string}`)).body as Obj;
    expect(got['id']).toBe(pi['id']);
    const list = (await stripe.get('/v1/payment_intents').then((r) => r)).body as Obj;
    expect(list['object']).toBe('list');
    expect(((list['data'] as Obj[])[0])['object']).toBe('payment_intent');
  });
});
