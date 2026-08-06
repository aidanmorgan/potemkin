import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

describe('E2E-004c TypeScript HEAD requests', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('matches GET status and validators while returning no HEAD body', async () => {
    const created = await requestThroughSpecmatic(app.stubUrl, 'POST', '/leads', {
      companyName: 'TS head',
      contactName: 'Reader',
      phone: '+61 2 9000 0988',
      email: 'head@example.test',
      source: 'WEBSITE',
    });
    const id = String((created.body as JsonObject).id);
    const get = await requestThroughSpecmatic(app.stubUrl, 'GET', `/leads/${id}`);
    const head = await requestThroughSpecmatic(app.stubUrl, 'HEAD', `/leads/${id}`);
    expect(head.status).toBe(get.status);
    expect(head.body === null || head.body === '').toBe(true);
    expect(head.headers.etag).toBe(get.headers.etag);
    const conditional = await requestThroughSpecmatic(app.stubUrl, 'HEAD', `/leads/${id}`, null, {
      'if-none-match': get.headers.etag!,
    });
    expect(conditional.status).toBe(304);
  }, 60_000);
});
