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
