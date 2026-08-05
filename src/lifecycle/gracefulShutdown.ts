/**
 * Graceful shutdown — wraps an http.Server with @godaddy/terminus.
 *
 * On SIGTERM / SIGINT the sequence is:
 *  1. `beforeShutdown` — optional delay for load-balancers to stop routing traffic.
 *  2. `onSignal`       — notify the plugin control server (500 ms budget so we don't block the drain).
 *  3. Terminus drains in-flight connections within `timeoutMs`.
 *  4. `onShutdown`     — log 'engine drained'.
 *
 * Terminus owns all signal handling — do not add custom signal listeners here.
 */

import { createTerminus } from '@godaddy/terminus';
import type { Server } from 'http';
import { childLogger } from '../observability/logger.js';
import type { Logger } from '../observability/logger.js';
import type { PluginControlClient, ShutdownNotification } from '../contracts/lifecycle.js';
import { ConfigurationError } from '../errors.js';
import { createLifecycleHelpers, runLifecyclePhase } from '../authoring/lifecycle.js';
import type { LifecycleDefinition, LifecycleDependencies } from '../contracts/lifecycle.js';

export interface GracefulShutdownConfig {
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
  /** Load-balancer drain delay before terminus begins shutdown. Default: 0. */
  readonly beforeShutdownDelayMs?: number;
  /** Signals to handle. Default: ['SIGTERM', 'SIGINT']. */
  readonly signals?: readonly NodeJS.Signals[];
  /** Optional health-check routes to register with terminus. */
  readonly healthChecks?: { readonly [path: string]: () => Promise<unknown> };
  readonly logger?: Logger;
  /** TypeScript lifecycle definition installed alongside the running system. */
  readonly lifecycle?: LifecycleDefinition;
  /** Runtime services used by the lifecycle definition. */
  readonly lifecycleDependencies?: LifecycleDependencies & { readonly nowMs: () => number };
  /** Reason exposed to the TypeScript shutdown hook when no plugin payload is supplied. */
  readonly shutdownReason?: string;
  /**
   * Optional hook invoked after connections have drained (inside onShutdown,
   * after the 'engine drained' log).  Use this to close any resources that
   * must outlive HTTP traffic — e.g. `await sys.tsWatcher?.stop()`.
   *
   * Errors thrown or rejected by this hook are caught, logged as warnings,
   * and do NOT abort the shutdown sequence.
   */
  readonly afterDrain?: () => void | Promise<void>;
}

/**
 * Install graceful shutdown handling on the given server using @godaddy/terminus.
 * Call this once after `server.listen(...)` has been invoked.
 */
export function installGracefulShutdown(config: GracefulShutdownConfig): void {
  if (config.lifecycle !== undefined && config.lifecycleDependencies === undefined) {
    throw new ConfigurationError(
      'GracefulShutdownConfig.lifecycleDependencies is required with lifecycle',
      { field: 'lifecycleDependencies' },
    );
  }
  const log = config.logger
    ? childLogger(config.logger, { name: 'lifecycle.shutdown' })
    : undefined;

  const timeoutMs = config.timeoutMs ?? 10_000;
  const signals = (config.signals ?? ['SIGTERM', 'SIGINT']) as NodeJS.Signals[];

  // Give load-balancers a chance to drain before stopping connections. The
  // composition root owns environment parsing; this lifecycle module receives
  // the already-typed policy explicitly.
  const beforeShutdownDelayMs = config.beforeShutdownDelayMs ?? 0;
  if (!Number.isFinite(beforeShutdownDelayMs) || beforeShutdownDelayMs < 0) {
    throw new ConfigurationError('beforeShutdownDelayMs must be a finite non-negative number', {
      field: 'beforeShutdownDelayMs',
    });
  }

  createTerminus(config.server, {
    signals,
    timeout: timeoutMs,
    useExit0: true,

    healthChecks: config.healthChecks ? { ...config.healthChecks } : {},

    beforeShutdown(): Promise<void> {
      if (beforeShutdownDelayMs <= 0) return Promise.resolve();
      log?.info(
        { delayMs: beforeShutdownDelayMs },
        'lifecycle.shutdown: waiting for load-balancer drain',
      );
      return new Promise((resolve) => setTimeout(resolve, beforeShutdownDelayMs));
    },

    async onSignal(): Promise<void> {
      log?.info('lifecycle.shutdown: signal received — notifying plugin');

      if (config.pluginControl && config.shutdownPayload) {
        try {
          const payload = config.shutdownPayload();
          const result = await config.pluginControl.notifyShutdown(payload);
          if (result.ok) {
            log?.info(
              { attempts: result.attempts, durationMs: result.durationMs },
              'lifecycle.shutdown: plugin notified',
            );
          } else {
            log?.warn(
              { attempts: result.attempts, error: result.error },
              'lifecycle.shutdown: plugin notification failed (non-fatal)',
            );
          }
        } catch (err) {
          // notifyShutdown never throws, but guard defensively so shutdown always proceeds.
          log?.warn({ err }, 'lifecycle.shutdown: unexpected error notifying plugin (non-fatal)');
        }
      }
    },

    async onShutdown(): Promise<void> {
      log?.info('lifecycle.shutdown: engine drained — process exiting');

      if (config.lifecycle) {
        await runLifecyclePhase(
          config.lifecycle,
          'shutdown',
          {
            reason: config.shutdownReason ?? 'signal',
            helpers: createLifecycleHelpers(config.lifecycleDependencies!),
          },
          {
            failure: 'continue',
            nowMs: config.lifecycleDependencies!.nowMs,
            logger: log,
            onError: (err, hookName, phase) => {
              log?.warn(
                { err, hookName, phase },
                'lifecycle.shutdown: TypeScript hook failed (non-fatal)',
              );
            },
          },
        );
      }

      if (config.afterDrain) {
        try {
          await config.afterDrain();
        } catch (err) {
          log?.warn({ err }, 'lifecycle.shutdown: afterDrain hook failed (non-fatal)');
        }
      }
    },
  });
}
