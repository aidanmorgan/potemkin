import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

describe('E2E-009 mixed YAML and TypeScript component composition', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp({
      potemkinConfigPath: path.resolve('tests/fixtures/configured-stack/potemkin-mixed.yml'),
      warmupPath: '/things/not-created',
      warmupExpectedStatus: 404,
    });
  }, 180_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('combines a YAML boundary and a TypeScript boundary in one Specmatic flow', async () => {
    const created = await requestThroughSpecmatic(app.stubUrl, 'POST', '/things', {
      name: 'mixed-component',
    });
    expect(created.status).toBe(201);
    const body = created.body as JsonObject;
    const widget = await requestThroughSpecmatic(
      app.stubUrl,
      'GET',
      `/widgets/${String(body.id)}-widget`,
    );
    expect(widget.status).toBe(200);
    expect(widget.body).toEqual({
      id: `${String(body.id)}-widget`,
      name: 'mixed-component',
      source: 'typescript',
    });
  }, 60_000);
});
