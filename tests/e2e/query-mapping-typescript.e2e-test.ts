import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';

describe('E2E-013 TypeScript query mapping', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: 'query-policy',
      potemkinConfigPath: path.resolve('tests/fixtures/query-policy/potemkin-typescript.yml'),
      warmupPath: '/probes/missing',
      warmupExpectedStatus: 404,
    });
  }, 180_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('returns only mapped matches and an empty result for a miss', async () => {
    const match = await requestThroughSpecmatic(
      app.stubUrl,
      'GET',
      '/orders',
      null,
      {},
      { threshold: '3' },
    );
    const miss = await requestThroughSpecmatic(
      app.stubUrl,
      'GET',
      '/orders',
      null,
      {},
      { threshold: '99' },
    );
    expect(match.status).toBe(200);
    expect((match.body as { items: unknown[] }).items.length).toBeGreaterThan(0);
    expect(miss.status).toBe(200);
    expect((miss.body as { items: unknown[] }).items).toHaveLength(0);
  }, 60_000);
});
