import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import { getEventCount } from './_harness/crm-e2e-helpers';

describe('E2E-017 TypeScript control defaults', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp({
      potemkinConfigPath: path.resolve(
        'tests/fixtures/configured-stack/potemkin-control-defaults-typescript.yml',
      ),
      warmupPath: '/widgets/not-created',
      warmupExpectedStatus: 404,
    });
  }, 180_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('applies a TypeScript default control and permits a request-local override', async () => {
    const before = await getEventCount(app.engineUrl);
    const defaulted = await requestThroughSpecmatic(app.stubUrl, 'POST', '/widgets', {
      name: 'default-control',
    });
    expect(defaulted.status).toBe(201);
    expect(await getEventCount(app.engineUrl)).toBe(before);
    const overridden = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/widgets',
      { name: 'override-control' },
      { 'x-potemkin-dry-run': 'false' },
    );
    expect(overridden.status).toBe(201);
    expect(await getEventCount(app.engineUrl)).toBeGreaterThan(before);
    const reset = await fetch(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
    expect([200, 204]).toContain(reset.status);
  }, 60_000);
});
