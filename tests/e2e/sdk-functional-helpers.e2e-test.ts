import * as path from 'node:path';
import { all, any, not } from 'potemkin/sdk';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';

describe('E2E-010a TypeScript predicate helpers', () => {
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

  it('uses all/any/not in the authored behavior decision and selects its event', async () => {
    const condition = all(
      () => true,
      any(
        () => false,
        not(() => false),
      ),
    );
    expect(condition({} as never)).toBe(true);
    const response = await requestThroughSpecmatic(app.stubUrl, 'POST', '/orders', {
      id: 'predicate-order',
      name: 'predicate',
      quantity: 1,
      internalNote: 'private',
    });
    expect(response.status).toBe(201);
    expect((response.body as Record<string, unknown>).status).toBe('CREATED');
  }, 60_000);
});
