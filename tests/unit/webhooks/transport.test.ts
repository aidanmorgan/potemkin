/**
 * Unit tests for the webhook fetch transport factory.
 */

import { createFetchWebhookTransport } from '../../../src/webhooks/transport';

describe('webhooks/transport — createFetchWebhookTransport', () => {
  it('throws a descriptive error when globalThis.fetch is absent', () => {
    const original = (globalThis as Record<string, unknown>)['fetch'];
    try {
      delete (globalThis as Record<string, unknown>)['fetch'];
      expect(() => createFetchWebhookTransport()).toThrow(
        'createFetchWebhookTransport: globalThis.fetch is not available',
      );
    } finally {
      if (original !== undefined) {
        (globalThis as Record<string, unknown>)['fetch'] = original;
      }
    }
  });

  it('returns a FetchLike when globalThis.fetch is present', () => {
    if (typeof (globalThis as Record<string, unknown>)['fetch'] !== 'function') {
      // Environment has no fetch — skip the positive path test.
      return;
    }
    const transport = createFetchWebhookTransport();
    expect(typeof transport).toBe('function');
  });

  it('aborts a hung endpoint within the configured deliveryTimeoutMs', async () => {
    const original = (globalThis as Record<string, unknown>)['fetch'];
    // Replace global fetch with a version that never resolves.
    (globalThis as Record<string, unknown>)['fetch'] = (
      _url: string,
      init: { signal?: AbortSignal },
    ) =>
      new Promise<never>((_resolve, reject) => {
        // If the AbortSignal fires, reject with its reason so the transport throws.
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            reject(init.signal!.reason);
          });
        }
      });

    try {
      const transport = createFetchWebhookTransport(50);
      const start = Date.now();
      await expect(
        transport('http://hung.test/webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
      ).rejects.toBeDefined();
      const elapsed = Date.now() - start;
      // The abort should fire well within 1 second (the timeout is 50 ms).
      expect(elapsed).toBeLessThan(1000);
    } finally {
      (globalThis as Record<string, unknown>)['fetch'] = original;
    }
  }, 5000);
});
