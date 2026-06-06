/**
 * Regression: the card-decline fault must fire on the realistic confirm flow.
 * A PaymentIntent is created with the decline token (pm_card_chargeDeclined),
 * then confirmed with an EMPTY body (Stripe's normal flow — the payment_method
 * is already attached). The fault rule must match on the PI's stored state, not
 * only the confirm request payload, otherwise the decline silently leaks and a
 * charge succeeds.
 */
import * as path from 'node:path';
import { bootSystem } from '../../src/engine/boot';
import { createGateway } from '../../src/http/gateway';
import { loadOpenApi } from '../../src/contract/loader';
import { expandByContractPath } from './_helpers/crm-boot';
import { withPersistentServer, type PersistentServer, type PersistentAgent } from '../_support/persistentAgent';

const STRIPE_DIR = path.resolve(__dirname, '..', '..', 'examples', 'stripe');

type Obj = Record<string, unknown>;

describe('Stripe card-decline fault on empty-body confirm (regression)', () => {
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

  async function createPI(payment_method?: string): Promise<string> {
    const body: Obj = { amount: 2000, currency: 'usd' };
    if (payment_method) body['payment_method'] = payment_method;
    return ((await agent.post('/v1/payment_intents').send(body)).body as Obj)['id'] as string;
  }

  it('declines when the decline token is attached at create and confirm has an empty body', async () => {
    const id = await createPI('pm_card_chargeDeclined');
    const res = await agent.post(`/v1/payment_intents/${id}/confirm`).send({});
    expect(res.status).toBe(402);
    expect(((res.body as Obj)['error'] as Obj)['code']).toBe('card_declined');
    // No charge: the PI did not succeed.
    const pi = (await agent.get(`/v1/payment_intents/${id}`)).body as Obj;
    expect(pi['status']).not.toBe('succeeded');
    expect(pi['latest_charge']).toBeNull();
  });

  it('still declines when the token is re-sent on confirm', async () => {
    const id = await createPI();
    const res = await agent.post(`/v1/payment_intents/${id}/confirm`).send({ payment_method: 'pm_card_chargeDeclined' });
    expect(res.status).toBe(402);
  });

  it('a normal payment_method confirms successfully with an empty body', async () => {
    const id = await createPI('pm_card_visa');
    const res = await agent.post(`/v1/payment_intents/${id}/confirm`).send({});
    expect(res.status).toBe(200);
    expect((res.body as Obj)['status']).toBe('succeeded');
  });
});
