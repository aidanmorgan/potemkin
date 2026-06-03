/**
 * Unit tests for http/sessionAuth: createSessionAuthMiddleware.
 *
 * Covers CSRF enforcement toggle (potemkin-1vu7):
 *   - csrf: false disables CSRF enforcement even when csrfHeader is set
 *   - csrf: true (explicit) enforces CSRF when csrfHeader is set
 *   - csrf absent (defaults to true) enforces CSRF when csrfHeader is set
 *   - no csrfHeader → no CSRF enforcement regardless of csrf flag
 *
 * Also covers basic session lifecycle (login / session resolution) to confirm
 * the csrf change does not regress the happy path.
 */

import type { Request, Response, NextFunction } from 'express';
import { createSessionAuthMiddleware, SESSION_ACTOR_KEY } from '../../../src/http/sessionAuth';
import { createSessionStore } from '../../../src/identity/sessionStore';
import type { AuthConfig } from '../../../src/dsl/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/some-path',
    headers: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

interface FakeRes {
  res: Response;
  statusCode: number | undefined;
  body: unknown;
  headers: Record<string, string>;
}

function makeRes(): FakeRes {
  const fake: FakeRes = {
    res: null as unknown as Response,
    statusCode: undefined,
    body: undefined,
    headers: {},
  };

  fake.res = {
    status(code: number) {
      fake.statusCode = code;
      return fake.res;
    },
    json(b: unknown) {
      fake.body = b;
      return fake.res;
    },
    setHeader(name: string, value: string) {
      fake.headers[name] = value;
      return fake.res;
    },
    end() {
      return fake.res;
    },
  } as unknown as Response;

  return fake;
}

function makeAuth(sessionOverrides: Record<string, unknown> = {}): AuthConfig {
  return {
    mode: 'session',
    session: {
      cookieName: 'sid',
      ttlSeconds: 3600,
      csrfHeader: 'x-csrf-token',
      ...sessionOverrides,
    } as AuthConfig['session'],
  };
}

// ---------------------------------------------------------------------------
// CSRF toggle: potemkin-1vu7
// ---------------------------------------------------------------------------

describe('http/sessionAuth — CSRF toggle (potemkin-1vu7)', () => {
  it('csrf: false disables enforcement even when csrfHeader is set', () => {
    const store = createSessionStore();
    const auth = makeAuth({ csrf: false, csrfHeader: 'x-csrf-token' });
    const middleware = createSessionAuthMiddleware(auth, store)!;

    // Create a session so the cookie resolves.
    const session = store.create({ id: 'alice', scopes: [] }, 60_000);
    const cookieHeader = `sid=${encodeURIComponent(session.id)}`;

    const req = makeReq({
      method: 'POST',
      path: '/leads',
      headers: { cookie: cookieHeader },
      // Deliberately NO x-csrf-token header — enforcement is disabled.
    });
    const fake = makeRes();
    const next = jest.fn();

    middleware(req, fake.res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(fake.statusCode).toBeUndefined();
  });

  it('csrf: true (explicit) enforces CSRF when csrfHeader is set', () => {
    const store = createSessionStore();
    const auth = makeAuth({ csrf: true, csrfHeader: 'x-csrf-token' });
    const middleware = createSessionAuthMiddleware(auth, store)!;

    const session = store.create({ id: 'alice', scopes: [] }, 60_000);
    const cookieHeader = `sid=${encodeURIComponent(session.id)}`;

    const req = makeReq({
      method: 'POST',
      path: '/leads',
      headers: { cookie: cookieHeader },
      // Absent CSRF header → should 403.
    });
    const fake = makeRes();
    const next = jest.fn();

    middleware(req, fake.res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(fake.statusCode).toBe(403);
    expect((fake.body as Record<string, unknown>)['error']).toBe('CSRF_TOKEN_INVALID');
  });

  it('csrf absent (default true) enforces CSRF when csrfHeader is set', () => {
    const store = createSessionStore();
    // csrf key absent from session config — defaults to true.
    const auth = makeAuth({ csrfHeader: 'x-csrf-token' });
    const middleware = createSessionAuthMiddleware(auth, store)!;

    const session = store.create({ id: 'alice', scopes: [] }, 60_000);
    const cookieHeader = `sid=${encodeURIComponent(session.id)}`;

    const req = makeReq({
      method: 'POST',
      path: '/leads',
      headers: { cookie: cookieHeader },
    });
    const fake = makeRes();
    const next = jest.fn();

    middleware(req, fake.res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(fake.statusCode).toBe(403);
  });

  it('no csrfHeader configured → no CSRF enforcement regardless of csrf flag', () => {
    const store = createSessionStore();
    // csrf: true but no csrfHeader → no enforcement.
    const auth: AuthConfig = {
      mode: 'session',
      session: { cookieName: 'sid', ttlSeconds: 3600, csrf: true },
    };
    const middleware = createSessionAuthMiddleware(auth, store)!;

    const session = store.create({ id: 'alice', scopes: [] }, 60_000);
    const cookieHeader = `sid=${encodeURIComponent(session.id)}`;

    const req = makeReq({
      method: 'POST',
      path: '/leads',
      headers: { cookie: cookieHeader },
    });
    const fake = makeRes();
    const next = jest.fn();

    middleware(req, fake.res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(fake.statusCode).toBeUndefined();
  });

  it('csrf: false with correct CSRF header still proceeds (no false enforcement)', () => {
    const store = createSessionStore();
    const auth = makeAuth({ csrf: false, csrfHeader: 'x-csrf-token' });
    const middleware = createSessionAuthMiddleware(auth, store)!;

    const session = store.create({ id: 'alice', scopes: [] }, 60_000);
    const cookieHeader = `sid=${encodeURIComponent(session.id)}`;

    const req = makeReq({
      method: 'POST',
      path: '/leads',
      headers: { cookie: cookieHeader, 'x-csrf-token': session.csrfToken },
    });
    const fake = makeRes();
    const next = jest.fn();

    middleware(req, fake.res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(fake.statusCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cookie parsing — potemkin-qvgc
// ---------------------------------------------------------------------------

describe('http/sessionAuth — cookie parsing (potemkin-qvgc)', () => {
  it('resolves session from a percent-encoded cookie value that the old hand-rolled parser mishandled', () => {
    const store = createSessionStore();
    const auth = makeAuth();
    const middleware = createSessionAuthMiddleware(auth, store)!;

    // Create a session; the middleware itself percent-encodes the id in Set-Cookie.
    const session = store.create({ id: 'bob', scopes: ['admin'] }, 60_000);

    // Send a percent-encoded cookie that decodes back to the real session id —
    // the `cookie` library performs RFC 6265 percent-decoding on parse.
    const encodedSid = encodeURIComponent(session.id);
    const cookieHeader = `sid=${encodedSid}; other=ignored%20value`;

    const req = makeReq({
      method: 'GET',
      path: '/resource',
      headers: { cookie: cookieHeader },
    });
    const fake = makeRes();
    const next = jest.fn();

    middleware(req, fake.res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const actor = (req as unknown as Record<string, unknown>)[SESSION_ACTOR_KEY];
    expect(actor).toEqual({ id: 'bob', scopes: ['admin'] });
  });

  it('handles a cookie header with percent-encoded special characters in non-session cookies', () => {
    const store = createSessionStore();
    const auth = makeAuth();
    const middleware = createSessionAuthMiddleware(auth, store)!;

    const session = store.create({ id: 'carol', scopes: [] }, 60_000);
    // Use the literal session id (no encoding needed, UUIDs are URL-safe)
    // but add a sibling cookie whose value contains percent-encoded characters
    const cookieHeader = `sid=${session.id}; tracking=hello%20world%21`;

    const req = makeReq({
      method: 'GET',
      path: '/resource',
      headers: { cookie: cookieHeader },
    });
    const fake = makeRes();
    const next = jest.fn();

    middleware(req, fake.res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const actor = (req as unknown as Record<string, unknown>)[SESSION_ACTOR_KEY];
    expect(actor).toEqual({ id: 'carol', scopes: [] });
  });
});

// ---------------------------------------------------------------------------
// Basic session lifecycle (regression guard)
// ---------------------------------------------------------------------------

describe('http/sessionAuth — session lifecycle', () => {
  it('returns null when auth mode is not session', () => {
    const store = createSessionStore();
    const auth: AuthConfig = { mode: 'jwt' };
    expect(createSessionAuthMiddleware(auth, store)).toBeNull();
  });

  it('resolves session actor from cookie on non-login request', () => {
    const store = createSessionStore();
    const auth = makeAuth();
    const middleware = createSessionAuthMiddleware(auth, store)!;

    const session = store.create({ id: 'alice', scopes: ['viewer'] }, 60_000);
    const cookieHeader = `sid=${encodeURIComponent(session.id)}`;

    const req = makeReq({
      method: 'GET',
      path: '/leads',
      headers: { cookie: cookieHeader },
    });
    const fake = makeRes();
    const next = jest.fn();

    middleware(req, fake.res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const actor = (req as unknown as Record<string, unknown>)[SESSION_ACTOR_KEY];
    expect(actor).toEqual({ id: 'alice', scopes: ['viewer'] });
  });

  it('CSRF passes with correct token on state-changing request', () => {
    const store = createSessionStore();
    const auth = makeAuth({ csrfHeader: 'x-csrf-token' });
    const middleware = createSessionAuthMiddleware(auth, store)!;

    const session = store.create({ id: 'alice', scopes: [] }, 60_000);
    const cookieHeader = `sid=${encodeURIComponent(session.id)}`;

    const req = makeReq({
      method: 'POST',
      path: '/leads',
      headers: { cookie: cookieHeader, 'x-csrf-token': session.csrfToken },
    });
    const fake = makeRes();
    const next = jest.fn();

    middleware(req, fake.res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(fake.statusCode).toBeUndefined();
  });
});
