/**
 * Session-auth parity through one shared Specmatic JVM.
 *
 * The YAML, direct TypeScript, and mixed configurations all expose the same
 * session policy and record mutation. Business traffic always goes through
 * Specmatic; the engine URL is used only for the administrative clock/reset
 * controls needed to make the cases deterministic.
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/crm-e2e-helpers';

const MODES = [
  { name: 'YAML', config: 'potemkin-yaml.yml' },
  { name: 'TypeScript', config: 'potemkin-typescript.yml' },
  { name: 'YAML + TypeScript', config: 'potemkin-mixed.yml' },
] as const;

const FIXTURE_ROOT = `${process.cwd()}/tests/fixtures/session-parity`;
const COOKIE_NAME = 'parity_sid';
const CSRF_HEADER = 'x-parity-csrf';
const SESSION_TTL_MS = 3_600_000;

interface LoginBody {
  readonly sessionId: string;
  readonly csrfToken: string;
  readonly actor: { readonly id: string; readonly scopes: readonly string[] };
  readonly expiresAt: string;
}

function cookieValue(setCookie: string | null): string {
  expect(setCookie).not.toBeNull();
  const pair = setCookie!.split(';', 1)[0]!;
  const separator = pair.indexOf('=');
  expect(separator).toBeGreaterThan(0);
  expect(pair.slice(0, separator)).toBe(COOKIE_NAME);
  return pair.slice(separator + 1);
}

async function login(
  stubUrl: string,
  actorId: string,
  scopes: readonly string[],
): Promise<{ readonly cookie: string; readonly body: LoginBody }> {
  const response = await fetch(`${stubUrl}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actorId, scopes }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as LoginBody;
  return {
    cookie: `${COOKIE_NAME}=${cookieValue(response.headers.get('set-cookie'))}`,
    body,
  };
}

async function reset(app: E2eApp): Promise<void> {
  const response = await fetch(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
  expect([200, 204]).toContain(response.status);
}

async function createRecord(
  stubUrl: string,
  id: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetch(`${stubUrl}/records`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ id, value: 'session-parity' }),
  });
}

describe.each(MODES)('$name session authoring parity', (mode) => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: 'session-parity',
      potemkinConfigPath: `${FIXTURE_ROOT}/${mode.config}`,
      warmupPath: '/records/missing',
      warmupExpectedStatus: 404,
    });
    expect(app.stubForwardingHealthy).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await app?.shutdown();
  }, 30_000);

  beforeEach(async () => {
    await reset(app);
  });

  it('creates and reads a record through a session cookie and CSRF token', async () => {
    const prefix = mode.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const session = await login(app.stubUrl, `${mode.name}-writer`, ['writer']);
    expect(session.body.actor).toEqual({
      id: `${mode.name}-writer`,
      scopes: ['writer'],
    });
    expect(session.body.csrfToken).toEqual(expect.any(String));
    expect(session.body.expiresAt).toEqual(expect.any(String));

    const created = await createRecord(app.stubUrl, `${prefix}-record`, {
      cookie: session.cookie,
      [CSRF_HEADER]: session.body.csrfToken,
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toEqual({
      id: `${prefix}-record`,
      value: 'session-parity',
      status: 'CREATED',
    });

    const readPath = `${app.stubUrl}/records/${prefix}-record`;
    const readResponse = await fetch(readPath);
    const readResponseBody = await readResponse.json();
    expect(readResponse.status).toBe(200);
    expect(readResponseBody).toEqual({
      id: `${prefix}-record`,
      value: 'session-parity',
      status: 'CREATED',
    });
  }, 60_000);

  it('rejects a mutation without a session cookie', async () => {
    const response = await createRecord(app.stubUrl, `${mode.name}-unauthenticated`);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: 'AUTHENTICATION_REQUIRED' }),
    );
  }, 60_000);

  it('rejects a session mutation without the matching CSRF token', async () => {
    const session = await login(app.stubUrl, `${mode.name}-csrf`, ['writer']);
    const response = await createRecord(app.stubUrl, `${mode.name}-missing-csrf`, {
      cookie: session.cookie,
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: 'CSRF_TOKEN_INVALID' }),
    );
  }, 60_000);

  it('keeps authentication and authorization distinct', async () => {
    const session = await login(app.stubUrl, `${mode.name}-reader`, ['reader']);
    const response = await createRecord(app.stubUrl, `${mode.name}-wrong-scope`, {
      cookie: session.cookie,
      [CSRF_HEADER]: session.body.csrfToken,
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: 'AUTHORIZATION_DENIED' }),
    );
  }, 60_000);

  it('applies session and CSRF authentication before a competing dynamic fault', async () => {
    const session = await login(app.stubUrl, `${mode.name}-fault`, ['writer']);
    const faultName = `${mode.name.toLowerCase().replaceAll(' ', '-')}-session-fault`;
    const registration = await fetch(`${app.engineUrl}/_admin/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: faultName,
        match: { operationId: 'createRecord' },
        response: {
          status: 503,
          body: { code: 'SESSION_DYNAMIC_FAULT', message: 'session fault' },
        },
        ttlMs: SESSION_TTL_MS,
      }),
    });
    expect(registration.status).toBe(201);
    const faultId = ((await registration.json()) as { id: string }).id;

    const blocked = await createRecord(app.stubUrl, `${mode.name}-faulted`, {
      cookie: session.cookie,
      [CSRF_HEADER]: session.body.csrfToken,
      'x-potemkin-use-fault': faultName,
      'x-potemkin-force-status': '418',
      'x-potemkin-error-class': 'throttle',
      'x-potemkin-rate-limit': 'true',
      'x-potemkin-success-rate': '0',
      'x-potemkin-drop-connection': '0',
    });
    expect(blocked.status).toBe(503);
    await expect(blocked.json()).resolves.toEqual({
      code: 'SESSION_DYNAMIC_FAULT',
      message: 'session fault',
    });

    const events = await fetch(`${app.engineUrl}/_admin/events?count=true`);
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toEqual({ count: 0 });

    const removed = await fetch(`${app.engineUrl}/_admin/faults/${encodeURIComponent(faultId)}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(204);

    const recovered = await createRecord(app.stubUrl, `${mode.name}-recovered`, {
      cookie: session.cookie,
      [CSRF_HEADER]: session.body.csrfToken,
    });
    expect(recovered.status).toBe(201);
  }, 60_000);

  it('keeps authenticated fault, drop, and idempotency decisions source-independent', async () => {
    const session = await login(app.stubUrl, `${mode.name}-cross-product`, ['writer']);
    const id = `${mode.name.toLowerCase().replaceAll(' ', '-')}-cross-product`;
    const body = { id, value: 'session-cross-product' };
    const key = `session-cross-product-${mode.name}`;
    const faultName = `${mode.name.toLowerCase().replaceAll(' ', '-')}-cross-product-fault`;
    const registration = await fetch(`${app.engineUrl}/_admin/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: faultName,
        match: { operationId: 'createRecord' },
        response: {
          status: 503,
          body: { code: 'SESSION_CROSS_PRODUCT_FAULT' },
          headers: { 'x-session-fault': 'true' },
        },
        ttlMs: SESSION_TTL_MS,
      }),
    });
    expect(registration.status).toBe(201);
    const faultId = ((await registration.json()) as { id: string }).id;
    const authenticatedHeaders = {
      cookie: session.cookie,
      [CSRF_HEADER]: session.body.csrfToken,
      'idempotency-key': key,
    };

    const faulted = await requestThroughSpecmatic(app.stubUrl, 'POST', '/records', body, {
      ...authenticatedHeaders,
      'x-potemkin-use-fault': faultName,
      'x-potemkin-force-status': '418',
      'x-potemkin-error-class': 'throttle',
      'x-potemkin-rate-limit': 'true',
      'x-potemkin-success-rate': '0',
      'x-potemkin-drop-connection': '5',
    });
    expect(faulted.status).toBe(503);
    expect(faulted.body).toEqual({ code: 'SESSION_CROSS_PRODUCT_FAULT' });
    expect(faulted.headers['x-session-fault']).toBe('true');

    const removed = await fetch(`${app.engineUrl}/_admin/faults/${encodeURIComponent(faultId)}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(204);

    const dropped = await requestThroughSpecmatic(app.stubUrl, 'POST', '/records', body, {
      ...authenticatedHeaders,
      'x-potemkin-drop-connection': '5',
    });
    expect(dropped.status).toBe(504);
    expect(dropped.headers['x-potemkin-dropped']).toBe('true');
    // This session contract has no 504 response schema, so Specmatic keeps
    // the transport's null synthetic body as null for this forwarding path.
    expect(dropped.body).toBeNull();

    const noEventsAfterFailure = await fetch(`${app.engineUrl}/_admin/events?count=true`);
    expect(noEventsAfterFailure.status).toBe(200);
    await expect(noEventsAfterFailure.json()).resolves.toEqual({ count: 0 });

    const committed = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/records',
      body,
      authenticatedHeaders,
    );
    expect(committed.status).toBe(201);
    expect(committed.headers['x-idempotency-replay']).toBeUndefined();
    expect(committed.body).toEqual({ id, value: body.value, status: 'CREATED' });

    const replayed = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/records',
      body,
      authenticatedHeaders,
    );
    expect(replayed.status).toBe(201);
    expect(replayed.headers['x-idempotency-replay']).toBe('true');
    expect(replayed.body).toEqual(committed.body);

    const events = await fetch(`${app.engineUrl}/_admin/events?count=true`);
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toEqual({ count: 1 });
  }, 60_000);

  it('destroys the session on logout', async () => {
    const session = await login(app.stubUrl, `${mode.name}-logout`, ['writer']);
    const logout = await fetch(`${app.stubUrl}/sessions/current`, {
      method: 'DELETE',
      headers: { cookie: session.cookie },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toMatch(/Max-Age=0/);

    const afterLogout = await createRecord(app.stubUrl, `${mode.name}-after-logout`, {
      cookie: session.cookie,
      [CSRF_HEADER]: session.body.csrfToken,
    });
    expect(afterLogout.status).toBe(401);
  }, 60_000);

  it('expires sessions from the virtual clock', async () => {
    const session = await login(app.stubUrl, `${mode.name}-expiry`, ['writer']);
    const beforeExpiry = await createRecord(app.stubUrl, `${mode.name}-before-expiry`, {
      cookie: session.cookie,
      [CSRF_HEADER]: session.body.csrfToken,
    });
    expect(beforeExpiry.status).toBe(201);

    const advance = await fetch(`${app.engineUrl}/_admin/clock/advance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ms: SESSION_TTL_MS + 1 }),
    });
    expect(advance.status).toBe(200);

    const afterExpiry = await createRecord(app.stubUrl, `${mode.name}-after-expiry`, {
      cookie: session.cookie,
      [CSRF_HEADER]: session.body.csrfToken,
    });
    expect(afterExpiry.status).toBe(401);
  }, 60_000);

  it('isolates concurrent request-local session expiry decisions', async () => {
    const session = await login(app.stubUrl, `${mode.name}-concurrent-expiry`, ['writer']);
    const headers = {
      cookie: session.cookie,
      [CSRF_HEADER]: session.body.csrfToken,
    };
    const [future, historical] = await Promise.all([
      createRecord(app.stubUrl, `${mode.name}-future-expired`, {
        ...headers,
        'x-potemkin-clock-offset': String(SESSION_TTL_MS + 1),
      }),
      createRecord(app.stubUrl, `${mode.name}-historical-valid`, {
        ...headers,
        'x-potemkin-clock-offset': String(-(SESSION_TTL_MS + 1)),
      }),
    ]);

    expect(future.status).toBe(401);
    expect(historical.status).toBe(201);

    const normal = await createRecord(app.stubUrl, `${mode.name}-normal-valid`, headers);
    expect(normal.status).toBe(201);
  }, 60_000);

  it('resets the virtual clock and invalidates live sessions', async () => {
    const session = await login(app.stubUrl, `${mode.name}-reset`, ['writer']);
    const advance = await fetch(`${app.engineUrl}/_admin/clock/advance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ms: 7_000 }),
    });
    expect(advance.status).toBe(200);

    await reset(app);

    const afterResetClock = await fetch(`${app.engineUrl}/_admin/clock/advance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ms: 1 }),
    });
    expect(afterResetClock.status).toBe(200);
    await expect(afterResetClock.json()).resolves.toEqual({ offsetMs: 1 });

    const afterReset = await createRecord(app.stubUrl, `${mode.name}-after-reset`, {
      cookie: session.cookie,
      [CSRF_HEADER]: session.body.csrfToken,
    });
    expect(afterReset.status).toBe(401);
  }, 60_000);
});
