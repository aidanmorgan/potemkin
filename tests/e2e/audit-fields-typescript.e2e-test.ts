import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

describe('E2E-014 TypeScript audit fields', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: 'audit-fields',
      potemkinConfigPath: path.resolve('tests/fixtures/audit-fields/potemkin-typescript.yml'),
      warmupPath: '/notes/missing',
      warmupExpectedStatus: 404,
    });
  }, 120_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('stamps creation and update actors on the TypeScript boundary', async () => {
    const headers = { authorization: 'Bearer creator:writer' };
    const created = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/notes',
      { title: 'audit', body: 'first' },
      headers,
    );
    const id = String((created.body as JsonObject).id);
    expect((created.body as JsonObject).updatedBy).toBe('creator');
    const updated = await requestThroughSpecmatic(
      app.stubUrl,
      'PATCH',
      `/notes/${id}`,
      { body: 'second' },
      { authorization: 'Bearer editor:writer' },
    );
    expect(updated.status).toBe(200);
    expect((updated.body as JsonObject).updatedBy).toBe('editor');
    expect((updated.body as JsonObject).updatedAt).toBeDefined();
  }, 60_000);
});
