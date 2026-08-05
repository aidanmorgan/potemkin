import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/crm-e2e-helpers.js';
import type { JsonObject } from './_harness/crm-e2e-helpers.js';

describe('canonical strict schema behavior', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({ fixtureName: 'strict-schema' });
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('boots the non-strict YAML boundary and evaluates its computed field', async () => {
    const response = await requestThroughSpecmatic(app.stubUrl, 'POST', '/order-items', {
      description: 'Widget',
      quantity: 4,
      unitPrice: 5,
    });
    expect(response.status).toBe(201);
    expect((response.body as JsonObject).lineTotal).toBe(20);
  });
});
