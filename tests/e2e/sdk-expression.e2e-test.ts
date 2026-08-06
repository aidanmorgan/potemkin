import { expression } from 'potemkin/sdk';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';

describe('E2E-010c TypeScript expression helper', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('evaluates the expression context before selecting the authored behavior', async () => {
    const marker = expression(
      'event',
      ({ command }: { readonly command: { readonly payload: Record<string, unknown> } }) =>
        String(command.payload['marker']),
    );
    expect(marker({ command: { payload: { marker: 'selected' } } } as never)).toBe('selected');
    const response = await requestThroughSpecmatic(app.stubUrl, 'POST', '/leads', {
      companyName: 'expression',
      contactName: 'Selected',
      phone: '+61 2 9000 0666',
      email: 'expression@example.test',
      source: 'WEBSITE',
    });
    expect(response.status).toBe(201);
  }, 60_000);
});
