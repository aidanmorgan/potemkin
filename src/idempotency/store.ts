/**
 * Idempotency Store
 *
 * Deduplicates commands within a configurable TTL window using a client-supplied
 * Idempotency-Key header (RFC 7240-style).
 *
 * Map key  = SHA-256( actorId + "\n" + method + "\n" + path + "\n" + idempotencyKey ).
 *            The resolved actor id is part of the key so a different actor cannot
 *            replay another actor's cached response (cross-actor cache poisoning).
 * keyHash  = SHA-256( actorId + method + path + idempotencyKey [+ body] )
 *            stored per-entry for collision detection.
 * - If the same (actor, method, path, key) is seen within the TTL and keyHash
 *   matches → return the cached response.
 * - If the same key is seen with a different body → 409 IDEMPOTENCY_KEY_CONFLICT.
 *
 * Concurrency (TOCTOU): `check` atomically RESERVES a pending slot on a miss so a
 * concurrent second request with the same key observes the in-flight reservation
 * and WAITS for it instead of executing a duplicate. The caller MUST resolve the
 * reservation by calling `record` (on success) or `release` (on error) so waiters
 * are unblocked.
 */

import { createHash } from 'node:crypto';
import type { JsonValue } from '../types.js';
import type { JournalEntry } from '../dsl/patches.js';
import { IdempotencyConflictError } from '../errors.js';

export interface IdempotencyEntry {
  readonly keyHash: string;            // full dedup hash (includes body when configured)
  readonly bodyHash: string;           // body-only hash for conflict detection
  readonly idempotencyKey: string;     // raw key from header
  readonly response: CachedResponse;
  readonly expiresAt: number;          // Date.now() ms
}

export interface CachedResponse {
  readonly status: number;
  readonly body: JsonValue;
  readonly headers?: Record<string, string>;
  /**
   * Response body patches (HATEOAS/_links + mask removes) carried in the
   * `_patches` envelope on the forwarding path. Recorded so an idempotent REPLAY
   * re-emits the same patches; otherwise the plugin would serialize the unmasked
   * base body on replay, leaking masked fields.
   */
  readonly patches?: readonly JournalEntry[];
}

/** Outcome of a check: a cached hit, a fresh miss (caller reserved the slot), or
 *  a wait on an in-flight request that holds the reservation. */
export type CheckResult =
  | { readonly kind: 'hit'; readonly response: CachedResponse }
  | { readonly kind: 'miss' }
  | { readonly kind: 'wait'; readonly wait: Promise<CachedResponse | null> };

export interface IdempotencyStore {
  /**
   * Check whether a request has been seen before.
   *
   * Returns:
   *  - `{ kind: 'hit', response }` if a matching completed entry exists (replay it).
   *  - `{ kind: 'miss' }` if this is a new request — a pending reservation has been
   *    placed for this key; the caller MUST eventually call `record` or `release`.
   *  - `{ kind: 'wait', wait }` if another request currently holds the reservation;
   *    await `wait` for its response (or `null` if it released without recording).
   *
   * @throws {IdempotencyConflictError} (409) if the same key was used with a different body.
   */
  check(params: CheckParams): CheckResult;

  /**
   * Record a response for a request that was just executed, resolving any pending
   * reservation so concurrent waiters replay the same response.
   */
  record(params: RecordParams): void;

  /**
   * Release a pending reservation WITHOUT recording a response (e.g. the request
   * errored). Waiters are unblocked with `null` so they re-execute.
   */
  release(params: CheckParams): void;

  /** Drop all recorded entries (used by engine reset). */
  clear(): void;

  /** Return the number of non-expired entries currently held (for diagnostics/testing). */
  size(): number;
}

export interface CheckParams {
  readonly actorId: string;
  readonly method: string;
  readonly path: string;
  readonly idempotencyKey: string;
  readonly body: JsonValue;
  readonly hashIncludesBody: boolean;
}

export interface RecordParams extends CheckParams {
  readonly response: CachedResponse;
  readonly ttlMs: number;
}

export interface IdempotencyStoreOptions {
  /** Clock function returning current time in ms. Defaults to Date.now. */
  readonly nowMs?: () => number;
}

/** A pending reservation: an in-flight request holds the key until it records/releases. */
interface PendingReservation {
  readonly keyHash: string;
  readonly bodyHash: string;
  promise: Promise<CachedResponse | null>;
  resolve: (value: CachedResponse | null) => void;
}

/**
 * Create a new in-memory idempotency store.
 * Lazily cleans up expired entries on each `check` call.
 */
export function createIdempotencyStore(opts: IdempotencyStoreOptions = {}): IdempotencyStore {
  const _store = new Map<string, IdempotencyEntry>();
  const _pending = new Map<string, PendingReservation>();
  const now = opts.nowMs ?? Date.now;

  /** Map key: identity of the (actor, method, path, key) tuple. */
  function computeMapKey(actorId: string, method: string, path: string, idempotencyKey: string): string {
    return createHash('sha256')
      .update([actorId, method.toUpperCase(), path, idempotencyKey].join('\n'))
      .digest('hex');
  }

  function computeKeyHash(
    actorId: string,
    method: string,
    path: string,
    idempotencyKey: string,
    body: JsonValue,
    hashIncludesBody: boolean,
  ): string {
    const parts = [actorId, method.toUpperCase(), path, idempotencyKey];
    if (hashIncludesBody) {
      parts.push(JSON.stringify(body));
    }
    return createHash('sha256').update(parts.join('\n')).digest('hex');
  }

  function computeBodyHash(body: JsonValue): string {
    return createHash('sha256').update(JSON.stringify(body)).digest('hex');
  }

  function cleanup(): void {
    const current = now();
    for (const [k, entry] of _store) {
      if (entry.expiresAt <= current) {
        _store.delete(k);
      }
    }
  }

  /** Throw a 409 when the same key was reused with a different body / request. */
  function conflict(idempotencyKey: string, method: string, path: string, sameBody: boolean): never {
    throw new IdempotencyConflictError(
      sameBody
        ? `Idempotency key "${idempotencyKey}" was previously used for a different request`
        : `Idempotency key "${idempotencyKey}" was previously used with a different request body`,
      { idempotencyKey, method, path },
    );
  }

  return {
    check({ actorId, method, path, idempotencyKey, body, hashIncludesBody }): CheckResult {
      cleanup();

      const mapKey = computeMapKey(actorId, method, path, idempotencyKey);
      const keyHash = computeKeyHash(actorId, method, path, idempotencyKey, body, hashIncludesBody);
      const bodyHash = computeBodyHash(body);

      const existing = _store.get(mapKey);
      if (existing && existing.expiresAt > now()) {
        if (existing.keyHash === keyHash) {
          return { kind: 'hit', response: existing.response };
        }
        // Same (actor, key) but different content → conflict.
        conflict(idempotencyKey, method, path, existing.bodyHash === bodyHash);
      }
      if (existing) _store.delete(mapKey);

      // A concurrent request already holds the reservation for this key.
      const pending = _pending.get(mapKey);
      if (pending) {
        if (pending.keyHash !== keyHash) {
          conflict(idempotencyKey, method, path, pending.bodyHash === bodyHash);
        }
        return { kind: 'wait', wait: pending.promise };
      }

      // Fresh request — reserve the slot so a concurrent second check waits.
      let resolveFn!: (value: CachedResponse | null) => void;
      const promise = new Promise<CachedResponse | null>((resolve) => {
        resolveFn = resolve;
      });
      _pending.set(mapKey, { keyHash, bodyHash, promise, resolve: resolveFn });
      return { kind: 'miss' };
    },

    record({ actorId, method, path, idempotencyKey, body, hashIncludesBody, response, ttlMs }) {
      cleanup();
      const mapKey = computeMapKey(actorId, method, path, idempotencyKey);
      const keyHash = computeKeyHash(actorId, method, path, idempotencyKey, body, hashIncludesBody);
      const bodyHash = computeBodyHash(body);
      _store.set(mapKey, {
        keyHash,
        bodyHash,
        idempotencyKey,
        response,
        expiresAt: now() + ttlMs,
      });
      // Resolve and clear any pending reservation so concurrent waiters replay.
      const pending = _pending.get(mapKey);
      if (pending) {
        _pending.delete(mapKey);
        pending.resolve(response);
      }
    },

    release({ actorId, method, path, idempotencyKey }) {
      const mapKey = computeMapKey(actorId, method, path, idempotencyKey);
      const pending = _pending.get(mapKey);
      if (pending) {
        _pending.delete(mapKey);
        pending.resolve(null);
      }
    },

    clear() {
      _store.clear();
      // Unblock any waiters so they don't hang past a reset.
      for (const pending of _pending.values()) pending.resolve(null);
      _pending.clear();
    },

    size() {
      const current = now();
      let count = 0;
      for (const entry of _store.values()) {
        if (entry.expiresAt > current) count++;
      }
      return count;
    },
  };
}
