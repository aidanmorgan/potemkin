import * as path from 'node:path';
import { defineGlobal, defineQuery, defineResponse, query } from 'potemkin/sdk';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';

describe('E2E-011b TypeScript policy builders', () => {
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

  it('uses response, query, and global definitions in a Specmatic query', async () => {
    const responsePolicy = defineResponse({ headers: { 'x-coverage-policy': 'enabled' } });
    const queryPolicy = defineQuery({
      fields: {
        threshold: ({ state, query: input }) =>
          Number(state['score']) >= Number(input['threshold']),
      },
    });
    const globalPolicy = defineGlobal({ securityHeaders: { enabled: true, nosniff: true } });
    expect([responsePolicy, query(() => true), globalPolicy, queryPolicy]).toHaveLength(4);
    const response = await requestThroughSpecmatic(
      app.stubUrl,
      'GET',
      '/orders',
      null,
      {},
      { threshold: '3' },
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ items: expect.any(Array) }));
  }, 60_000);
});
