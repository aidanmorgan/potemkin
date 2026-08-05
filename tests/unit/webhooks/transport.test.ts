import {
  createRuntimeWebhookTransport,
  RuntimeWebhookDeliveryError,
} from '../../../src/webhooks/transport.js';

describe('runtime webhook transport', () => {
  it('uses only the injected fetch and timeout dependencies', async () => {
    const signal = new AbortController().signal;
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 204,
    } as Response) as unknown as typeof globalThis.fetch;
    const timeoutSignal = jest.fn().mockReturnValue(signal) as unknown as (
      milliseconds: number,
    ) => AbortSignal;
    const transport = createRuntimeWebhookTransport({
      fetch,
      timeoutSignal,
      deliveryTimeoutMs: 1_250,
    });

    await transport.deliver({
      url: 'https://receiver.test/events',
      body: '{"kind":"created"}',
      headers: { 'content-type': 'application/json' },
      attempts: 1,
    });

    expect(timeoutSignal).toHaveBeenCalledWith(1_250);
    expect(fetch).toHaveBeenCalledWith('https://receiver.test/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"kind":"created"}',
      signal,
    });
  });

  it('returns a typed error for a non-success response', async () => {
    const transport = createRuntimeWebhookTransport({
      fetch: jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
      } as Response) as unknown as typeof globalThis.fetch,
      timeoutSignal: () => new AbortController().signal,
    });

    const failure = await transport
      .deliver({
        url: 'https://receiver.test/events',
        body: '{}',
        headers: {},
        attempts: 1,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeWebhookDeliveryError);
    expect(failure).toMatchObject({
      code: 'WEBHOOK_DELIVERY_FAILED',
      status: 503,
      url: 'https://receiver.test/events',
    });
  });

  it('propagates an injected timeout signal to a hung endpoint', async () => {
    const fetch = ((_url: string | URL, init?: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;
    const transport = createRuntimeWebhookTransport({
      fetch,
      timeoutSignal: (milliseconds) => AbortSignal.timeout(milliseconds),
      deliveryTimeoutMs: 25,
    });

    await expect(
      transport.deliver({
        url: 'https://receiver.test/hung',
        body: '{}',
        headers: {},
        attempts: 1,
      }),
    ).rejects.toBeDefined();
  }, 1_000);
});
