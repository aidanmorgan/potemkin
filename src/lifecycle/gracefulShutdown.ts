/**
 * Graceful shutdown — wraps an http.Server with @godaddy/terminus.
 *
 * On SIGTERM / SIGINT the sequence is:
 *  1. `beforeShutdown` — optional delay for load-balancers to stop routing traffic.
 *  2. `onSignal`       — notify the plugin control server (fire-and-forget with a
 *                        fixed 500 ms budget so we don't block the drain).
 *  3. Terminus drains in-flight connections within `timeoutMs`.
 *  4. `onShutdown`     — log 'engine drained'.
 *
 * DO NOT add custom signal listeners here — terminus owns all signal handling.
 */

import { createTerminus } from '@godaddy/terminus';
import type { Server } from 'http';
import { childLogger } from '../observability/logger.js';
import type { Logger } from '../observability/logger.js';
import type { PluginControlClient, ShutdownNotification } from './types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GracefulShutdownConfig {
  /** The http.Server to wrap. */
  readonly server: Server;
  /** Optional plugin control client; when set, notifyShutdown is called on signal. */
  readonly pluginControl?: PluginControlClient;
  /**
   * Factory that builds the ShutdownNotification payload at signal time.
   * Called lazily so the `stoppedAt` timestamp is accurate.
   */
  readonly shutdownPayload?: () => ShutdownNotification;
  /** Total drain budget in ms. Default: 10_000. */
  readonly timeoutMs?: number;
  /** Signals to handle. Default: ['SIGTERM', 'SIGINT']. */
  readonly signals?: readonly NodeJS.Signals[];
  /** Optional health-check routes to register with terminus. */
  readonly healthChecks?: { readonly [path: string]: () => Promise<unknown> };
  /** Logger for lifecycle events. */
  readonly logger?: Logger;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Install graceful shutdown handling on the given server using @godaddy/terminus.
 * Call this once after `server.listen(...)` has been invoked.
 */
export function installGracefulShutdown(config: GracefulShutdownConfig): void {
  const log = config.logger
    ? childLogger(config.logger, { name: 'lifecycle.shutdown' })
    : undefined;

  const timeoutMs = config.timeoutMs ?? 10_000;
  const signals = (config.signals ?? ['SIGTERM', 'SIGINT']) as NodeJS.Signals[];

  // beforeShutdownDelayMs: give load-balancers a chance to drain before we
  // stop accepting connections.  Configurable via env; defaults to 0 (dev).
  const beforeShutdownDelayMs = (() => {
    const raw = process.env['BEFORE_SHUTDOWN_DELAY_MS'];
    if (raw !== undefined) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return 0;
  })();

  createTerminus(config.server, {
    signals,
    timeout: timeoutMs,
    useExit0: true,

    healthChecks: config.healthChecks ? { ...config.healthChecks } : {},

    /**
     * beforeShutdown: pause to allow upstream routers to stop sending traffic.
     * Returns immediately when delay is 0 (typical in dev / CI).
     */
    beforeShutdown(): Promise<void> {
      if (beforeShutdownDelayMs <= 0) return Promise.resolve();
      log?.info({ delayMs: beforeShutdownDelayMs }, 'lifecycle.shutdown: waiting for load-balancer drain');
      return new Promise((resolve) => setTimeout(resolve, beforeShutdownDelayMs));
    },

    /**
     * onSignal: called when terminus intercepts a signal.
     * We send the plugin control shutdown notification here with a hard 500 ms
     * budget and then resolve so terminus can proceed with connection draining.
     */
    async onSignal(): Promise<void> {
      log?.info('lifecycle.shutdown: signal received — notifying plugin');

      if (config.pluginControl && config.shutdownPayload) {
        try {
          const payload = config.shutdownPayload();
          const result = await config.pluginControl.notifyShutdown(payload);
          if (result.ok) {
            log?.info({ attempts: result.attempts, durationMs: result.durationMs }, 'lifecycle.shutdown: plugin notified');
          } else {
            log?.warn({ attempts: result.attempts, error: result.error }, 'lifecycle.shutdown: plugin notification failed (non-fatal)');
          }
        } catch (err) {
          // Should never reach here since notifyShutdown never throws,
          // but guard defensively so shutdown always proceeds.
          log?.warn({ err }, 'lifecycle.shutdown: unexpected error notifying plugin (non-fatal)');
        }
      }
    },

    /**
     * onShutdown: called after all connections have drained.
     */
    async onShutdown(): Promise<void> {
      log?.info('lifecycle.shutdown: engine drained — process exiting');
    },
  });
}
