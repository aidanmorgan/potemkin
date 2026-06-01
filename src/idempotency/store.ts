/**
 * Idempotency Store
 *
 * Deduplicates commands within a configurable TTL window using a client-supplied
 * Idempotency-Key header (RFC 7240-style).
 *
 * Hash key = SHA-256( method + "\n" + path + "\n" + idempotencyKey [+ "\n" + body] )
 * - If the same hash is seen within the TTL → return the cached response.
 * - If the same idempotencyKey is seen with a DIFFERENT body hash → 409 conflict.
 */

import { createHash } from 'node:crypto';
import type { JsonValue } from '../types.js';
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
}

export interface IdempotencyStore {
  /**
   * Check whether a request has been seen before.
   *
   * Returns:
   *  - `{ hit: true, response }` if a matching entry exists (replay it).
   *  - `{ hit: false }` if this is a new request.
   *
   * @throws {IdempotencyConflictError} (409) if the same key was used with a different body.
   */
  check(params: CheckParams): { hit: true; response: CachedResponse } | { hit: false };

  /**
   * Record a response for a request that was just executed.
   */
  record(params: RecordParams): void;

  /** Drop all recorded entries (used by engine reset). */
  clear(): void;

  /** Return the number of non-expired entries currently held (for diagnostics/testing). */
  size(): number;
}

export interface CheckParams {
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

/**
 * Create a new in-memory idempotency store.
 * Lazily cleans up expired entries on each `check` call.
 */
export function createIdempotencyStore(opts: IdempotencyStoreOptions = {}): IdempotencyStore {
  const _store = new Map<string, IdempotencyEntry>();
  const now = opts.nowMs ?? Date.now;

  function computeKeyHash(
    method: string,
    path: string,
    idempotencyKey: string,
    body: JsonValue,
    hashIncludesBody: boolean,
  ): string {
    const parts = [method.toUpperCase(), path, idempotencyKey];
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

  return {
    check({ method, path, idempotencyKey, body, hashIncludesBody }) {
      cleanup();

      const keyHash = computeKeyHash(method, path, idempotencyKey, body, hashIncludesBody);
      const existing = _store.get(idempotencyKey);

      if (!existing) return { hit: false };
      if (existing.expiresAt <= now()) {
        _store.delete(idempotencyKey);
        return { hit: false };
      }

      if (existing.keyHash === keyHash) {
        return { hit: true, response: existing.response };
      }

      // Same key, different content → conflict
      const newBodyHash = computeBodyHash(body);
      if (existing.bodyHash !== newBodyHash) {
        throw new IdempotencyConflictError(
          `Idempotency key "${idempotencyKey}" was previously used with a different request body`,
          { idempotencyKey, method, path },
        );
      }

      // Same body but different method/path → also conflict (key must be globally unique)
      throw new IdempotencyConflictError(
        `Idempotency key "${idempotencyKey}" was previously used for a different request`,
        { idempotencyKey, method, path },
      );
    },

    record({ method, path, idempotencyKey, body, hashIncludesBody, response, ttlMs }) {
      cleanup();
      const keyHash = computeKeyHash(method, path, idempotencyKey, body, hashIncludesBody);
      const bodyHash = computeBodyHash(body);
      _store.set(idempotencyKey, {
        keyHash,
        bodyHash,
        idempotencyKey,
        response,
        expiresAt: now() + ttlMs,
      });
    },

    clear() {
      _store.clear();
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
