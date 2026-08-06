import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import { getEventCount } from './_harness/crm-e2e-helpers';

describe('E2E-015b TypeScript state validation', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: 'strict-schema',
      potemkinConfigPath: path.resolve('tests/fixtures/strict-schema/potemkin-typescript.yml'),
      warmupPath: '/order-items/missing',
      warmupExpectedStatus: 404,
    });
  }, 120_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('accepts valid state and rejects invalid state without appending an event', async () => {
    const valid = await requestThroughSpecmatic(app.stubUrl, 'POST', '/order-items', {
      description: 'valid',
      quantity: 2,
      unitPrice: 5,
    });
    expect(valid.status).toBe(201);
    const before = await getEventCount(app.engineUrl);
    const invalid = await requestThroughSpecmatic(app.stubUrl, 'POST', '/order-items', {
      description: 'invalid',
      quantity: -1,
      unitPrice: 5,
    });
    expect([400, 422, 500]).toContain(invalid.status);
    expect(await getEventCount(app.engineUrl)).toBe(before);
  }, 60_000);
});
