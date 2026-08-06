/**
 * Session Store — in-memory session tracker for session/cookie auth.
 *
 * Backs the session-based authentication mode (configured via dsl.auth.session
 * in global.yaml). When a client POSTs to the configured loginPath the gateway
 * creates a Session here, sets a Set-Cookie header on the response, and
 * subsequent requests carrying the cookie resolve back to the same Actor.
 *
 * - Session ids are UUIDv7 strings.
 * - CSRF tokens are random hex strings; one per session.
 * - Expiry is enforced on lookup (`get()` returns null and evicts).
 * - A background sweep periodically removes entries that were created but
 *   never looked up (prevents unbounded map growth on login floods).
 * - A maxSessions cap causes create() to throw once the live session count
 *   reaches the limit, rather than growing without bound.
 * - The store is fully in-memory and resettable for `/_admin/reset`.
 * - An optional `nowMs` callback lets the engine wire session expiry through
 *   the same virtual clock used by CEL (admin clock advance affects TTL).
 */

import type { Actor } from '../contracts/identity.js';
import { SessionLimitError } from '../errors.js';
import type { RuntimeTimerScheduler } from '../runtime/ports.js';

export interface Session {
  /** Session id — UUIDv7 string, used as the cookie value. */
  readonly id: string;
  /** Authenticated actor (id + scopes). */
  readonly actor: Actor;
  /** Creation time (ms since epoch, in the engine's clock domain). */
  readonly createdAt: number;
  /** Expiry time (ms since epoch, in the engine's clock domain). */
  readonly expiresAt: number;
  /** Per-session CSRF token; required on POST/PUT/PATCH/DELETE when csrfHeader is configured. */
  readonly csrfToken: string;
}

export interface SessionStore {
  /** Create a new session for `actor`. `ttlMs` controls expiry from "now". */
  create(actor: Actor, ttlMs: number): Session;
  /** Look up a session by id. Returns null if missing or expired (evicts expired entries). */
  get(sessionId: string, at?: number): Session | null;
  /** Destroy a session by id. Returns true if the entry existed. */
  destroy(sessionId: string): boolean;
  /** Wipe all sessions while keeping the reusable background sweep timer active. */
  reset(): void;
  /** Stop the background sweep timer and release the store. */
  dispose(): void;
  /** Active session count (excludes expired-but-not-yet-evicted entries). */
  size(): number;
}

export interface SessionStoreOptions {
  /** Clock function returning the current time in ms. Supplied by the owning runtime. */
  readonly nowMs: () => number;
  /** Identifier factory supplied by the owning runtime. */
  readonly uuid: () => string;
  /** CSRF token factory supplied by the owning runtime. */
  readonly csrfToken: () => string;
  /** Timer implementation supplied by the owning runtime host. */
  readonly scheduler: RuntimeTimerScheduler;
  /**
   * How often (ms) the background sweep runs to delete expired entries that were
   * never looked up. Defaults to 60 000 ms (60 s). Set to 0 to disable.
   */
  readonly sweepIntervalMs?: number;
  /**
   * Maximum number of live (non-expired) sessions. create() throws when this
   * limit is reached. Defaults to Infinity (no cap).
   */
  readonly maxSessions?: number;
}

export function createSessionStore(opts: SessionStoreOptions): SessionStore {
  const sessions = new Map<string, Session>();
  const now = opts.nowMs;
  const uuid = opts.uuid;
  const csrfToken = opts.csrfToken;
  const scheduler = opts.scheduler;
  const sweepIntervalMs = opts.sweepIntervalMs ?? 60_000;
  const maxSessions = opts.maxSessions ?? Infinity;
  validateNonNegativeFinite(sweepIntervalMs, 'sweepIntervalMs');
  if (maxSessions !== Infinity && (!Number.isSafeInteger(maxSessions) || maxSessions < 0)) {
    throw new RangeError('maxSessions must be a non-negative safe integer or Infinity');
  }

  /** Delete all map entries whose expiresAt is in the past. */
  function sweep(): void {
    const current = now();
    for (const [id, session] of sessions.entries()) {
      if (current >= session.expiresAt) {
        sessions.delete(id);
      }
    }
  }

  let sweepTimer: unknown;

  if (sweepIntervalMs > 0) {
    sweepTimer = scheduler.setInterval(sweep, sweepIntervalMs);
    scheduler.unref?.(sweepTimer);
  }

  function stopSweep(): void {
    if (sweepTimer !== undefined) {
      scheduler.clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
  }

  return {
    create(actor: Actor, ttlMs: number): Session {
      validateNonNegativeFinite(ttlMs, 'ttlMs');

      // Count only live sessions toward the cap.
      const created = now();
      let liveCount = 0;
      for (const session of sessions.values()) {
        if (created < session.expiresAt) liveCount++;
      }
      if (liveCount >= maxSessions) {
        throw new SessionLimitError(maxSessions);
      }

      const session: Session = {
        id: uuid(),
        actor,
        createdAt: created,
        expiresAt: created + ttlMs,
        csrfToken: csrfToken(),
      };
      sessions.set(session.id, session);
      return session;
    },

    get(sessionId: string, at?: number): Session | null {
      const session = sessions.get(sessionId);
      if (!session) return null;
      if ((at ?? now()) >= session.expiresAt) {
        // A request-local clock must not evict a session from the shared
        // store. It only changes the answer seen by this request.
        if (at === undefined) sessions.delete(sessionId);
        return null;
      }
      return session;
    },

    destroy(sessionId: string): boolean {
      return sessions.delete(sessionId);
    },

    reset(): void {
      sessions.clear();
      // Leave the sweep timer running — the store is reused across /_admin/reset
      // calls for the full process lifetime, so the sweep must remain active.
      // Only dispose() permanently stops the timer.
    },

    dispose(): void {
      stopSweep();
    },

    size(): number {
      // Count only sessions that have not yet expired (matches `get()` semantics).
      const current = now();
      let n = 0;
      for (const session of sessions.values()) {
        if (current < session.expiresAt) n++;
      }
      return n;
    },
  };
}

function validateNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}
