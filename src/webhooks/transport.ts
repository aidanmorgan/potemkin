/**
 * Default webhook transport — a thin adapter over the global `fetch` that
 * satisfies the injectable `FetchLike` contract used by `deliverWebhook`.
 *
 * Boot wires this onto the BootedSystem so production dispatch performs real
 * HTTP POSTs; tests inject a fake `FetchLike` instead so deliveries can be
 * asserted without a network. The adapter never throws for a non-2xx response —
 * it reports `ok`/`status` so the retry loop in `deliverWebhook` decides.
 */

import type { FetchLike } from './dispatcher.js';

/**
 * Build a `FetchLike` backed by the global `fetch`. Falls back to a transport
 * that reports failure (never throws) when no global fetch is available, so the
 * engine boots in environments without fetch and dispatch degrades gracefully.
 */
export function createFetchWebhookTransport(): FetchLike {
  const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof globalFetch !== 'function') {
    return async () => ({ ok: false, status: 0 });
  }
  return async (url, init) => {
    const res = await globalFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    return { ok: res.ok, status: res.status };
  };
}
