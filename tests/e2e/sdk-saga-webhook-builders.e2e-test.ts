import * as http from 'node:http';
import * as path from 'node:path';
import { defineSaga, defineWebhook } from 'potemkin/sdk';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';
import { getAllEvents } from './_harness/crm-e2e-helpers';

describe('E2E-012c TypeScript saga and webhook builders', () => {
  let app: E2eApp;
  let receiver: http.Server;
  const bodies: string[] = [];
  beforeAll(async () => {
    receiver = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        bodies.push(body);
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      receiver.listen(19878, '127.0.0.1', resolve);
      receiver.once('error', reject);
    });
    app = await startE2eApp({
      fixtureName: 'authoring-parity',
      potemkinConfigPath: path.resolve('tests/fixtures/authoring-parity/potemkin-typescript.yml'),
      warmupPath: '/orders/not-created',
      warmupExpectedStatus: 404,
    });
  }, 180_000);
  afterAll(async () => {
    await app?.shutdown();
    await new Promise<void>((resolve) => receiver?.close(() => resolve()));
  }, 30_000);

  it('observes the authored saga lifecycle and webhook payload', async () => {
    const saga = defineSaga({
      name: 'CoverageSaga' as never,
      trigger: { boundary: 'Order' as never, intent: 'creation' },
      steps: [],
    });
    const webhook = defineWebhook({
      name: 'CoverageWebhook' as never,
      trigger: () => true,
      url: 'http://127.0.0.1:19878/order-hook',
    });
    expect([saga, webhook]).toHaveLength(2);
    const response = await requestThroughSpecmatic(app.stubUrl, 'POST', '/orders', {
      id: 'saga-order',
      name: 'saga',
      quantity: 1,
      internalNote: 'private',
    });
    expect(response.status).toBe(201);
    expect(await getAllEvents(app.engineUrl)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'SagaCompleted' }),
        expect.objectContaining({ type: 'ReceiptCreated' }),
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bodies.join('\n')).toContain('saga-order');
  }, 60_000);
});
