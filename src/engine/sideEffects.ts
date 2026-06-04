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
 * Monotonic reset-epoch holder carried on the running system. resetSystem
 * increments `current`; post-commit side-effects capture the value in force when
 * they are scheduled and refuse to run once it has advanced (see withEpochGuard).
 * A mutable holder (not a bare number) so it can be shared by reference across
 * the system, the UoW, and any pending thunk.
 */
export interface ResetEpoch {
  current: number;
}

/** Create a fresh reset-epoch holder starting at 0 (boot time). */
export function createResetEpoch(): ResetEpoch {
  return { current: 0 };
}

/**
 * Wrap a post-commit side-effect so it NO-OPS if a reset has landed between the
 * moment it was scheduled and the moment it runs. The thunk captures the epoch
 * in force at scheduling time; when it executes it compares that against the
 * live epoch and, on a mismatch, returns without performing the side-effect
 * (which would otherwise append orphan events into the freshly-reset store).
 *
 * When no epoch holder is supplied (direct callers that never reset) the thunk
 * runs unconditionally, preserving existing behaviour.
 */
export function withEpochGuard(
  thunk: SideEffectThunk,
  epoch: ResetEpoch | undefined,
  logger?: Logger,
): SideEffectThunk {
  if (!epoch) return thunk;
  const scheduledEpoch = epoch.current;
  return async (): Promise<unknown> => {
    if (epoch.current !== scheduledEpoch) {
      logger?.debug(
        { scheduledEpoch, currentEpoch: epoch.current },
        'Post-commit side-effect suppressed: reset occurred after it was scheduled',
      );
      return undefined;
    }
    return thunk();
  };
}

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
