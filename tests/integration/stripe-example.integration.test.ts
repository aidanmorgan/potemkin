/**
 * Behavioural-equivalence tests for the Stripe simulation (examples/stripe).
 * Boots the example via the public bootSystem + createGateway API (no Java) and
 * drives the resource lifecycle, asserting Stripe-faithful object shapes + state.
 *
 * (Provisional location while the example is built; will move to
 * examples/stripe/tests once the full resource set lands.)
 */
import * as path from 'node:path';
import { bootSystem } from '../../src/engine/boot';
import { createGateway } from '../../src/http/gateway';
import { loadOpenApi } from '../../src/contract/loader';
import { expandByContractPath } from './_helpers/crm-boot';
import { withPersistentServer, type PersistentServer, type PersistentAgent } from '../_support/persistentAgent';

const STRIPE_DIR = path.resolve(__dirname, '..', '..', 'examples', 'stripe');

describe('Stripe simulation — Customers', () => {
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(path.join(STRIPE_DIR, 'openapi', 'stripe-core.yaml'));
    const sys = await bootSystem({
      openapi,
      potemkinConfigPath: path.join(STRIPE_DIR, 'potemkin.yaml'),
    });
    expandByContractPath(sys);
    server = await withPersistentServer(createGateway(sys));
    agent = server.agent;
  });
  afterAll(async () => { await server.close(); });

  it('POST /v1/customers returns a customer object (HTTP 200, Stripe envelope, cus_ id)', async () => {
    const res = await agent.post('/v1/customers').send({ email: 'acme@example.com', name: 'Acme Inc' }).expect(200);
    const body = res.body as Record<string, unknown>;
    expect(body['object']).toBe('customer');
    expect(typeof body['id']).toBe('string');
    expect((body['id'] as string).startsWith('cus_')).toBe(true);
    expect(typeof body['created']).toBe('number');
    expect(body['livemode']).toBe(false);
    expect(body['email']).toBe('acme@example.com');
    expect(body['name']).toBe('Acme Inc');
    expect(body['balance']).toBe(0);
  });

  it('GET /v1/customers/{id} retrieves the created customer', async () => {
    const created = (await agent.post('/v1/customers').send({ email: 'r@example.com' }).expect(200)).body as Record<string, unknown>;
    const id = created['id'] as string;
    const res = await agent.get(`/v1/customers/${id}`).expect(200);
    expect((res.body as Record<string, unknown>)['id']).toBe(id);
    expect((res.body as Record<string, unknown>)['email']).toBe('r@example.com');
  });

  it('POST /v1/customers/{id} updates only the supplied fields (Stripe merge semantics)', async () => {
    const created = (await agent.post('/v1/customers').send({ email: 'u@example.com', name: 'Before' }).expect(200)).body as Record<string, unknown>;
    const id = created['id'] as string;
    const res = await agent.post(`/v1/customers/${id}`).send({ name: 'After' }).expect(200);
    const body = res.body as Record<string, unknown>;
    expect(body['name']).toBe('After');
    expect(body['email']).toBe('u@example.com'); // preserved, not nulled
  });

  it('GET /v1/customers returns a Stripe list envelope ({object:"list", data})', async () => {
    await agent.post('/v1/customers').send({ email: 'list@example.com' }).expect(200);
    const res = await agent.get('/v1/customers').expect(200);
    const body = res.body as Record<string, unknown>;
    expect(body['object']).toBe('list');
    expect(body['has_more']).toBe(false);
    expect(Array.isArray(body['data'])).toBe(true);
    expect((body['data'] as unknown[]).length).toBeGreaterThan(0);
    expect(((body['data'] as Record<string, unknown>[])[0])['object']).toBe('customer');
  });

  it('DELETE /v1/customers/{id} returns exactly the Stripe deleted object', async () => {
    const created = (await agent.post('/v1/customers').send({ email: 'd@example.com' }).expect(200)).body as Record<string, unknown>;
    const id = created['id'] as string;
    const res = await agent.delete(`/v1/customers/${id}`).expect(200);
    expect(res.body).toEqual({ id, object: 'customer', deleted: true });
  });
});

describe('Stripe simulation — Products', () => {
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(path.join(STRIPE_DIR, 'openapi', 'stripe-core.yaml'));
    const sys = await bootSystem({
      openapi,
      potemkinConfigPath: path.join(STRIPE_DIR, 'potemkin.yaml'),
    });
    expandByContractPath(sys);
    server = await withPersistentServer(createGateway(sys));
    agent = server.agent;
  });
  afterAll(async () => { await server.close(); });

  it('POST /v1/products returns a product object (HTTP 200, prod_ id, active defaults true)', async () => {
    const res = await agent.post('/v1/products').send({ name: 'Widget' }).expect(200);
    const body = res.body as Record<string, unknown>;
    expect(body['object']).toBe('product');
    expect((body['id'] as string).startsWith('prod_')).toBe(true);
    expect(typeof body['created']).toBe('number');
    expect(body['livemode']).toBe(false);
    expect(body['name']).toBe('Widget');
    expect(body['active']).toBe(true);
  });

  it('POST /v1/products/{id} updates only the supplied fields', async () => {
    const created = (await agent.post('/v1/products').send({ name: 'Before' }).expect(200)).body as Record<string, unknown>;
    const id = created['id'] as string;
    const res = await agent.post(`/v1/products/${id}`).send({ active: false }).expect(200);
    const body = res.body as Record<string, unknown>;
    expect(body['active']).toBe(false);
    expect(body['name']).toBe('Before'); // preserved
  });

  it('GET /v1/products returns a Stripe list envelope', async () => {
    await agent.post('/v1/products').send({ name: 'Listed' }).expect(200);
    const res = await agent.get('/v1/products').expect(200);
    const body = res.body as Record<string, unknown>;
    expect(body['object']).toBe('list');
    expect(Array.isArray(body['data'])).toBe(true);
    expect(((body['data'] as Record<string, unknown>[])[0])['object']).toBe('product');
  });

  it('DELETE /v1/products/{id} returns exactly the Stripe deleted object', async () => {
    const created = (await agent.post('/v1/products').send({ name: 'Doomed' }).expect(200)).body as Record<string, unknown>;
    const id = created['id'] as string;
    const res = await agent.delete(`/v1/products/${id}`).expect(200);
    expect(res.body).toEqual({ id, object: 'product', deleted: true });
  });
});

describe('Stripe simulation — Prices', () => {
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(path.join(STRIPE_DIR, 'openapi', 'stripe-core.yaml'));
    const sys = await bootSystem({
      openapi,
      potemkinConfigPath: path.join(STRIPE_DIR, 'potemkin.yaml'),
    });
    expandByContractPath(sys);
    server = await withPersistentServer(createGateway(sys));
    agent = server.agent;
  });
  afterAll(async () => { await server.close(); });

  async function makeProduct(): Promise<string> {
    return ((await agent.post('/v1/products').send({ name: 'For pricing' }).expect(200)).body as Record<string, unknown>)['id'] as string;
  }

  it('POST /v1/prices returns a price object (HTTP 200, price_ id, one_time type)', async () => {
    const product = await makeProduct();
    const res = await agent.post('/v1/prices').send({ product, unit_amount: 1500, currency: 'usd' }).expect(200);
    const body = res.body as Record<string, unknown>;
    expect(body['object']).toBe('price');
    expect((body['id'] as string).startsWith('price_')).toBe(true);
    expect(body['product']).toBe(product);
    expect(body['unit_amount']).toBe(1500);
    expect(body['currency']).toBe('usd');
    expect(body['type']).toBe('one_time');
    expect(body['active']).toBe(true);
  });

  it('GET /v1/prices/{id} retrieves the created price', async () => {
    const product = await makeProduct();
    const created = (await agent.post('/v1/prices').send({ product, currency: 'eur', unit_amount: 999 }).expect(200)).body as Record<string, unknown>;
    const id = created['id'] as string;
    const res = await agent.get(`/v1/prices/${id}`).expect(200);
    expect((res.body as Record<string, unknown>)['id']).toBe(id);
    expect((res.body as Record<string, unknown>)['unit_amount']).toBe(999);
  });

  it('POST /v1/prices/{id} updates active/nickname only', async () => {
    const product = await makeProduct();
    const created = (await agent.post('/v1/prices').send({ product, currency: 'usd', unit_amount: 500 }).expect(200)).body as Record<string, unknown>;
    const id = created['id'] as string;
    const res = await agent.post(`/v1/prices/${id}`).send({ active: false, nickname: 'Legacy' }).expect(200);
    const body = res.body as Record<string, unknown>;
    expect(body['active']).toBe(false);
    expect(body['nickname']).toBe('Legacy');
    expect(body['unit_amount']).toBe(500); // immutable, preserved
  });

  it('GET /v1/prices returns a Stripe list envelope', async () => {
    const product = await makeProduct();
    await agent.post('/v1/prices').send({ product, currency: 'usd', unit_amount: 1 }).expect(200);
    const res = await agent.get('/v1/prices').expect(200);
    const body = res.body as Record<string, unknown>;
    expect(body['object']).toBe('list');
    expect(((body['data'] as Record<string, unknown>[])[0])['object']).toBe('price');
  });
});

describe('Stripe simulation — PaymentIntents (state machine)', () => {
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(path.join(STRIPE_DIR, 'openapi', 'stripe-core.yaml'));
    const sys = await bootSystem({
      openapi,
      potemkinConfigPath: path.join(STRIPE_DIR, 'potemkin.yaml'),
    });
    expandByContractPath(sys);
    server = await withPersistentServer(createGateway(sys));
    agent = server.agent;
  });
  afterAll(async () => { await server.close(); });

  async function createPI(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await agent.post('/v1/payment_intents').send(body).expect(200)).body as Record<string, unknown>;
  }

  it('POST /v1/payment_intents (no payment_method) starts in requires_payment_method', async () => {
    const pi = await createPI({ amount: 2000, currency: 'usd' });
    expect(pi['object']).toBe('payment_intent');
    expect((pi['id'] as string).startsWith('pi_')).toBe(true);
    expect(pi['status']).toBe('requires_payment_method');
    expect(pi['amount']).toBe(2000);
    expect(pi['amount_received']).toBe(0);
    expect(pi['capture_method']).toBe('automatic');
    expect((pi['client_secret'] as string).startsWith(`${pi['id'] as string}_secret_`)).toBe(true);
  });

  it('POST /v1/payment_intents with payment_method starts in requires_confirmation', async () => {
    const pi = await createPI({ amount: 500, currency: 'usd', payment_method: 'pm_card_visa' });
    expect(pi['status']).toBe('requires_confirmation');
    expect(pi['payment_method']).toBe('pm_card_visa');
  });

  it('confirm advances an automatic-capture intent to succeeded with full amount_received', async () => {
    const pi = await createPI({ amount: 2000, currency: 'usd', payment_method: 'pm_card_visa' });
    const id = pi['id'] as string;
    const confirmed = (await agent.post(`/v1/payment_intents/${id}/confirm`).send({}).expect(200)).body as Record<string, unknown>;
    expect(confirmed['status']).toBe('succeeded');
    expect(confirmed['amount_received']).toBe(2000);
  });

  it('manual capture flow: confirm -> requires_capture, capture -> succeeded', async () => {
    const pi = await createPI({ amount: 1000, currency: 'usd', payment_method: 'pm_card_visa', capture_method: 'manual' });
    const id = pi['id'] as string;
    const confirmed = (await agent.post(`/v1/payment_intents/${id}/confirm`).send({}).expect(200)).body as Record<string, unknown>;
    expect(confirmed['status']).toBe('requires_capture');
    expect(confirmed['amount_received']).toBe(0);
    const captured = (await agent.post(`/v1/payment_intents/${id}/capture`).send({}).expect(200)).body as Record<string, unknown>;
    expect(captured['status']).toBe('succeeded');
    expect(captured['amount_received']).toBe(1000);
  });

  it('cancel moves a non-terminal intent to canceled with a reason', async () => {
    const pi = await createPI({ amount: 700, currency: 'usd' });
    const id = pi['id'] as string;
    const canceled = (await agent.post(`/v1/payment_intents/${id}/cancel`).send({ cancellation_reason: 'abandoned' }).expect(200)).body as Record<string, unknown>;
    expect(canceled['status']).toBe('canceled');
    expect(canceled['cancellation_reason']).toBe('abandoned');
  });

  it('confirming a succeeded intent is rejected by the state-machine guard', async () => {
    const pi = await createPI({ amount: 300, currency: 'usd', payment_method: 'pm_card_visa' });
    const id = pi['id'] as string;
    await agent.post(`/v1/payment_intents/${id}/confirm`).send({}).expect(200);
    const res = await agent.post(`/v1/payment_intents/${id}/confirm`).send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const details = (res.body as Record<string, unknown>)['details'] as Record<string, unknown>;
    expect(details['code']).toBe('PAYMENT_INTENT_UNEXPECTED_STATE');
  });

  it('canceling a succeeded intent is rejected by the state-machine guard', async () => {
    const pi = await createPI({ amount: 300, currency: 'usd', payment_method: 'pm_card_visa' });
    const id = pi['id'] as string;
    await agent.post(`/v1/payment_intents/${id}/confirm`).send({}).expect(200);
    const res = await agent.post(`/v1/payment_intents/${id}/cancel`).send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('GET /v1/payment_intents/{id} retrieves the intent; GET /v1/payment_intents lists the envelope', async () => {
    const pi = await createPI({ amount: 1234, currency: 'usd' });
    const id = pi['id'] as string;
    const got = (await agent.get(`/v1/payment_intents/${id}`).expect(200)).body as Record<string, unknown>;
    expect(got['id']).toBe(id);
    const list = (await agent.get('/v1/payment_intents').expect(200)).body as Record<string, unknown>;
    expect(list['object']).toBe('list');
    expect(((list['data'] as Record<string, unknown>[])[0])['object']).toBe('payment_intent');
  });
});

describe('Stripe simulation — Charges (created by reaction)', () => {
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(path.join(STRIPE_DIR, 'openapi', 'stripe-core.yaml'));
    const sys = await bootSystem({
      openapi,
      potemkinConfigPath: path.join(STRIPE_DIR, 'potemkin.yaml'),
    });
    expandByContractPath(sys);
    server = await withPersistentServer(createGateway(sys));
    agent = server.agent;
  });
  afterAll(async () => { await server.close(); });

  it('confirming an automatic-capture intent materialises a captured charge linked to the intent', async () => {
    const pi = (await agent.post('/v1/payment_intents').send({ amount: 2000, currency: 'usd', payment_method: 'pm_card_visa' }).expect(200)).body as Record<string, unknown>;
    const confirmed = (await agent.post(`/v1/payment_intents/${pi['id'] as string}/confirm`).send({}).expect(200)).body as Record<string, unknown>;
    const chargeId = confirmed['latest_charge'] as string;
    expect(chargeId.startsWith('ch_')).toBe(true);

    const charge = (await agent.get(`/v1/charges/${chargeId}`).expect(200)).body as Record<string, unknown>;
    expect(charge['object']).toBe('charge');
    expect(charge['amount']).toBe(2000);
    expect(charge['currency']).toBe('usd');
    expect(charge['paid']).toBe(true);
    expect(charge['captured']).toBe(true);
    expect(charge['status']).toBe('succeeded');
    expect(charge['amount_captured']).toBe(2000);
    expect(charge['payment_intent']).toBe(pi['id']);
    expect(charge['refunded']).toBe(false);
  });

  it('a manual-capture intent yields an authorised-but-uncaptured charge that is captured on capture', async () => {
    const pi = (await agent.post('/v1/payment_intents').send({ amount: 1000, currency: 'usd', payment_method: 'pm_card_visa', capture_method: 'manual' }).expect(200)).body as Record<string, unknown>;
    const id = pi['id'] as string;
    const confirmed = (await agent.post(`/v1/payment_intents/${id}/confirm`).send({}).expect(200)).body as Record<string, unknown>;
    const chargeId = confirmed['latest_charge'] as string;

    const before = (await agent.get(`/v1/charges/${chargeId}`).expect(200)).body as Record<string, unknown>;
    expect(before['captured']).toBe(false);
    expect(before['amount_captured']).toBe(0);

    await agent.post(`/v1/payment_intents/${id}/capture`).send({}).expect(200);
    const after = (await agent.get(`/v1/charges/${chargeId}`).expect(200)).body as Record<string, unknown>;
    expect(after['captured']).toBe(true);
    expect(after['amount_captured']).toBe(1000);
  });

  it('GET /v1/charges?payment_intent= filters charges by intent', async () => {
    const pi = (await agent.post('/v1/payment_intents').send({ amount: 42, currency: 'usd', payment_method: 'pm_card_visa' }).expect(200)).body as Record<string, unknown>;
    await agent.post(`/v1/payment_intents/${pi['id'] as string}/confirm`).send({}).expect(200);
    const res = (await agent.get('/v1/charges').query({ payment_intent: pi['id'] as string }).expect(200)).body as Record<string, unknown>;
    expect(res['object']).toBe('list');
    const data = res['data'] as Record<string, unknown>[];
    expect(data.length).toBe(1);
    expect(data[0]['payment_intent']).toBe(pi['id']);
  });
});
