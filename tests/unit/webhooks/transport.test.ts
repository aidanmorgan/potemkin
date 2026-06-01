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
});
