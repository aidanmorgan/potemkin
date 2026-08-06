import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic, emptyBody } from './_harness/e2e-coverage-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

describe('E2E-004b TypeScript conditional reads', () => {
  let app: E2eApp;
  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('honours matching ETag and date conditions and returns normal data when stale', async () => {
    const created = await requestThroughSpecmatic(app.stubUrl, 'POST', '/leads', {
      companyName: 'TS conditions',
      contactName: 'Reader',
      phone: '+61 2 9000 0999',
      email: 'conditions@example.test',
      source: 'WEBSITE',
    });
    const id = String((created.body as JsonObject).id);
    const initial = await requestThroughSpecmatic(app.stubUrl, 'GET', `/leads/${id}`);
    const etag = initial.headers.etag!;
    const modified = new Date(Date.parse(initial.headers['last-modified']!) + 1000).toUTCString();
    const byTag = await requestThroughSpecmatic(app.stubUrl, 'GET', `/leads/${id}`, null, {
      'if-none-match': etag,
    });
    const byDate = await requestThroughSpecmatic(app.stubUrl, 'GET', `/leads/${id}`, null, {
      'if-modified-since': modified,
    });
    const stale = await requestThroughSpecmatic(app.stubUrl, 'GET', `/leads/${id}`, null, {
      'if-none-match': '"stale"',
    });
    expect(byTag.status).toBe(304);
    expect(byDate.status).toBe(304);
    expect(emptyBody(byTag.body)).toBe(true);
    expect(emptyBody(byDate.body)).toBe(true);
    expect(stale.status).toBe(200);
  }, 60_000);
});
