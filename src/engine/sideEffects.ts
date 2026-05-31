/**
 * Deferred post-commit side-effects (sagas + webhooks).
 *
 * The Unit of Work normally dispatches sagas and webhooks immediately after it
 * commits, fire-and-forget. Under a bulk-transactional batch this is unsafe: an
 * earlier item's saga/webhook would already be running (and could append events)
 * by the time a later item aborts and the gateway rolls the stores back, leaving
 * orphaned side-effect events and breaking all-or-nothing semantics.
 *
 * A SideEffectQueue lets the gateway collect each item's post-commit side-effects
 * instead of letting the UoW fire them. The queue is flushed (all thunks run)
 * only after the WHOLE batch commits, or discarded entirely on abort.
 *
 * Each thunk is fire-and-forget: it returns a Promise that is `.catch`'d by the
 * flusher so a side-effect failure never rejects the flush nor fails the request.
 */

import type { Logger } from '../observability/logger.js';

/** A single deferred post-commit side-effect (a saga run or a webhook delivery). */
export type SideEffectThunk = () => Promise<unknown>;

/**
 * Collects deferred post-commit side-effects for a bulk-transactional batch.
 * When supplied to a UoW, the UoW enqueues its side-effects here instead of
 * dispatching them inline.
 */
export interface SideEffectQueue {
  /** Enqueue a deferred side-effect thunk. */
  enqueue(thunk: SideEffectThunk): void;
  /** Number of queued thunks (used by tests/diagnostics). */
  size(): number;
  /**
   * Fire every queued thunk, fire-and-forget. Each thunk's rejection is caught
   * and logged so a failing side-effect never rejects the flush. Clears the queue.
   */
  flush(logger?: Logger): void;
  /** Discard all queued thunks without running them (batch aborted). */
  discard(): void;
}

export function createSideEffectQueue(): SideEffectQueue {
  const thunks: SideEffectThunk[] = [];
  return {
    enqueue(thunk: SideEffectThunk): void {
      thunks.push(thunk);
    },
    size(): number {
      return thunks.length;
    },
    flush(logger?: Logger): void {
      const pending = thunks.splice(0, thunks.length);
      for (const thunk of pending) {
        thunk().catch((err: unknown) => {
          logger?.error({ err }, 'Deferred side-effect failed');
        });
      }
    },
    discard(): void {
      thunks.length = 0;
    },
  };
}
