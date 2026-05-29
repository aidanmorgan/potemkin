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
 * - The store is fully in-memory and resettable for `/_admin/reset`.
 * - An optional `nowMs` callback lets the engine wire session expiry through
 *   the same virtual clock used by CEL (admin clock advance affects TTL).
 */

import { randomBytes } from 'node:crypto';
import type { Actor } from '../types.js';
import { nextUuidv7 } from '../ids/uuidv7.js';

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
  get(sessionId: string): Session | null;
  /** Destroy a session by id. Returns true if the entry existed. */
  destroy(sessionId: string): boolean;
  /** Wipe all sessions — used by /_admin/reset to return to a clean state. */
  reset(): void;
  /** Active session count (excludes expired-but-not-yet-evicted entries). */
  size(): number;
}

export interface SessionStoreOptions {
  /** Clock function returning the current time in ms. Defaults to Date.now. */
  readonly nowMs?: () => number;
}

/** Build a per-session CSRF token. 32 random bytes → 64 hex chars. */
function generateCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

export function createSessionStore(opts: SessionStoreOptions = {}): SessionStore {
  const sessions = new Map<string, Session>();
  const now = opts.nowMs ?? Date.now;

  return {
    create(actor: Actor, ttlMs: number): Session {
      const created = now();
      const session: Session = {
        id: nextUuidv7(),
        actor,
        createdAt: created,
        expiresAt: created + ttlMs,
        csrfToken: generateCsrfToken(),
      };
      sessions.set(session.id, session);
      return session;
    },

    get(sessionId: string): Session | null {
      const session = sessions.get(sessionId);
      if (!session) return null;
      if (now() >= session.expiresAt) {
        sessions.delete(sessionId);
        return null;
      }
      return session;
    },

    destroy(sessionId: string): boolean {
      return sessions.delete(sessionId);
    },

    reset(): void {
      sessions.clear();
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
