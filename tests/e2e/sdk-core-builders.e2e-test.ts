import * as path from 'node:path';
import { event, behavior, reducerRule, eventType, behaviorName, operationId } from 'potemkin/sdk';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';

describe('E2E-011a TypeScript core builders', () => {
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

  it('uses event, behavior, and reducer builders for a projected state', async () => {
    const created = event(eventType('CoverageCreated'), { value: 'ok' });
    const selected = behavior(behaviorName('coverage'))
      .operation(operationId('createOrder'))
      .emit(eventType('CoverageCreated'))
      .build();
    const projected = reducerRule(eventType('CoverageCreated'))
      .apply(({ state, event: emitted }) => ({ ...state, value: emitted.payload['value'] }))
      .build();
    expect([created, selected, projected]).toHaveLength(3);
    const response = await requestThroughSpecmatic(app.stubUrl, 'POST', '/orders', {
      id: 'builder-order',
      name: 'builder',
      quantity: 2,
      internalNote: 'private',
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual(
      expect.objectContaining({ id: 'builder-order', status: 'CREATED' }),
    );
  }, 60_000);
});
