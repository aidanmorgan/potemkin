import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import { getEventCount, getEntityCount } from './_harness/crm-e2e-helpers';

describe('E2E-002 TypeScript CORS preflight', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: 'authoring-parity',
      potemkinConfigPath: path.resolve('tests/fixtures/authoring-parity/potemkin-typescript.yml'),
      warmupPath: '/orders/not-created',
      warmupExpectedStatus: 404,
    });
  }, 120_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('serves CORS headers from the TypeScript-loaded runtime and changes no state', async () => {
    const before = [await getEventCount(app.engineUrl), await getEntityCount(app.engineUrl)];
    const response = await requestThroughSpecmatic(app.stubUrl, 'OPTIONS', '/orders', null, {
      Origin: 'https://client.example',
      'Access-Control-Request-Method': 'POST',
    });
    expect([200, 204]).toContain(response.status);
    expect(response.headers['access-control-allow-origin']).toBe('https://client.example');
    expect(response.headers['access-control-allow-methods']).toContain('OPTIONS');
    expect([await getEventCount(app.engineUrl), await getEntityCount(app.engineUrl)]).toEqual(
      before,
    );
  }, 60_000);
});
