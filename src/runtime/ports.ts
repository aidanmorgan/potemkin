/**
 * Host-owned timer capabilities used by runtime components that need
 * background maintenance or delayed work.
 *
 * The runtime consumes this port; only the composition root decides whether
 * it is backed by Node timers, a test scheduler, or an embedding host's clock.
 */
export interface RuntimeTimerScheduler {
  readonly setInterval: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly unref?: (handle: unknown) => void;
}
