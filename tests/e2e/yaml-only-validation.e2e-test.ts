import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import { getEventCount } from './_harness/crm-e2e-helpers';

describe('E2E-022 YAML-only request validation', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp({ fixtureName: 'audit-fields' });
  }, 120_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('rejects an invalid YAML request before the valid request is committed', async () => {
    const before = await getEventCount(app.engineUrl);
    const invalid = await requestThroughSpecmatic(app.stubUrl, 'POST', '/notes', {
      title: 'missing body',
    });
    expect([400, 422]).toContain(invalid.status);
    expect(await getEventCount(app.engineUrl)).toBe(before);
    const valid = await requestThroughSpecmatic(app.stubUrl, 'POST', '/notes', {
      title: 'valid',
      body: 'body',
    });
    expect(valid.status).toBe(201);
  }, 60_000);
});
