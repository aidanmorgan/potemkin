/**
 * Regression: form-encoded request bodies must be validated. The real Stripe
 * spec declares request bodies only under application/x-www-form-urlencoded, so
 * before the loader fell back to that media type, an invalid body (wrong type /
 * missing required field) skipped request validation, mutated state, and only
 * tripped RESPONSE validation — surfacing as a leaked 500 instead of a clean
 * 400. This proves a 400 at the request boundary with no state mutation.
 */
import * as path from 'node:path';
import { bootSystem } from '../../src/engine/boot';
import { createGateway } from '../../src/http/gateway';
import { loadOpenApi } from '../../src/contract/loader';
import { expandByContractPath } from './_helpers/crm-boot';
import { withPersistentServer, type PersistentServer, type PersistentAgent } from '../_support/persistentAgent';

const STRIPE_DIR = path.resolve(__dirname, '..', '..', 'examples', 'stripe');

type Obj = Record<string, unknown>;

describe('Stripe form-encoded request validation (regression)', () => {
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(path.join(STRIPE_DIR, 'openapi', 'stripe-official.json'));
    const sys = await bootSystem({ openapi, potemkinConfigPath: path.join(STRIPE_DIR, 'potemkin.yaml') });
    expandByContractPath(sys);
    server = await withPersistentServer(createGateway(sys));
    agent = server.agent;
  });
  afterAll(async () => { await server.close(); });

  it('a valid PaymentIntent body still succeeds', async () => {
    const res = await agent.post('/v1/payment_intents').send({ amount: 2000, currency: 'usd' });
    expect(res.status).toBe(200);
    expect((res.body as Obj)['object']).toBe('payment_intent');
  });

  it('a wrong-typed required field is rejected with 400 (not a leaked 500)', async () => {
    const before = ((await agent.get('/v1/payment_intents')).body as Obj)['data'] as unknown[];
    const res = await agent.post('/v1/payment_intents').send({ amount: 'lots', currency: 'usd' });
    expect(res.status).toBe(400);
    // No state mutation: the bad command never created a payment_intent.
    const after = ((await agent.get('/v1/payment_intents')).body as Obj)['data'] as unknown[];
    expect(after.length).toBe(before.length);
  });

  it('a missing required field is rejected with 400', async () => {
    const res = await agent.post('/v1/payment_intents').send({ currency: 'usd' });
    expect(res.status).toBe(400);
  });
});
