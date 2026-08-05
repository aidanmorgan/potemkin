import { createServer, type Server } from 'node:http';
import {
  createRealApiEndpoint,
  createRealApiEquivalenceRunner,
  type EquivalenceEndpoint,
} from '../../equivalence/realApi.js';
import type { EquivalenceObservation } from '../../equivalence/types.js';

describe('real API equivalence runner over a live HTTP server', () => {
  let server: Server;
  let baseUrl: string;
  const events: Array<{ id: string; type: string }> = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/orders') {
        let raw = '';
        request.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
        });
        request.on('end', () => {
          const body = JSON.parse(raw) as { name: string };
          events.push({ id: 'real-event-1', type: 'OrderCreated' });
          response.writeHead(201, { 'content-type': 'application/json', etag: 'v1' });
          response.end(JSON.stringify({ id: 'real-order-1', name: body.name }));
        });
        return;
      }
      if (request.method === 'GET' && request.url === '/orders/real-order-1') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'real-order-1', name: 'Ada' }));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Test server did not expose a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('runs a deterministic POST/GET sequence against a real HTTP endpoint', async () => {
    const real = createRealApiEndpoint({
      baseUrl,
      eventSource: async () => events.map((event) => ({ ...event })),
      quiesce: async () => undefined,
    });
    const model: EquivalenceEndpoint = {
      execute: async (_request, context): Promise<EquivalenceObservation> =>
        context.index === 0
          ? {
              status: 201,
              headers: { 'content-type': 'application/json', etag: 'v1' },
              body: { id: 'model-order-1', name: 'Ada' },
              events: [{ id: 'model-event-1', type: 'OrderCreated' }],
            }
          : {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: { id: 'model-order-1', name: 'Ada' },
              events: [{ id: 'model-event-1', type: 'OrderCreated' }],
            },
    };

    const result = await createRealApiEquivalenceRunner({
      model,
      real,
      policy: {
        ignoredHeaders: ['connection', 'date', 'keep-alive', 'transfer-encoding', 'content-length'],
      },
    }).run([
      { method: 'POST', path: '/orders', operation: 'create-order', body: { name: 'Ada' } },
      { method: 'GET', path: '/orders/real-order-1', operation: 'read-order' },
    ]);

    expect(result.conforms).toBe(true);
    expect(result.steps.map((step) => step.operation)).toEqual(['create-order', 'read-order']);
    expect(result.observations[0].real.body).toEqual({ id: 'real-order-1', name: 'Ada' });
  });
});
