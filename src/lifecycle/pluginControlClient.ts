/**
 * Plugin control client — outbound HTTP notifications to the Specmatic plugin.
 *
 * Uses `async-retry` for exponential-backoff retries and the built-in Node 18+
 * `fetch` with `AbortSignal.timeout` for per-request deadlines.
 *
 * The public API never throws — all errors are captured and returned as
 * `{ ok: false, ... }` results so that callers can always rely on a result
 * object regardless of network failures.
 */

import retry from 'async-retry';
import { childLogger } from '../observability/logger.js';
import type { Logger } from '../observability/logger.js';
import type {
  PluginControlConfig,
  PluginControlClient,
  ReadyNotification,
  ShutdownNotification,
  NotifyResult,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_RETRIES = 3;
const DEFAULT_MIN_BACKOFF_MS = 50;
const DEFAULT_MAX_BACKOFF_MS = 800;
const DEFAULT_FACTOR = 4;

// Shutdown notifications use a tight budget — process is racing towards exit.
const SHUTDOWN_TIMEOUT_MS = 500;
const SHUTDOWN_RETRIES = 1;

/**
 * POST a JSON payload to the given URL.
 * Throws on non-2xx responses so async-retry will retry them.
 */
async function postJson(url: string, payload: unknown, timeoutMs: number): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  }
}

export function createPluginControlClient(
  config: PluginControlConfig & { readonly logger?: Logger },
): PluginControlClient {
  const baseUrl = config.url.replace(/\/$/, '');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = (config.retries ?? DEFAULT_RETRIES) - 1; // async-retry counts retries, not total attempts
  const minBackoffMs = config.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
  const maxBackoffMs = config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const factor = config.factor ?? DEFAULT_FACTOR;

  const log = config.logger
    ? childLogger(config.logger, { name: 'lifecycle.client' })
    : undefined;

  async function notify(
    path: string,
    payload: ReadyNotification | ShutdownNotification,
    overrideTimeoutMs?: number,
    overrideRetries?: number,
  ): Promise<NotifyResult> {
    const url = `${baseUrl}${path}`;
    const effectiveTimeout = overrideTimeoutMs ?? timeoutMs;
    const effectiveRetries = overrideRetries !== undefined ? overrideRetries - 1 : retries;

    const startMs = Date.now();
    let attempts = 0;

    try {
      await retry(
        async (_bail, attemptNumber) => {
          attempts = attemptNumber;
          log?.debug({ url, attempt: attemptNumber }, 'lifecycle.client: attempting notification');
          await postJson(url, payload, effectiveTimeout);
        },
        {
          retries: effectiveRetries,
          minTimeout: minBackoffMs,
          maxTimeout: maxBackoffMs,
          factor,
          onRetry: (err: Error, attempt: number) => {
            log?.warn({ url, attempt, err: err.message }, 'lifecycle.client: retrying after error');
          },
        },
      );

      const durationMs = Date.now() - startMs;
      log?.info({ url, attempts, durationMs }, 'lifecycle.client: notification succeeded');
      return { ok: true, attempts, durationMs };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const error = err instanceof Error ? err.message : String(err);
      log?.warn({ url, attempts, durationMs, error }, 'lifecycle.client: notification failed');
      return { ok: false, attempts, durationMs, error };
    }
  }

  return {
    notifyReady(payload: ReadyNotification): Promise<NotifyResult> {
      return notify('/ready', payload);
    },

    notifyShutdown(payload: ShutdownNotification): Promise<NotifyResult> {
      return notify('/shutdown', payload, SHUTDOWN_TIMEOUT_MS, SHUTDOWN_RETRIES);
    },
  };
}
