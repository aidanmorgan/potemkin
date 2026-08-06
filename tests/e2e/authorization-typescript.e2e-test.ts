import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import { getEventCount } from './_harness/crm-e2e-helpers';

describe('E2E-018 TypeScript custom authorization callback', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: 'audit-fields',
      potemkinConfigPath: path.resolve(
        'tests/fixtures/audit-fields/potemkin-authorization-typescript.yml',
      ),
      warmupPath: '/notes/missing',
      warmupExpectedStatus: 404,
    });
  }, 120_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('allows the configured scope and denies a missing scope without state change', async () => {
    const allowed = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/notes',
      { title: 'allowed', body: 'ok' },
      { authorization: 'Bearer writer:writer' },
    );
    expect(allowed.status).toBe(201);
    const before = await getEventCount(app.engineUrl);
    const denied = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/notes',
      { title: 'denied', body: 'no' },
      { authorization: 'Bearer reader:reader' },
    );
    expect([401, 403]).toContain(denied.status);
    expect(await getEventCount(app.engineUrl)).toBe(before);
  }, 60_000);
});
