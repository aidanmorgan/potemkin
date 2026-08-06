import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';

describe('E2E-003 TypeScript API version routing', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp({ fixtureName: 'crm-versioned' });
  }, 120_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('routes a versioned and an unversioned request through the configured boundary', async () => {
    const versioned = await requestThroughSpecmatic(app.stubUrl, 'GET', '/v1/leads');
    const unversioned = await requestThroughSpecmatic(app.stubUrl, 'GET', '/leads');
    expect(versioned.status).toBe(200);
    expect(unversioned.status).toBe(200);
    expect(versioned.headers['x-potemkin-version']).toBe('v1');
    expect(unversioned.headers['x-potemkin-version']).toBe('v2');
    expect(Array.isArray(versioned.body)).toBe(true);
    expect(Array.isArray(unversioned.body)).toBe(true);
  }, 60_000);
});
