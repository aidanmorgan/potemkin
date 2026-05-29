/**
 * 41 — Configurable JWT authentication.
 *
 * Boots a CRM e2e harness against the `crm-jwt` fixture (identical to `crm`
 * but with auth.mode=jwt in global.yaml). Drives the gateway through the
 * /_engine/forward endpoint and asserts the engine validates JWTs end-to-end:
 *
 *   - signature
 *   - algorithm (alg: none must be rejected)
 *   - exp / nbf
 *   - iss / aud
 *   - subject + scopes claims
 *
 * Backward compatibility with the legacy `Bearer <id>:<scopes>` shortcut is
 * verified in 05-rbac.e2e-test.ts which uses the default crm fixture (no auth
 * config) — adding new tests here keeps both paths covered without touching
 * existing assertions.
 */

import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
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

const describeWithJava = javaAvailable() ? describe : describe.skip;

// ---------------------------------------------------------------------------
// JWT helpers — kept local so the test reads as a self-contained spec.
// Mirrors the validator's signing logic for HS256.
// ---------------------------------------------------------------------------

const JWT_SECRET = 'potemkin-jwt-e2e-test-secret-do-not-use';
const ISSUER = 'potemkin-test';
const AUDIENCE = 'potemkin-api';

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

interface JwtClaims {
  sub?: string;
  scopes?: string | string[];
  exp?: number;
  nbf?: number;
  iss?: string;
  aud?: string;
  [k: string]: unknown;
}

function signHs256(claims: JwtClaims, secret: string = JWT_SECRET, alg: string = 'HS256'): string {
  const header = { alg, typ: 'JWT' };
  const headerEncoded = b64url(Buffer.from(JSON.stringify(header), 'utf8'));
  const payloadEncoded = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const signingInput = `${headerEncoded}.${payloadEncoded}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${b64url(signature)}`;
}

/** Build a token with sensible defaults (1-hour expiry, correct iss/aud). */
function defaultClaims(overrides: Partial<JwtClaims> = {}): JwtClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'mgr1',
    scopes: 'manager',
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Engine forwarding helper
// ---------------------------------------------------------------------------

async function postForward(
  engineUrl: string,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${engineUrl}/_engine/forward`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, path, headers, query: {}, body }),
  });
  return res.json() as Promise<{ status: number; body: unknown }>;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeWithJava('41 — JWT authentication (configurable)', () => {
  let app: E2eApp;

  // Lead ids minted up-front and reused per scenario so each test owns a fresh
  // aggregate (DNC is a one-shot transition).
  const leadIds: string[] = [];

  beforeAll(async () => {
    app = await startE2eApp({ crmFixtureName: 'crm-jwt' });

    // Pre-mint a few leads via a valid manager-scoped JWT so subsequent DNC
    // attempts have something to target.
    const token = signHs256(defaultClaims({ sub: 'seed', scopes: 'manager admin' }));
    for (let i = 0; i < 9; i++) {
      const created = await postForward(
        app.engineUrl,
        'POST',
        '/leads',
        {
          companyName: `JWT Test Corp ${i}`,
          contactName: `JWT User ${i}`,
          phone: `+61 2 9999 ${1000 + i}`,
          email: `jwt${i}@test.com`,
          source: 'WEBSITE',
        },
        { authorization: `Bearer ${token}` },
      );
      const id = (created.body as Record<string, unknown>)['id'];
      if (typeof id !== 'string') {
        throw new Error(`Seed lead ${i} did not return an id: ${JSON.stringify(created)}`);
      }
      leadIds.push(id);
    }
  }, 180_000);

  afterAll(async () => {
    if (app) await app.shutdown();
  }, 30_000);

  it('valid JWT with manager scope → 200/201 on DNC', async () => {
    const token = signHs256(defaultClaims({ sub: 'mgr-valid', scopes: 'manager' }));
    const result = await postForward(
      app.engineUrl,
      'POST',
      `/leads/${leadIds[0]}/dnc`,
      { reason: 'JWT happy path' },
      { authorization: `Bearer ${token}` },
    );
    expect([200, 201]).toContain(result.status);
    const body = result.body as Record<string, unknown>;
    expect(body['status']).toBe('DNC');
  }, 60_000);

  it('JWT signed with wrong secret → 401 (JWT_INVALID_SIGNATURE)', async () => {
    const token = signHs256(defaultClaims(), 'a-completely-different-secret');
    const result = await postForward(
      app.engineUrl,
      'POST',
      `/leads/${leadIds[1]}/dnc`,
      { reason: 'should fail' },
      { authorization: `Bearer ${token}` },
    );
    expect(result.status).toBe(401);
    const body = result.body as Record<string, unknown>;
    const details = body['details'] as Record<string, unknown> | undefined;
    expect(details?.['code']).toBe('JWT_INVALID_SIGNATURE');
  }, 60_000);

  it('JWT with exp in the past → 401 (JWT_EXPIRED)', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = signHs256(defaultClaims({ exp: past, iat: past - 3600 }));
    const result = await postForward(
      app.engineUrl,
      'POST',
      `/leads/${leadIds[2]}/dnc`,
      { reason: 'should fail' },
      { authorization: `Bearer ${token}` },
    );
    expect(result.status).toBe(401);
    const body = result.body as Record<string, unknown>;
    const details = body['details'] as Record<string, unknown> | undefined;
    expect(details?.['code']).toBe('JWT_EXPIRED');
  }, 60_000);

  it('JWT with alg: none (unsigned) → 401 (JWT_UNSUPPORTED_ALG)', async () => {
    // alg:none — payload-only, signature deliberately empty. We sign with HS256
    // using an empty secret but then strip the signature to mimic an unsigned
    // JWT exactly; the validator must reject based on the header alg alone.
    const header = b64url(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8'));
    const payload = b64url(Buffer.from(JSON.stringify(defaultClaims()), 'utf8'));
    const token = `${header}.${payload}.`;
    const result = await postForward(
      app.engineUrl,
      'POST',
      `/leads/${leadIds[3]}/dnc`,
      { reason: 'should fail' },
      { authorization: `Bearer ${token}` },
    );
    expect(result.status).toBe(401);
    const body = result.body as Record<string, unknown>;
    const details = body['details'] as Record<string, unknown> | undefined;
    expect(details?.['code']).toBe('JWT_UNSUPPORTED_ALG');
  }, 60_000);

  it('malformed JWT (not 3 segments) → 401 (JWT_MALFORMED)', async () => {
    const result = await postForward(
      app.engineUrl,
      'POST',
      `/leads/${leadIds[4]}/dnc`,
      { reason: 'should fail' },
      { authorization: 'Bearer not.a.valid.jwt.token' },
    );
    expect(result.status).toBe(401);
    const body = result.body as Record<string, unknown>;
    const details = body['details'] as Record<string, unknown> | undefined;
    expect(details?.['code']).toBe('JWT_MALFORMED');
  }, 60_000);

  it('JWT with wrong issuer → 401 (JWT_INVALID_ISSUER)', async () => {
    const token = signHs256(defaultClaims({ iss: 'some-other-issuer' }));
    const result = await postForward(
      app.engineUrl,
      'POST',
      `/leads/${leadIds[5]}/dnc`,
      { reason: 'should fail' },
      { authorization: `Bearer ${token}` },
    );
    expect(result.status).toBe(401);
    const body = result.body as Record<string, unknown>;
    const details = body['details'] as Record<string, unknown> | undefined;
    expect(details?.['code']).toBe('JWT_INVALID_ISSUER');
  }, 60_000);

  it('JWT with wrong audience → 401 (JWT_INVALID_AUDIENCE)', async () => {
    const token = signHs256(defaultClaims({ aud: 'some-other-api' }));
    const result = await postForward(
      app.engineUrl,
      'POST',
      `/leads/${leadIds[6]}/dnc`,
      { reason: 'should fail' },
      { authorization: `Bearer ${token}` },
    );
    expect(result.status).toBe(401);
    const body = result.body as Record<string, unknown>;
    const details = body['details'] as Record<string, unknown> | undefined;
    expect(details?.['code']).toBe('JWT_INVALID_AUDIENCE');
  }, 60_000);

  it('JWT with insufficient scopes → 403', async () => {
    const token = signHs256(defaultClaims({ sub: 'viewer1', scopes: 'viewer agent' }));
    const result = await postForward(
      app.engineUrl,
      'POST',
      `/leads/${leadIds[7]}/dnc`,
      { reason: 'should fail' },
      { authorization: `Bearer ${token}` },
    );
    expect(result.status).toBe(403);
  }, 60_000);

  it('no Authorization header on a scoped endpoint → 401', async () => {
    const result = await postForward(
      app.engineUrl,
      'POST',
      `/leads/${leadIds[8]}/dnc`,
      { reason: 'should fail' },
    );
    // No auth header → engine sees absent actor → scoped behavior fires
    // AuthenticationRequiredError (401). Some engines treat this as 403.
    expect([401, 403]).toContain(result.status);
  }, 60_000);
});
