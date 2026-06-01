// Session/cookie authentication for the HTTP gateway.
//
// When auth.mode === 'session', this installs an Express middleware that:
//   - intercepts the configured login_path (POST) → creates a session in the
//     per-system SessionStore, sets the session cookie, and returns the CSRF
//     token + actor + expiry;
//   - intercepts the configured logout_path (DELETE) → destroys the session and
//     clears the cookie (Max-Age=0);
//   - for every other request, resolves the session from the cookie and exposes
//     the authenticated Actor on the request, and enforces the CSRF header on
//     state-changing methods when a session is present.
//
// Actor resolution is surfaced via a request-scoped property the gateway reads
// in preference to the Authorization-header path, so scoped behaviours see the
// session actor and fire 401/403 exactly as they do for JWT/legacy auth.

import type { Request, Response, NextFunction } from 'express';
import type { Actor, JsonObject } from '../types.js';
import type { AuthConfig, SessionAuthConfig } from '../dsl/types.js';
import type { SessionStore } from '../identity/sessionStore.js';

/** Default cookie name when the fixture omits cookie_name. */
const DEFAULT_COOKIE_NAME = 'sid';
/** Default session TTL when the fixture omits ttl_seconds. */
const DEFAULT_TTL_SECONDS = 3600;

/** Request property carrying the resolved session actor (read by the gateway). */
export const SESSION_ACTOR_KEY = 'potemkinSessionActor';
/** Marks that session auth ran for this request (so the gateway skips Bearer auth). */
export const SESSION_HANDLED_KEY = 'potemkinSessionHandled';

interface SessionRequest extends Request {
  [SESSION_ACTOR_KEY]?: Actor;
  [SESSION_HANDLED_KEY]?: boolean;
}

/** Parse a Cookie header into a name→value map. */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

function cfg(session: SessionAuthConfig | undefined) {
  return {
    cookieName: session?.cookieName ?? DEFAULT_COOKIE_NAME,
    ttlSeconds: session?.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    loginPath: session?.loginPath ?? '/sessions',
    logoutPath: session?.logoutPath ?? '/sessions/current',
    // CSRF is enforced when a header name is configured AND csrf is not
    // explicitly disabled (csrf defaults to true when absent).
    csrfHeader: session?.csrf !== false ? session?.csrfHeader : undefined,
  };
}

/** Build the Set-Cookie value for a freshly minted session. */
function buildSetCookie(cookieName: string, sessionId: string, maxAgeSeconds: number): string {
  return `${cookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

/** Build the Set-Cookie value that clears the session cookie. */
function buildClearCookie(cookieName: string): string {
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Build the session-auth middleware for the given auth config + store. Returns
 * null when the auth mode is not 'session' (no middleware needed).
 */
export function createSessionAuthMiddleware(
  auth: AuthConfig | undefined,
  store: SessionStore,
): ((req: Request, res: Response, next: NextFunction) => void) | null {
  if (auth?.mode !== 'session') return null;
  const c = cfg(auth.session);

  return (req: Request, res: Response, next: NextFunction): void => {
    const sreq = req as SessionRequest;
    sreq[SESSION_HANDLED_KEY] = true;
    const cookies = parseCookies(req.headers['cookie']);

    // ── Login ────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && req.path === c.loginPath) {
      const body = (req.body ?? {}) as JsonObject;
      const actorId = typeof body['actorId'] === 'string' ? (body['actorId'] as string) : null;
      if (!actorId) {
        res.status(400).json({ error: 'CONTRACT_VIOLATION', message: 'actorId is required' });
        return;
      }
      const scopes = Array.isArray(body['scopes'])
        ? (body['scopes'] as unknown[]).filter((s): s is string => typeof s === 'string')
        : [];
      const session = store.create({ id: actorId, scopes }, c.ttlSeconds * 1000);
      res
        .status(200)
        .setHeader('Set-Cookie', buildSetCookie(c.cookieName, session.id, c.ttlSeconds))
        .json({
          sessionId: session.id,
          csrfToken: session.csrfToken,
          actor: { id: session.actor.id, scopes: session.actor.scopes },
          expiresAt: new Date(session.expiresAt).toISOString(),
        });
      return;
    }

    // ── Logout ───────────────────────────────────────────────────────────────
    if (req.method === 'DELETE' && req.path === c.logoutPath) {
      const sid = cookies[c.cookieName];
      if (sid) store.destroy(sid);
      res.status(204).setHeader('Set-Cookie', buildClearCookie(c.cookieName)).end();
      return;
    }

    // ── Resolve session for all other requests ────────────────────────────────
    const sid = cookies[c.cookieName];
    if (sid) {
      const session = store.get(sid);
      if (session) {
        // CSRF: when configured, state-changing requests with a live session
        // must carry the matching CSRF token. Absent/mismatched → 403.
        if (c.csrfHeader && STATE_CHANGING.has(req.method)) {
          const provided = req.headers[c.csrfHeader.toLowerCase()];
          const token = Array.isArray(provided) ? provided[0] : provided;
          if (token !== session.csrfToken) {
            res.status(403).json({ error: 'CSRF_TOKEN_INVALID', message: 'CSRF token missing or invalid' });
            return;
          }
        }
        sreq[SESSION_ACTOR_KEY] = { id: session.actor.id, scopes: session.actor.scopes };
      }
    }
    next();
  };
}
