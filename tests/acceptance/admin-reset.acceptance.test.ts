/**
 * admin-reset.acceptance.test.ts
 *
 * Acceptance test:
 *  - POST /_admin/reset returns 204 and restores baseline.
 *  - GET /_admin/state matches post-boot snapshot.
 */

import { createTestApp, type TestApp } from './_helpers/test-app.js';

const ACME_ID = '00000000-0000-7000-8000-000000000001';
const BETA_ID = '00000000-0000-7000-8000-000000000002';

describe('admin-reset.acceptance', () => {
  let app: TestApp;
  let baselineStateSnapshot: string;

  beforeAll(async () => {
    app = await createTestApp();
    // Capture the post-boot state as our reference baseline
    const stateRes = await app.agent.get('/_admin/state').expect(200);
    baselineStateSnapshot = JSON.stringify(stateRes.body);
  });

  afterEach(() => {
    app.reset();
  });

  it('POST /_admin/reset returns 204 No Content', async () => {
    await app.agent.post('/_admin/reset').expect(204);
  });

  it('POST /_admin/reset with no body returns 204', async () => {
    // Mutate first
    await app.agent.post('/customers').send({ name: 'Temp', riskBand: 'LOW' }).expect(201);

    await app.agent.post('/_admin/reset').expect(204);
  });

  it('GET /_admin/state after reset matches the post-boot baseline', async () => {
    // Mutate state
    await app.agent.post('/customers').send({ name: 'Extra', riskBand: 'MED' }).expect(201);

    // Reset
    await app.agent.post('/_admin/reset').expect(204);

    // Snapshot after reset should match baseline
    const stateRes = await app.agent.get('/_admin/state').expect(200);
    const afterReset = JSON.stringify(stateRes.body);

    // Sort the entity keys so comparison is stable
    const normalize = (s: string) => {
      const obj = JSON.parse(s) as { entities: Record<string, unknown> };
      const sortedEntities = Object.fromEntries(
        Object.entries(obj.entities).sort(([a], [b]) => a.localeCompare(b)),
      );
      return JSON.stringify({ entities: sortedEntities });
    };

    expect(normalize(afterReset)).toBe(normalize(baselineStateSnapshot));
  });

  // it.failing: BUG — GET /customers/{id} throws UnhandledOperationError (Bug 2, query-intent fallback).
  it('baseline customers are present after reset', async () => {
    await app.agent.post('/customers').send({ name: 'Temp', riskBand: 'LOW' }).expect(201);
    await app.agent.post('/_admin/reset').expect(204);

    await app.agent.get(`/customers/${ACME_ID}`).expect(200);
    await app.agent.get(`/customers/${BETA_ID}`).expect(200);
  });

  // it.failing: BUG — GET /customers/{id} throws UnhandledOperationError (Bug 2, query-intent fallback).
  it('entities created before reset are gone after reset', async () => {
    const createRes = await app.agent
      .post('/customers')
      .send({ name: 'Temporary', riskBand: 'HIGH' })
      .expect(201);

    const tempId = createRes.body.id;

    await app.agent.post('/_admin/reset').expect(204);

    await app.agent.get(`/customers/${tempId}`).expect(404);
  });

  it('GET /_admin/state returns entities keyed by id', async () => {
    const stateRes = await app.agent.get('/_admin/state').expect(200);

    expect(stateRes.body).toHaveProperty('entities');
    expect(typeof stateRes.body.entities).toBe('object');
    expect(stateRes.body.entities[ACME_ID]).toBeDefined();
    expect(stateRes.body.entities[BETA_ID]).toBeDefined();
  });
});
