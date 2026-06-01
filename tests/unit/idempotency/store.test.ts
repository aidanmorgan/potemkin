/**
 * Idempotency store
 */
import { createIdempotencyStore } from '../../../src/idempotency/store';
import { IdempotencyConflictError } from '../../../src/errors';

const METHOD = 'POST';
const PATH = '/loans';
const KEY = 'my-key-123';
const BODY = { amount: 500 };
const RESPONSE = { status: 201, body: { id: 'loan-1' } };
const TTL_MS = 60_000;

describe('idempotency/store', () => {
  it('returns hit: false for a new key', () => {
    const store = createIdempotencyStore();
    const result = store.check({ method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    expect(result.hit).toBe(false);
  });

  it('returns hit: true for a replayed request after recording', () => {
    const store = createIdempotencyStore();
    store.record({ method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true, response: RESPONSE, ttlMs: TTL_MS });
    const result = store.check({ method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.response).toEqual(RESPONSE);
    }
  });

  it('throws IdempotencyConflictError (409) on same key with different body', () => {
    const store = createIdempotencyStore();
    store.record({ method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true, response: RESPONSE, ttlMs: TTL_MS });
    const differentBody = { amount: 9999 };
    expect(() =>
      store.check({ method: METHOD, path: PATH, idempotencyKey: KEY, body: differentBody, hashIncludesBody: true }),
    ).toThrow(IdempotencyConflictError);
  });

  it('IdempotencyConflictError has status 409 and code IDEMPOTENCY_KEY_CONFLICT', () => {
    const store = createIdempotencyStore();
    store.record({ method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true, response: RESPONSE, ttlMs: TTL_MS });
    try {
      store.check({ method: METHOD, path: PATH, idempotencyKey: KEY, body: { other: true }, hashIncludesBody: true });
      fail('expected throw');
    } catch (err) {
      expect((err as IdempotencyConflictError).status).toBe(409);
      expect((err as IdempotencyConflictError).code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    }
  });

  it('treats expired entries as miss (new request)', () => {
    const store = createIdempotencyStore();
    store.record({ method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true, response: RESPONSE, ttlMs: 1 }); // 1ms TTL
    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) {} // busy-wait 5ms
    const result = store.check({ method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    expect(result.hit).toBe(false);
  });

  it('hash_includes_body: false dedupes by path+key ignoring body diff', () => {
    const store = createIdempotencyStore();
    store.record({ method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: false, response: RESPONSE, ttlMs: TTL_MS });
    const result = store.check({ method: METHOD, path: PATH, idempotencyKey: KEY, body: { amount: 9999 }, hashIncludesBody: false });
    expect(result.hit).toBe(true);
  });

  it('record() prunes expired entries without a check() call', () => {
    jest.useFakeTimers();
    try {
      const store = createIdempotencyStore();

      // Record 5 entries with a 100ms TTL
      for (let i = 0; i < 5; i++) {
        store.record({
          method: METHOD,
          path: PATH,
          idempotencyKey: `key-${i}`,
          body: BODY,
          hashIncludesBody: true,
          response: RESPONSE,
          ttlMs: 100,
        });
      }
      // All 5 are live
      expect(store.size()).toBe(5);

      // Advance clock past expiry — all 5 are now stale
      jest.advanceTimersByTime(200);

      // Record a new entry (no check() call) — record() must prune the 5 expired entries
      store.record({
        method: METHOD,
        path: PATH,
        idempotencyKey: 'key-fresh',
        body: BODY,
        hashIncludesBody: true,
        response: RESPONSE,
        ttlMs: 60_000,
      });

      // Only the fresh entry remains — the 5 expired entries were pruned inside record()
      expect(store.size()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
