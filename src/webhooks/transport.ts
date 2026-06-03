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

/** Default per-delivery HTTP timeout in milliseconds. */
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Build a `FetchLike` backed by the global `fetch`. Throws at construction time
 * when no global fetch is available so the missing dependency is surfaced loudly
 * rather than silently manufacturing permanent delivery failures.
 *
 * @param deliveryTimeoutMs  Per-attempt HTTP timeout in ms (default 10 000).
 *                           Each fetch is wrapped in `AbortSignal.timeout` so a
 *                           hung endpoint does not hold a connection open beyond
 *                           this window.
 */
export function createFetchWebhookTransport(
  deliveryTimeoutMs: number = DEFAULT_DELIVERY_TIMEOUT_MS,
): FetchLike {
  const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof globalFetch !== 'function') {
    throw new Error(
      'createFetchWebhookTransport: globalThis.fetch is not available. ' +
        'Upgrade to Node 18+ or supply a custom webhookTransport to bootEngine().',
    );
  }
  return async (url, init) => {
    const res = await globalFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(deliveryTimeoutMs),
    });
    return { ok: res.ok, status: res.status };
  };
}
