import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

describe('E2E-005 TypeScript response links', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: 'authoring-parity',
      potemkinConfigPath: path.resolve(
        'tests/fixtures/authoring-parity/potemkin-hateoas-typescript.yml',
      ),
      warmupPath: '/orders/not-created',
      warmupExpectedStatus: 404,
    });
  }, 120_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('emits the TypeScript self link and does not emit a false conditional link', async () => {
    const response = await requestThroughSpecmatic(app.stubUrl, 'POST', '/orders', {
      id: 'ts-links',
      name: 'links',
      quantity: 1,
      internalNote: 'private',
    });
    expect(response.status).toBe(201);
    const links = (response.body as JsonObject)['_links'] as JsonObject;
    expect(links.self).toEqual(expect.objectContaining({ href: '/orders' }));
    expect(links.action).toEqual(expect.objectContaining({ href: '/orders' }));
    expect(links.create).toEqual(expect.objectContaining({ href: '/orders', method: 'POST' }));
    expect(links.hidden).toBeUndefined();
  }, 60_000);
});
