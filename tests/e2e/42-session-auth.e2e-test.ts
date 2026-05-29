/**
 * 42 — Session auth (cookie + CSRF), driven entirely from YAML config.
 *
 * Validates the session/cookie auth mode end-to-end:
 *  1. POST /sessions returns 200 + Set-Cookie + csrfToken.
 *  2. Subsequent GET /leads with the session cookie succeeds (authenticated).
 *  3. POST /leads/{id}/dnc without the cookie → 401 (scope requires auth).
 *  4. POST /leads with cookie but missing CSRF header → 403.
 *  5. POST /leads with cookie + correct CSRF header → 201.
 *  6. DELETE /sessions/current → 204; reusing the same cookie on a scoped
 *     endpoint → 401 (session destroyed).
 *  7. Advancing the clock past session TTL → cookie no longer authenticates.
 *  8. Different sessions get different csrfTokens.
 *
 * The behaviour itself lives in tests/fixtures/crm-session/dsl/global.yaml —
 * this suite asserts the engine honours that YAML config without code-side
 * changes to the test fixture.
 */

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';

function javaAvailable(): boolean {
  try {
    execSync('java -version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// The session fixture skips Specmatic, so the suite runs even without Java.
// We still keep the describe gate so the file slots alongside other e2e tests.
const describeMaybeJava = javaAvailable() ? describe : describe;

// Cookie / CSRF config — must match tests/fixtures/crm-session/dsl/global.yaml.
const COOKIE_NAME = 'potemkin_sid';
const CSRF_HEADER = 'x-csrf-token';
const SESSION_TTL_MS = 3600 * 1000;

/** Extract the cookie value (just the name=value pair, without attributes). */
function extractCookie(setCookieHeader: string | null, name: string): string | null {
  if (!setCookieHeader) return null;
  // Set-Cookie may contain multiple comma-separated cookies; we only emit one.
  const parts = setCookieHeader.split(';').map((s) => s.trim());
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === name) {
      try { return decodeURIComponent(value); } catch { return value; }
    }
  }
  return null;
}

interface LoginResponse {
  sessionId: string;
  csrfToken: string;
  actor: { id: string; scopes: string[] };
  expiresAt: string;
}

async function login(engineUrl: string, actorId: string, scopes: string[]): Promise<{
  cookieHeader: string;
  body: LoginResponse;
  rawSetCookie: string | null;
}> {
  const res = await fetch(`${engineUrl}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actorId, scopes }),
  });
  expect(res.status).toBe(200);
  const rawSetCookie = res.headers.get('set-cookie');
  const sessionId = extractCookie(rawSetCookie, COOKIE_NAME);
  expect(sessionId).toBeTruthy();
  const body = await res.json() as LoginResponse;
  return { cookieHeader: `${COOKIE_NAME}=${sessionId}`, body, rawSetCookie };
}

describeMaybeJava('42 — Session/cookie auth (YAML-driven)', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({ fixtureName: 'crm-session' });
  }, 60_000);

  afterAll(async () => {
    if (app) await app.shutdown();
  }, 30_000);

  it('POST /sessions returns 200, Set-Cookie, and a csrfToken', async () => {
    const res = await fetch(`${app.engineUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorId: 'alice', scopes: ['agent', 'viewer'] }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toMatch(new RegExp(`^${COOKIE_NAME}=`));
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Max-Age=3600/);

    const body = await res.json() as LoginResponse;
    expect(typeof body.csrfToken).toBe('string');
    expect(body.csrfToken.length).toBeGreaterThan(16);
    expect(body.actor.id).toBe('alice');
    expect(body.actor.scopes).toEqual(['agent', 'viewer']);
  }, 30_000);

  it('GET /leads with valid session cookie → 200', async () => {
    const { cookieHeader } = await login(app.engineUrl, 'bob', ['agent']);
    const res = await fetch(`${app.engineUrl}/leads`, {
      method: 'GET',
      headers: { cookie: cookieHeader },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body) || (body !== null && typeof body === 'object')).toBe(true);
  }, 30_000);

  it('POST /leads/{id}/dnc WITHOUT a session cookie → 401', async () => {
    // /leads/{id}/dnc has required_scopes:[manager] in the DSL. With no cookie
    // there is no actor, so the engine raises AuthenticationRequiredError.
    // We must also send a CSRF header value because the CSRF check only runs
    // when a session is found — here there is no session, so we skip it.
    const res = await fetch(`${app.engineUrl}/leads/00000000-0000-7000-8000-000000000010/dnc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'No cookie' }),
    });
    expect(res.status).toBe(401);
  }, 30_000);

  it('POST /leads with cookie but MISSING CSRF header → 403', async () => {
    const { cookieHeader } = await login(app.engineUrl, 'carol', ['agent']);
    const res = await fetch(`${app.engineUrl}/leads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieHeader,
      },
      body: JSON.stringify({
        companyName: 'CSRF Test Co',
        contactName: 'No CSRF',
        phone: '+61 2 0000 0001',
        email: 'csrf@test.com',
        source: 'WEBSITE',
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(body['error']).toBe('CSRF_TOKEN_INVALID');
  }, 30_000);

  it('POST /leads with cookie AND correct CSRF header → 201', async () => {
    const { cookieHeader, body: login1 } = await login(app.engineUrl, 'dave', ['agent']);
    const res = await fetch(`${app.engineUrl}/leads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieHeader,
        [CSRF_HEADER]: login1.csrfToken,
      },
      body: JSON.stringify({
        companyName: 'CSRF OK Co',
        contactName: 'CSRF OK',
        phone: '+61 2 0000 0002',
        email: 'ok@test.com',
        source: 'WEBSITE',
      }),
    });
    expect([200, 201]).toContain(res.status);
    const body = await res.json() as Record<string, unknown>;
    expect(body['companyName']).toBe('CSRF OK Co');
    expect(body['status']).toBe('NEW');
  }, 30_000);

  it('DELETE /sessions/current → 204; reusing cookie afterwards → 401 on scoped endpoint', async () => {
    const { cookieHeader, body: login1 } = await login(app.engineUrl, 'erin', ['manager']);

    // Before logout: scoped endpoint accepts the cookie + manager scope.
    const beforeLogout = await fetch(`${app.engineUrl}/leads/00000000-0000-7000-8000-000000000010/dnc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieHeader,
        [CSRF_HEADER]: login1.csrfToken,
      },
      body: JSON.stringify({ reason: 'before-logout' }),
    });
    expect([200, 201]).toContain(beforeLogout.status);

    // Logout.
    const logout = await fetch(`${app.engineUrl}/sessions/current`, {
      method: 'DELETE',
      headers: { cookie: cookieHeader },
    });
    expect(logout.status).toBe(204);
    // Logout clears the cookie.
    const setCookie = logout.headers.get('set-cookie');
    expect(setCookie).toMatch(new RegExp(`^${COOKIE_NAME}=`));
    expect(setCookie).toMatch(/Max-Age=0/);

    // After logout: cookie no longer maps to a session — scoped endpoint → 401.
    const afterLogout = await fetch(`${app.engineUrl}/leads/00000000-0000-7000-8000-000000000010/dnc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieHeader,
      },
      body: JSON.stringify({ reason: 'after-logout' }),
    });
    expect(afterLogout.status).toBe(401);
  }, 30_000);

  it('After clock advances past TTL, cookie no longer authenticates', async () => {
    const { cookieHeader } = await login(app.engineUrl, 'frank', ['manager']);

    // Sanity check: cookie works before advancing the clock.
    const before = await fetch(`${app.engineUrl}/leads`, {
      method: 'GET',
      headers: { cookie: cookieHeader },
    });
    expect(before.status).toBe(200);

    // Advance the engine's virtual clock past the session TTL.
    const advance = await fetch(`${app.engineUrl}/_admin/clock/advance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ms: SESSION_TTL_MS + 1_000 }),
    });
    expect(advance.status).toBe(200);

    // Cookie no longer resolves to a live session — hitting a scoped endpoint → 401.
    const afterExpiry = await fetch(`${app.engineUrl}/leads/00000000-0000-7000-8000-000000000010/dnc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieHeader,
      },
      body: JSON.stringify({ reason: 'expired' }),
    });
    expect(afterExpiry.status).toBe(401);

    // Reset the clock so later tests in the file (none currently) still work.
    await fetch(`${app.engineUrl}/_admin/clock/reset`, { method: 'POST' });
  }, 30_000);

  it('Different sessions get different csrfTokens', async () => {
    const { body: a } = await login(app.engineUrl, 'gina', ['viewer']);
    const { body: b } = await login(app.engineUrl, 'hank', ['viewer']);
    expect(a.csrfToken).not.toBe(b.csrfToken);
    expect(a.sessionId).not.toBe(b.sessionId);
  }, 30_000);
});
