import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import { getEventCount } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

describe('E2E-007 TypeScript resource expansion', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: 'audit-fields',
      potemkinConfigPath: path.resolve(
        'tests/fixtures/audit-fields/potemkin-resource-typescript.yml',
      ),
      warmupPath: '/notes/missing',
      warmupExpectedStatus: 404,
    });
  }, 180_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('creates and reads a TypeScript-configured resource through Specmatic', async () => {
    const before = await getEventCount(app.engineUrl);
    const created = await requestThroughSpecmatic(app.stubUrl, 'POST', '/notes', {
      title: 'resource-ts',
      body: 'resource',
    });
    expect(created.status).toBe(201);
    const id = String((created.body as JsonObject).id);
    const read = await requestThroughSpecmatic(app.stubUrl, 'GET', `/notes/${id}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(created.body);
    expect(await getEventCount(app.engineUrl)).toBeGreaterThan(before);
  }, 60_000);
});
