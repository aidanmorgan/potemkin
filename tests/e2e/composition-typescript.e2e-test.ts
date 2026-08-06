import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

describe('E2E-008 TypeScript component include and use', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: 'configured-stack',
      potemkinConfigPath: path.resolve(
        'tests/fixtures/configured-stack/potemkin-composition-typescript.yml',
      ),
      warmupPath: '/widgets/not-created',
      warmupExpectedStatus: 404,
    });
  }, 180_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('runs the reusable component mapping through the Specmatic contract', async () => {
    const response = await requestThroughSpecmatic(app.stubUrl, 'POST', '/widgets', {
      name: 'component',
    });
    expect(response.status).toBe(201);
    expect((response.body as JsonObject).source).toBe('typescript-component');
    expect((response.body as JsonObject).name).toBe('component');
  }, 60_000);
});
