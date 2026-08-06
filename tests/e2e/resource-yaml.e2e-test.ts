import { startExampleStack, type ExampleStack } from '../../src/conformance/exampleStack';
import { getEventCount } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

describe('E2E-006 YAML resource expansion', () => {
  let app: ExampleStack;
  beforeAll(async () => {
    app = await startExampleStack({ exampleName: 'stripe' });
  }, 180_000);
  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('creates a YAML resource item and reads it through its expanded route', async () => {
    const before = await getEventCount(app.engineUrl);
    const createResponse = await fetch(`${app.stubUrl}/v1/payment_intents`, {
      method: 'POST',
      headers: {
        connection: 'close',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ amount: '1250', currency: 'aud' }),
    });
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as JsonObject;
    const id = String(created.id);
    expect(id).toMatch(/^pi_/);
    expect(await getEventCount(app.engineUrl)).toBeGreaterThan(before);

    const readResponse = await fetch(`${app.stubUrl}/v1/payment_intents/${id}`, {
      headers: { connection: 'close' },
    });
    expect(readResponse.status).toBe(200);
    expect(((await readResponse.json()) as JsonObject).id).toBe(id);
  }, 60_000);
});
