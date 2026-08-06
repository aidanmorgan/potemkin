import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';

describe('E2E-020 programmatic TypeScript configuration', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp({
      potemkinConfigPath: path.resolve('tests/fixtures/configured-stack/potemkin-factory.yml'),
      warmupPath: '/widgets/not-created',
      warmupExpectedStatus: 404,
    });
  }, 180_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('boots the static TypeScript factory without a potemkin-typescript carrier', async () => {
    const response = await requestThroughSpecmatic(app.stubUrl, 'POST', '/widgets', {
      name: 'programmatic-factory',
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual(
      expect.objectContaining({ source: 'typescript', name: 'programmatic-factory' }),
    );
  }, 60_000);
});
