import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import { getEventCount, getEntityCount } from './_harness/crm-e2e-helpers';

describe('E2E-001 YAML CORS preflight', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('returns the preflight policy without mutating the YAML runtime', async () => {
    const before = [await getEventCount(app.engineUrl), await getEntityCount(app.engineUrl)];
    const response = await requestThroughSpecmatic(app.stubUrl, 'OPTIONS', '/leads', null, {
      Origin: 'https://client.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type, x-potemkin-trace-id',
    });
    expect([200, 204]).toContain(response.status);
    expect(response.headers['access-control-allow-origin']).toBe('https://client.example');
    expect(response.headers['access-control-allow-methods']).toContain('OPTIONS');
    expect(response.headers['access-control-allow-headers']).toBeDefined();
    expect([await getEventCount(app.engineUrl), await getEntityCount(app.engineUrl)]).toEqual(
      before,
    );
  }, 60_000);
});
