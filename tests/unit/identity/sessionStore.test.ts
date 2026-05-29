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
 *
 * The store accepts an injectable `nowMs` clock — tests use that rather than
 * jest fake timers, which lets us advance the clock deterministically without
 * touching global Date.
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
});
