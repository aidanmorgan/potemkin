/**
 * Stripe example — product + price catalog, driven from the consumer side through
 * the Specmatic stub. Covers CRUD + listing/filtering and a couple of Potemkin
 * features (idempotent create, clock-shifted `created`).
 */
import { startExampleStack, type ExampleStack } from '../../../src/conformance/exampleStack.js';
import { ConsumerClient } from '../../_harness/consumer-client';

type Obj = Record<string, unknown>;

describe('Stripe example — product + price catalog', () => {
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

  it('product CRUD: create (active defaults true), update merge, delete object, list', async () => {
    const created = (await stripe.post('/v1/products', { form: { name: 'Widget' } })).body as Obj;
    expect((created['id'] as string).startsWith('prod_')).toBe(true);
    expect(created['active']).toBe(true);

    const updated = (
      await stripe.post(`/v1/products/${created['id'] as string}`, { form: { active: false } })
    ).body as Obj;
    expect(updated['active']).toBe(false);
    expect(updated['name']).toBe('Widget'); // preserved

    const list = (await stripe.get('/v1/products')).body as Obj;
    expect(list['object']).toBe('list');
    expect((list['data'] as Obj[])[0]['object']).toBe('product');

    const deleted = (await stripe.delete(`/v1/products/${created['id'] as string}`)).body as Obj;
    expect(deleted).toEqual({ id: created['id'], object: 'product', deleted: true });

    const afterDelete = await stripe.get(`/v1/products/${created['id'] as string}`);
    expect(afterDelete.status).toBe(404);
  });

  it('rejects a refund that exceeds the charge without committing refund state', async () => {
    const intent = (
      await stripe.post('/v1/payment_intents', {
        form: { amount: 1000, currency: 'usd', payment_method: 'pm_card_visa' },
      })
    ).body as Obj;
    const confirmed = (
      await stripe.post(`/v1/payment_intents/${intent['id'] as string}/confirm`, { form: {} })
    ).body as Obj;
    const chargeId = confirmed['latest_charge'] as string;

    const first = await stripe.post('/v1/refunds', {
      form: { charge: chargeId, amount: 1000 },
    });
    expect(first.status).toBe(200);

    const overRefund = await stripe.post('/v1/refunds', {
      form: { charge: chargeId, amount: 1 },
    });
    expect(overRefund.status).toBe(400);
    expect(((overRefund.body as Obj)['error'] as Obj)['code']).toBe('REFUND_EXCEEDS_CHARGE');

    const refunds = (await stripe.get('/v1/refunds', { query: { charge: chargeId } })).body as Obj;
    expect((refunds['data'] as unknown[]).length).toBe(1);
    const charge = (await stripe.get(`/v1/charges/${chargeId}`)).body as Obj;
    expect(charge['amount_refunded']).toBe(1000);
  });

  it('price references a product, is immutable except active/nickname, and lists by product', async () => {
    const product = (await stripe.post('/v1/products', { form: { name: 'Plan' } })).body as Obj;
    const price = (
      await stripe.post('/v1/prices', {
        form: { product: product['id'], currency: 'usd', unit_amount: 999 },
      })
    ).body as Obj;
    expect(price['product']).toBe(product['id']);
    expect(price['type']).toBe('one_time');

    // Only active/nickname/metadata are updatable; unit_amount is immutable.
    const updated = (
      await stripe.post(`/v1/prices/${price['id'] as string}`, {
        form: { active: false, nickname: 'Retired' },
      })
    ).body as Obj;
    expect(updated['active']).toBe(false);
    expect(updated['nickname']).toBe('Retired');
    expect(updated['unit_amount']).toBe(999);

    // List filtered by product.
    const list = (await stripe.get('/v1/prices', { query: { product: product['id'] as string } }))
      .body as Obj;
    const data = list['data'] as Obj[];
    expect(data.length).toBe(1);
    expect(data[0]['product']).toBe(product['id']);
  });

  it('idempotent create: retrying with the same Idempotency-Key returns the same product', async () => {
    const headers = { 'Idempotency-Key': 'catalog-product-1' };
    const first = (await stripe.post('/v1/products', { form: { name: 'Once' }, headers }))
      .body as Obj;
    const retry = await stripe.post('/v1/products', { form: { name: 'Once' }, headers });
    expect(retry.status).toBe(200);
    expect((retry.body as Obj)['id']).toBe(first['id']);
    expect(retry.headers.get('x-idempotency-replay')).toBe('true');
  });

  it('clock control: X-Potemkin-Clock-Offset shifts the product created timestamp', async () => {
    const base = (await stripe.post('/v1/products', { form: { name: 'Now' } })).body as Obj;
    const offsetMs = 200 * 24 * 60 * 60 * 1000; // +200 days
    const shifted = (
      await stripe.post('/v1/products', {
        form: { name: 'Future' },
        headers: { 'X-Potemkin-Clock-Offset': String(offsetMs) },
      })
    ).body as Obj;
    expect((shifted['created'] as number) - (base['created'] as number)).toBeGreaterThan(
      190 * 24 * 60 * 60,
    );
  });
});
