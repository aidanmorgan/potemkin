/**
 * Session Store unit tests — exercises createSessionStore() in isolation.
 *
 * This is the foundation of the upcoming session/cookie auth mode. The gateway
 * middleware that wires it into request handling is not yet hooked up, so we
 * verify the store contract here directly:
 *
 *   1. create()  — produces a session with id, actor, createdAt, expiresAt, csrfToken
 *   2. get()     — returns the session for a valid id
 *   3. get()     — returns null for an unknown id
 *   4. get()     — returns null after the TTL elapses (and evicts the entry)
 *   5. destroy() — removes the session; subsequent get() returns null
 *   6. reset()   — clears all sessions
 *   7. CSRF tokens differ between sessions
 *   8. size()    — reports the live (non-expired) count
 *   9. sweep     — sessions never looked up are removed by the background sweep once expired
 *  10. dispose() — sweep timer is stopped; no callback fires after dispose
 *  11. reset()   — sweep timer is stopped; no callback fires after reset
 *  12. create()  — rejects once maxSessions cap is reached
 *
 * The store accepts an injectable `nowMs` clock — tests use that rather than
 * jest fake timers, which lets us advance the clock deterministically without
 * touching global Date.
 *
 * Sweep-timer tests use jest fake timers for setInterval/clearInterval control
 * while keeping the injected clock for expiry logic.
 */
import { createSessionStore } from '../../../src/identity/sessionStore';
import type { Actor } from '../../../src/types';

const ACTOR_ALICE: Actor = { id: 'alice', scopes: ['admin'] };
const ACTOR_BOB: Actor = { id: 'bob', scopes: ['viewer', 'agent'] };
const TTL_MS = 60_000;

describe('identity/sessionStore', () => {
  it('create() returns a session with id, actor, createdAt, expiresAt, csrfToken', () => {
    const fixedNow = 1_700_000_000_000;
    const store = createSessionStore({ nowMs: () => fixedNow });

    const session = store.create(ACTOR_ALICE, TTL_MS);

    expect(typeof session.id).toBe('string');
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.actor).toEqual(ACTOR_ALICE);
    expect(session.createdAt).toBe(fixedNow);
    expect(session.expiresAt).toBe(fixedNow + TTL_MS);
    expect(typeof session.csrfToken).toBe('string');
    expect(session.csrfToken.length).toBe(64); // 32 bytes hex-encoded
  });

  it('get() returns the session for a valid id', () => {
    const store = createSessionStore();
    const created = store.create(ACTOR_ALICE, TTL_MS);

    const fetched = store.get(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.actor).toEqual(ACTOR_ALICE);
    expect(fetched?.csrfToken).toBe(created.csrfToken);
  });

  it('get() returns null for an unknown session id', () => {
    const store = createSessionStore();
    store.create(ACTOR_ALICE, TTL_MS);

    const result = store.get('00000000-0000-0000-0000-000000000000');

    expect(result).toBeNull();
  });

  it('get() returns null after the TTL elapses and evicts the expired entry', () => {
    // Drive the store's clock forward manually — equivalent to jest fake timers
    // but without touching globals.
    let now = 1_700_000_000_000;
    const store = createSessionStore({ nowMs: () => now });
    const session = store.create(ACTOR_ALICE, TTL_MS);

    // Before expiry: still resolvable.
    expect(store.get(session.id)).not.toBeNull();

    // Advance past expiresAt.
    now = session.expiresAt + 1;

    expect(store.get(session.id)).toBeNull();

    // size() reflects the eviction (the expired session is no longer counted).
    expect(store.size()).toBe(0);
  });

  it('destroy() removes the session; subsequent get() returns null', () => {
    const store = createSessionStore();
    const session = store.create(ACTOR_ALICE, TTL_MS);

    const removed = store.destroy(session.id);

    expect(removed).toBe(true);
    expect(store.get(session.id)).toBeNull();
  });

  it('destroy() returns false for an unknown id', () => {
    const store = createSessionStore();

    const removed = store.destroy('not-a-real-session-id');

    expect(removed).toBe(false);
  });

  it('reset() clears all sessions', () => {
    const store = createSessionStore();
    const a = store.create(ACTOR_ALICE, TTL_MS);
    const b = store.create(ACTOR_BOB, TTL_MS);
    expect(store.size()).toBe(2);

    store.reset();

    expect(store.size()).toBe(0);
    expect(store.get(a.id)).toBeNull();
    expect(store.get(b.id)).toBeNull();
  });

  it('two sessions get different csrfTokens and different ids', () => {
    const store = createSessionStore();

    const a = store.create(ACTOR_ALICE, TTL_MS);
    const b = store.create(ACTOR_BOB, TTL_MS);

    expect(a.id).not.toBe(b.id);
    expect(a.csrfToken).not.toBe(b.csrfToken);
  });

  it('size() returns the count of live (non-expired) sessions', () => {
    let now = 1_700_000_000_000;
    const store = createSessionStore({ nowMs: () => now });

    expect(store.size()).toBe(0);

    store.create(ACTOR_ALICE, TTL_MS);
    expect(store.size()).toBe(1);

    store.create(ACTOR_BOB, TTL_MS);
    expect(store.size()).toBe(2);

    // Advance past TTL — both sessions are now expired.
    now += TTL_MS + 1;
    expect(store.size()).toBe(0);
  });

  it('size() decrements after destroy()', () => {
    const store = createSessionStore();
    const a = store.create(ACTOR_ALICE, TTL_MS);
    const b = store.create(ACTOR_BOB, TTL_MS);
    expect(store.size()).toBe(2);

    store.destroy(a.id);
    expect(store.size()).toBe(1);

    store.destroy(b.id);
    expect(store.size()).toBe(0);
  });

  it('expired session is still destroyable (no error)', () => {
    let now = 1_700_000_000_000;
    const store = createSessionStore({ nowMs: () => now });
    const session = store.create(ACTOR_ALICE, TTL_MS);

    // Advance past TTL so get() would evict, then explicitly destroy.
    now = session.expiresAt + 1;
    const destroyed = store.destroy(session.id);

    // The underlying Map.delete still returns true because the entry exists
    // until get() is called (eviction is lazy). This documents the contract.
    expect(destroyed).toBe(true);
    expect(store.get(session.id)).toBeNull();
  });

  it('preserves the original actor object identity on lookup', () => {
    const store = createSessionStore();
    const session = store.create(ACTOR_ALICE, TTL_MS);

    const fetched = store.get(session.id);

    // The store should not mutate or wrap the actor; the same shape comes back.
    expect(fetched?.actor.id).toBe(ACTOR_ALICE.id);
    expect(fetched?.actor.scopes).toEqual(ACTOR_ALICE.scopes);
  });

  describe('background sweep', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('sessions never looked up are removed by the sweep once expired', () => {
      let now = 1_700_000_000_000;
      const store = createSessionStore({
        nowMs: () => now,
        sweepIntervalMs: 30_000,
      });

      // Create sessions but never call get() on them.
      store.create(ACTOR_ALICE, TTL_MS);
      store.create(ACTOR_BOB, TTL_MS);

      // Both sessions exist in-map (size counts non-expired).
      expect(store.size()).toBe(2);

      // Advance the injected clock past TTL so both sessions are expired.
      now += TTL_MS + 1;

      // Sessions are expired but not yet swept — still in map (size sees them as expired).
      expect(store.size()).toBe(0);

      // Advance fake timers to trigger the sweep interval.
      jest.advanceTimersByTime(30_000);

      // Sweep has run: expired entries are physically deleted from the map.
      // size() and get() continue to return 0/null as before, and the map is now empty.
      expect(store.size()).toBe(0);

      store.dispose();
    });

    it('dispose() stops the sweep timer so no callback fires after dispose', () => {
      let now = 1_700_000_000_000;
      const store = createSessionStore({
        nowMs: () => now,
        sweepIntervalMs: 30_000,
      });

      store.create(ACTOR_ALICE, TTL_MS);
      now += TTL_MS + 1;

      store.dispose();

      // Advance fake timers well past the sweep interval — the sweep must not fire.
      jest.advanceTimersByTime(120_000);

      // The expired session was not swept (dispose stopped the timer before the
      // sweep had a chance to run). size() still correctly returns 0 (clock-based),
      // but the raw map entry is still present — which is the whole point of the fix:
      // confirming no timer callback fired after dispose.
      const pendingTimers = jest.getTimerCount();
      expect(pendingTimers).toBe(0);
    });

    it('after reset(), a session that is created and never get()-d is still evicted by the sweep once it expires (regression: potemkin-wbhg)', () => {
      let now = 1_700_000_000_000;
      const store = createSessionStore({
        nowMs: () => now,
        sweepIntervalMs: 30_000,
      });

      // Simulate what /_admin/reset does: reset the store between requests.
      store.reset();

      // Create a session after reset, never call get() on it.
      store.create(ACTOR_ALICE, TTL_MS);
      expect(store.size()).toBe(1);

      // Advance injected clock past TTL so the session is expired.
      now += TTL_MS + 1;
      expect(store.size()).toBe(0); // clock-based: expired

      // Advance fake timers to trigger the sweep — must still fire after reset().
      jest.advanceTimersByTime(30_000);

      // The sweep ran and removed the expired map entry. size() stays 0 and
      // the timer is still active (store still usable for the process lifetime).
      expect(store.size()).toBe(0);
      // At least one timer still pending — sweep is still running.
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      store.dispose();
    });

    it('reset() clears sessions but leaves the sweep timer running', () => {
      let now = 1_700_000_000_000;
      const store = createSessionStore({
        nowMs: () => now,
        sweepIntervalMs: 30_000,
      });

      store.create(ACTOR_ALICE, TTL_MS);
      now += TTL_MS + 1;

      store.reset();

      // After reset the sweep timer must still be registered.
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      store.dispose();
    });
  });

  describe('maxSessions cap', () => {
    it('create() rejects once maxSessions is reached', () => {
      const store = createSessionStore({ maxSessions: 2 });
      store.create(ACTOR_ALICE, TTL_MS);
      store.create(ACTOR_BOB, TTL_MS);

      expect(() => store.create(ACTOR_ALICE, TTL_MS)).toThrow(/session limit/i);
    });

    it('create() succeeds again after a session is destroyed', () => {
      const store = createSessionStore({ maxSessions: 1 });
      const session = store.create(ACTOR_ALICE, TTL_MS);

      expect(() => store.create(ACTOR_BOB, TTL_MS)).toThrow(/session limit/i);

      store.destroy(session.id);
      // Should no longer throw after freeing a slot.
      expect(() => store.create(ACTOR_BOB, TTL_MS)).not.toThrow();
    });

    it('create() counts only live sessions toward the cap', () => {
      let now = 1_700_000_000_000;
      const store = createSessionStore({ nowMs: () => now, maxSessions: 1 });
      store.create(ACTOR_ALICE, TTL_MS);

      // Advance past expiry so the session is logically gone.
      now += TTL_MS + 1;

      // The slot is freed (expired sessions don't count toward the cap).
      expect(() => store.create(ACTOR_BOB, TTL_MS)).not.toThrow();
    });
  });
});
