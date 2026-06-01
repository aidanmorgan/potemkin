/**
 * The engine notifies the Specmatic plugin via outbound HTTP POSTs when it becomes
 * ready and when it is about to stop, so the plugin can react immediately rather
 * than waiting for a health-probe cycle.
 */

export interface PluginControlConfig {
  /** Base URL of the plugin's control server, e.g. http://localhost:9090 */
  readonly url: string;
  /** Per-request timeout in ms. Default: 2000. */
  readonly timeoutMs?: number;
  /** Total retry attempts including the first. Default: 3. */
  readonly retries?: number;
  /** Initial backoff delay in ms. Default: 50. */
  readonly minBackoffMs?: number;
  /** Maximum backoff cap in ms. Default: 800. */
  readonly maxBackoffMs?: number;
  /** Exponential backoff factor. Default: 4. */
  readonly factor?: number;
}

export interface ReadyNotification {
  /** Engine identifier, always 'potemkin-stateful'. */
  readonly engine: string;
  /** Package version from package.json. */
  readonly version: string;
  /** ISO timestamp of when the engine finished booting. */
  readonly startedAt: string;
  /** Sorted list of contract paths owned by this engine. */
  readonly contractPaths: readonly string[];
  /** SHA-256 checksum matching /_engine/routes ETag. */
  readonly routesChecksum: string;
  /** SHA-256 checksum matching /_engine/fixtures ETag. */
  readonly fixturesChecksum: string;
}

export interface ShutdownNotification {
  /** Engine identifier, always 'potemkin-stateful'. */
  readonly engine: string;
  /** Package version from package.json. */
  readonly version: string;
  /** Signal or manual reason for shutdown. */
  readonly reason: 'SIGTERM' | 'SIGINT' | 'manual';
  /** ISO timestamp of when shutdown was initiated. */
  readonly stoppedAt: string;
}

export type NotifyResult =
  | { readonly ok: true; readonly attempts: number; readonly durationMs: number }
  | { readonly ok: false; readonly attempts: number; readonly durationMs: number; readonly error: string };

export interface PluginControlClient {
  notifyReady(payload: ReadyNotification): Promise<NotifyResult>;
  notifyShutdown(payload: ShutdownNotification): Promise<NotifyResult>;
}
