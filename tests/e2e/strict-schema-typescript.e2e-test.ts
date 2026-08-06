import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

describe('E2E-016 TypeScript non-strict schema mode', () => {
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

  it('boots and evaluates the incomplete-dependency computed field', async () => {
    const response = await requestThroughSpecmatic(app.stubUrl, 'POST', '/order-items', {
      description: 'non-strict',
      quantity: 3,
      unitPrice: 7,
    });
    expect(response.status).toBe(201);
    expect((response.body as JsonObject).lineTotal).toBe(21);
  }, 60_000);
});
