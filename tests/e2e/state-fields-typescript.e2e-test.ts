import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

describe('E2E-015a TypeScript computed and internal fields', () => {
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

  it('returns the computed field while keeping the internal field out of public state', async () => {
    const response = await requestThroughSpecmatic(app.stubUrl, 'POST', '/order-items', {
      description: 'computed',
      quantity: 4,
      unitPrice: 5,
    });
    expect(response.status).toBe(201);
    expect((response.body as JsonObject).lineTotal).toBe(20);
    expect((response.body as JsonObject).internalCode).toBeUndefined();
    const state = (await fetch(`${app.engineUrl}/_admin/state`).then((value) => value.json())) as {
      entities: Record<string, JsonObject>;
    };
    const entity = Object.values(state.entities).find(
      (value) => value['description'] === 'computed',
    );
    expect(entity?.internalCode).toBe('private');
  }, 60_000);
});
