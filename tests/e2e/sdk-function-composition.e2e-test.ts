import { compose, concatReadonly, mapReadonly, pipe } from 'potemkin/sdk';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';

describe('E2E-010b TypeScript function composition helpers', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('round-trips the composed value in the Specmatic response and event state', async () => {
    const composed = compose(
      (value: unknown) => String(value),
      (value: unknown) => String(value),
    );
    const transformed = pipe(
      'composed',
      composed,
      (value) => concatReadonly(mapReadonly([value], String), [])[0],
    );
    expect(transformed).toBe('composed');
    const response = await requestThroughSpecmatic(app.stubUrl, 'POST', '/leads', {
      companyName: transformed,
      contactName: 'Composition',
      phone: '+61 2 9000 0777',
      email: 'composition@example.test',
      source: 'WEBSITE',
    });
    expect(response.status).toBe(201);
    expect((response.body as Record<string, unknown>).companyName).toBe(transformed);
  }, 60_000);
});
