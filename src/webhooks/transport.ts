/**
 * Default webhook transport for the canonical RuntimeSystem. Tests inject
 * the runtime port instead, so delivery can be asserted without a network.
 */

import type { RuntimeWebhookTransport } from '../contracts/ports.js';

/** Default per-delivery HTTP timeout in milliseconds. */
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

export interface RuntimeWebhookTransportDependencies {
  /** HTTP request function supplied by the host composition root. */
  readonly fetch: typeof globalThis.fetch;
  /** Abort-signal factory supplied by the host composition root. */
  readonly timeoutSignal: (milliseconds: number) => AbortSignal;
}

export interface RuntimeWebhookTransportOptions extends RuntimeWebhookTransportDependencies {
  readonly deliveryTimeoutMs?: number;
}

export class RuntimeWebhookDeliveryError extends Error {
  readonly code = 'WEBHOOK_DELIVERY_FAILED' as const;

  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} from webhook endpoint ${url}`);
    this.name = 'RuntimeWebhookDeliveryError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Build the transport from host-supplied HTTP and timeout dependencies. */
export function createRuntimeWebhookTransport(
  options: RuntimeWebhookTransportOptions,
): RuntimeWebhookTransport {
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
  return {
    deliver: async ({ url, body, headers }) => {
      const response = await options.fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: options.timeoutSignal(deliveryTimeoutMs),
      });
      if (!response.ok) throw new RuntimeWebhookDeliveryError(response.status, url);
    },
  };
}
