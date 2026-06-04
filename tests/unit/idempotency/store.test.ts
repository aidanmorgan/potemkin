/**
 * Idempotency store
 */
import { createIdempotencyStore } from '../../../src/idempotency/store';
import { IdempotencyConflictError } from '../../../src/errors';

const ACTOR = 'alice';
const METHOD = 'POST';
const PATH = '/loans';
const KEY = 'my-key-123';
const BODY = { amount: 500 };
const RESPONSE = { status: 201, body: { id: 'loan-1' } };
const TTL_MS = 60_000;

describe('idempotency/store', () => {
  it('returns kind: miss for a new key', () => {
    const store = createIdempotencyStore();
    const result = store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    expect(result.kind).toBe('miss');
  });

  it('returns kind: hit for a replayed request after recording', () => {
    const store = createIdempotencyStore();
    store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    store.record({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true, response: RESPONSE, ttlMs: TTL_MS });
    const result = store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    expect(result.kind).toBe('hit');
    if (result.kind === 'hit') {
      expect(result.response).toEqual(RESPONSE);
    }
  });

  it('a DIFFERENT actor replaying the same key+body gets a miss, not the cached response', () => {
    const store = createIdempotencyStore();
    store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    store.record({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true, response: RESPONSE, ttlMs: TTL_MS });
    // Mallory uses the exact same key + body but a different actor id.
    const result = store.check({ actorId: 'mallory', method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    expect(result.kind).toBe('miss');
  });

  it('throws IdempotencyConflictError (409) on same actor+key with different body', () => {
    const store = createIdempotencyStore();
    store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    store.record({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true, response: RESPONSE, ttlMs: TTL_MS });
    const differentBody = { amount: 9999 };
    expect(() =>
      store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: differentBody, hashIncludesBody: true }),
    ).toThrow(IdempotencyConflictError);
  });

  it('IdempotencyConflictError has status 409 and code IDEMPOTENCY_KEY_CONFLICT', () => {
    const store = createIdempotencyStore();
    store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    store.record({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true, response: RESPONSE, ttlMs: TTL_MS });
    try {
      store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: { other: true }, hashIncludesBody: true });
      fail('expected throw');
    } catch (err) {
      expect((err as IdempotencyConflictError).status).toBe(409);
      expect((err as IdempotencyConflictError).code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    }
  });

  it('a second concurrent check with the same key WAITS on the in-flight reservation', async () => {
    const store = createIdempotencyStore();
    // First request reserves the slot (miss).
    const first = store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    expect(first.kind).toBe('miss');

    // Second concurrent request observes the reservation and must wait.
    const second = store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    expect(second.kind).toBe('wait');

    // When the first request records, the waiter resolves with that response.
    store.record({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true, response: RESPONSE, ttlMs: TTL_MS });
    if (second.kind === 'wait') {
      await expect(second.wait).resolves.toEqual(RESPONSE);
    }
  });

  it('release() unblocks a waiter with null so it re-executes', async () => {
    const store = createIdempotencyStore();
    const first = store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    expect(first.kind).toBe('miss');
    const second = store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    expect(second.kind).toBe('wait');

    // First request errored — it releases without recording.
    store.release({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    if (second.kind === 'wait') {
      await expect(second.wait).resolves.toBeNull();
    }
    // After release the slot is free again: a fresh check is a miss (re-reserve).
    const retry = store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    expect(retry.kind).toBe('miss');
  });

  it('treats expired entries as miss (new request)', () => {
    const store = createIdempotencyStore();
    store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    store.record({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true, response: RESPONSE, ttlMs: 1 }); // 1ms TTL
    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) {} // busy-wait 5ms
    const result = store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    expect(result.kind).toBe('miss');
  });

  it('hash_includes_body: false dedupes by actor+path+key ignoring body diff', () => {
    const store = createIdempotencyStore();
    store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: false });
    store.record({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: false, response: RESPONSE, ttlMs: TTL_MS });
    const result = store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: { amount: 9999 }, hashIncludesBody: false });
    expect(result.kind).toBe('hit');
  });

  it('injected nowMs: advancing virtual clock past ttlSeconds expires the entry', () => {
    let virtualMs = 1_000_000;
    const store = createIdempotencyStore({ nowMs: () => virtualMs });

    store.record({
      actorId: ACTOR,
      method: METHOD,
      path: PATH,
      idempotencyKey: KEY,
      body: BODY,
      hashIncludesBody: true,
      response: RESPONSE,
      ttlMs: 5_000, // 5 s TTL from virtual clock
    });

    // Entry is live before TTL elapses.
    expect(store.size()).toBe(1);
    const hitBefore = store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    expect(hitBefore.kind).toBe('hit');

    // Advance virtual clock past the TTL — entry must expire.
    virtualMs += 6_000;
    expect(store.size()).toBe(0);
    const missAfter = store.check({ actorId: ACTOR, method: METHOD, path: PATH, idempotencyKey: KEY, body: BODY, hashIncludesBody: true });
    expect(missAfter.kind).toBe('miss');
  });

  it('record() prunes expired entries without a check() call', () => {
    jest.useFakeTimers();
    try {
      const store = createIdempotencyStore();

      // Record 5 entries with a 100ms TTL
      for (let i = 0; i < 5; i++) {
        store.record({
          actorId: ACTOR,
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
        actorId: ACTOR,
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
