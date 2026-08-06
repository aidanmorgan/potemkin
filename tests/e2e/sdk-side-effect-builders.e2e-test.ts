import * as path from 'node:path';
import { defineFault, faultName } from 'potemkin/sdk';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import { getEventCount } from './_harness/crm-e2e-helpers';

describe('E2E-012a TypeScript fault builder', () => {
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

  it('takes the fault branch without an event, then commits the normal branch', async () => {
    const fault = defineFault({
      name: faultName('coverage-fault'),
      matches: () => true,
      response: { status: 503 },
    });
    expect(fault.name).toBe('coverage-fault');
    const before = await getEventCount(app.engineUrl);
    const failed = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/orders',
      { id: 'fault-order', name: 'fault', quantity: 1, internalNote: 'private' },
      { 'x-parity-fault': 'on' },
    );
    expect(failed.status).toBe(503);
    expect(await getEventCount(app.engineUrl)).toBe(before);
    const normal = await requestThroughSpecmatic(app.stubUrl, 'POST', '/orders', {
      id: 'normal-order',
      name: 'normal',
      quantity: 1,
      internalNote: 'private',
    });
    expect(normal.status).toBe(201);
    expect(await getEventCount(app.engineUrl)).toBeGreaterThan(before);
  }, 60_000);
});
