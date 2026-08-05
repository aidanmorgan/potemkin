/**
 * JWT authentication parity through the real Specmatic -> plugin -> Potemkin
 * path. YAML, TypeScript, and mixed configurations use the same JWT policy,
 * protected boundary, actor identity, scope guard, and idempotency behavior.
 */

import { createHmac } from 'node:crypto';

import { requestThroughSpecmatic } from './_harness/crm-e2e-helpers';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';

const FIXTURE_ROOT = `${process.cwd()}/tests/fixtures/jwt-parity`;
const SECRET = 'potemkin-jwt-parity-secret';
const ISSUER = 'potemkin-jwt-parity';
const AUDIENCE = 'potemkin-jwt-api';

const MODES = [
  { name: 'YAML', config: 'potemkin-yaml.yml' },
  { name: 'TypeScript', config: 'potemkin-typescript.yml' },
  { name: 'YAML + TypeScript', config: 'potemkin-mixed.yml' },
] as const;

interface JwtClaims {
  readonly sub?: string;
  readonly scopes?: string | readonly string[];
  readonly iss?: string;
  readonly aud?: string;
  readonly exp?: number;
  readonly iat?: number;
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function token(claims: JwtClaims, secret: string = SECRET): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify(claims));
  const input = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${signature}`;
}

function validToken(overrides: JwtClaims = {}): string {
  const now = Math.floor(Date.now() / 1_000);
  return token({
    sub: 'jwt-parity-user',
    scopes: ['writer'],
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now,
    exp: now + 3_600,
    ...overrides,
  });
}

describe.each(MODES)('$name JWT authoring parity', (mode) => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: 'jwt-parity',
      potemkinConfigPath: `${FIXTURE_ROOT}/${mode.config}`,
      warmupPath: '/jwt-records/not-created',
      warmupExpectedStatus: 404,
    });
    expect(app.stubForwardingHealthy).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await app?.shutdown();
  }, 30_000);

  beforeEach(async () => {
    const reset = await fetch(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
    expect([200, 204]).toContain(reset.status);
  });

  it('accepts a scoped JWT, preserves its actor, and replays an idempotent request', async () => {
    const id = `${mode.name.toLowerCase().replaceAll(' ', '-')}-record`;
    const body = { id, value: 'jwt-parity' };
    const key = `jwt-parity-${mode.name}`;
    const headers = {
      authorization: `Bearer ${validToken()}`,
      'idempotency-key': key,
    };

    const created = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/jwt-records',
      body,
      headers,
    );
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id, value: body.value, status: 'CREATED' });
    expect(created.headers['x-idempotency-replay']).toBeUndefined();

    const events = await fetch(
      `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(id)}`,
    );
    expect(events.status).toBe(200);
    const eventBody = (await events.json()) as {
      events: readonly { request?: { actorId?: string }; type: string }[];
    };
    expect(eventBody.events).toEqual([
      expect.objectContaining({
        type: 'JwtRecordCreated',
        request: expect.objectContaining({ actorId: 'jwt-parity-user' }),
      }),
    ]);

    const replay = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/jwt-records',
      body,
      headers,
    );
    expect(replay.status).toBe(201);
    expect(replay.headers['x-idempotency-replay']).toBe('true');
    expect(replay.body).toEqual(created.body);

    const count = await fetch(`${app.engineUrl}/_admin/events?count=true`);
    expect(count.status).toBe(200);
    await expect(count.json()).resolves.toEqual({ count: 1 });
  }, 60_000);

  it('rejects invalid JWTs and missing scopes before behavior execution', async () => {
    const body = { id: `${mode.name}-rejected`, value: 'jwt-rejected' };
    const cases = [
      {
        name: 'wrong signature',
        authorization: `Bearer ${token(
          {
            sub: 'jwt-parity-user',
            scopes: ['writer'],
            iss: ISSUER,
            aud: AUDIENCE,
            exp: Math.floor(Date.now() / 1_000) + 3_600,
          },
          'wrong-secret',
        )}`,
        status: 401,
        code: 'JWT_INVALID_SIGNATURE',
      },
      {
        name: 'expired token',
        authorization: `Bearer ${validToken({ exp: Math.floor(Date.now() / 1_000) - 60 })}`,
        status: 401,
        code: 'JWT_EXPIRED',
      },
      {
        name: 'missing writer scope',
        authorization: `Bearer ${validToken({ scopes: ['reader'] })}`,
        status: 403,
        code: 'AUTHORIZATION_DENIED',
      },
    ] as const;

    for (const [index, candidate] of cases.entries()) {
      const response = await requestThroughSpecmatic(
        app.stubUrl,
        'POST',
        '/jwt-records',
        { ...body, id: `${body.id}-${index}` },
        {
          authorization: candidate.authorization,
          'x-potemkin-drop-connection': '5',
          'x-potemkin-force-status': '418',
          'x-potemkin-error-class': 'throttle',
        },
      );
      expect(response.status).toBe(candidate.status);
      expect(response.body).toEqual(
        expect.objectContaining({ details: expect.objectContaining({ code: candidate.code }) }),
      );
    }

    const count = await fetch(`${app.engineUrl}/_admin/events?count=true`);
    expect(count.status).toBe(200);
    await expect(count.json()).resolves.toEqual({ count: 0 });
  }, 60_000);

  it('does not commit or reserve idempotency state when an authenticated request drops', async () => {
    const id = `${mode.name.toLowerCase().replaceAll(' ', '-')}-dropped-record`;
    const body = { id, value: 'jwt-dropped' };
    const headers = {
      authorization: `Bearer ${validToken()}`,
      'idempotency-key': `jwt-dropped-${mode.name}`,
      'x-potemkin-drop-connection': '5',
    };

    const dropped = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/jwt-records',
      body,
      headers,
    );
    expect(dropped.status).toBe(504);
    expect(dropped.headers['x-potemkin-dropped']).toBe('true');
    expect(dropped.body).toBeNull();

    const afterDrop = await fetch(`${app.engineUrl}/_admin/events?count=true`);
    expect(afterDrop.status).toBe(200);
    await expect(afterDrop.json()).resolves.toEqual({ count: 0 });

    const healthyHeaders = {
      authorization: headers.authorization,
      'idempotency-key': headers['idempotency-key'],
    };
    const committed = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/jwt-records',
      body,
      healthyHeaders,
    );
    expect(committed.status).toBe(201);
    expect(committed.headers['x-idempotency-replay']).toBeUndefined();

    const replayed = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/jwt-records',
      body,
      healthyHeaders,
    );
    expect(replayed.status).toBe(201);
    expect(replayed.headers['x-idempotency-replay']).toBe('true');
    expect(replayed.body).toEqual(committed.body);

    const events = await fetch(`${app.engineUrl}/_admin/events?count=true`);
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toEqual({ count: 1 });
  }, 60_000);
});
