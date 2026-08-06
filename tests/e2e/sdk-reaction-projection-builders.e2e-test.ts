import * as path from 'node:path';
import { defineProjection, defineReaction } from 'potemkin/sdk';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import { getAllEvents } from './_harness/crm-e2e-helpers';

describe('E2E-012b TypeScript reaction and projection builders', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: 'authoring-parity',
      potemkinConfigPath: path.resolve('tests/fixtures/authoring-parity/potemkin-typescript.yml'),
      warmupPath: '/orders/not-created',
      warmupExpectedStatus: 404,
    });
  }, 120_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('creates the secondary reaction event and projection input through Specmatic', async () => {
    const reaction = defineReaction({
      on: 'Order:OrderCreated' as never,
      boundary: 'Audit' as never,
      emit: 'AuditRecorded' as never,
    });
    const projection = defineProjection({
      name: 'CoverageProjection' as never,
      key: () => 'key',
      subscribe: ['Order:OrderCreated' as never],
      reduce: [],
    });
    expect([reaction, projection]).toHaveLength(2);
    const response = await requestThroughSpecmatic(app.stubUrl, 'POST', '/orders', {
      id: 'reaction-order',
      name: 'reaction',
      quantity: 1,
      internalNote: 'private',
    });
    expect(response.status).toBe(201);
    const events = await getAllEvents(app.engineUrl);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'AuditRecorded',
          payload: expect.objectContaining({ orderId: 'reaction-order' }),
        }),
      ]),
    );
  }, 60_000);
});
