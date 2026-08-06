import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

describe('E2E-004a TypeScript entity tags and last-modified dates', () => {
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

  it('returns an ETag tied to the sequence and an event update date', async () => {
    const created = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/notes',
      { title: 'TS tag', body: 'body' },
      { authorization: 'Bearer auditor:writer' },
    );
    expect(created.status).toBe(201);
    const id = String((created.body as JsonObject).id);
    const read = await requestThroughSpecmatic(app.stubUrl, 'GET', `/notes/${id}`);
    expect(read.status).toBe(200);
    expect(read.headers.etag).toMatch(/^"\d+"$/);
    expect(read.headers['last-modified']).toBeDefined();
    expect(Date.parse(read.headers['last-modified']!)).not.toBeNaN();
  }, 60_000);
});
