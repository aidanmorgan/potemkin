import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';

describe('E2E-019 TypeScript lifecycle hooks', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: 'audit-fields',
      potemkinConfigPath: path.resolve(
        'tests/fixtures/audit-fields/potemkin-lifecycle-typescript.yml',
      ),
      warmupPath: '/notes/missing',
      warmupExpectedStatus: 404,
    });
  }, 120_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('runs boot, request, and reset hooks in the authored runtime', async () => {
    const response = await requestThroughSpecmatic(app.stubUrl, 'POST', '/notes', {
      title: 'lifecycle',
      body: 'hook',
    });
    expect(response.status).toBe(201);
    const reset = await fetch(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
    expect([200, 204]).toContain(reset.status);
    expect(reset.ok).toBe(true);
  }, 60_000);
});
