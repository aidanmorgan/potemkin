/**
 * 57 — Forward blocks (seeds / workflow / overlay) + JWT through the stub.
 *
 * Everything here is driven through `app.stubUrl` (the real Specmatic stub with
 * the Potemkin plugin on the classpath), proving the forward blocks reach the
 * client via Specmatic rather than only the engine:
 *
 *   Seeds — two seed variants (`base: contract` and `base: empty`) registered as
 *             Specmatic expectations; GET each through the stub returns the
 *             patched body.
 *   Workflow — `workflow.ids` propagate across a create→get sequence: the lead id
 *             created via the stub is captured and substituted into a later
 *             `/leads/{leadId}` request automatically.
 *   Overlay — the overlay flips GET /leads/{id} to `deprecated: true` in the
 *             served spec; the plugin surfaces that as a `Deprecation: true`
 *             response header.
 *   JWT — valid / expired / missing → 200 / 401 / 401 with a
 *             `WWW-Authenticate` challenge, all through the stub.
 *
 * The `crm-forward` fixture carries the auth block (via its dsl/global.yaml,
 * shared with crm-jwt) and the seeds/workflow/overlay/governance forward blocks
 * (via its potemkin.yaml). The harness translates the overlay to a Specmatic
 * overlay file and points Specmatic at it, and splices the auth + forward blocks
 * into the plugin's potemkin.yaml.
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

// --- JWT helpers (HS256), mirroring the fixture's auth config ---------------

const JWT_SECRET = 'potemkin-jwt-e2e-test-secret-do-not-use';
const ISSUER = 'potemkin-test';
const AUDIENCE = 'potemkin-api';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

interface JwtClaims {
  sub?: string;
  scopes?: string | string[];
  exp?: number;
  iat?: number;
  iss?: string;
  aud?: string;
  [k: string]: unknown;
}

function signHs256(claims: JwtClaims, secret = JWT_SECRET): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerEncoded = b64url(Buffer.from(JSON.stringify(header), 'utf8'));
  const payloadEncoded = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const signingInput = `${headerEncoded}.${payloadEncoded}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${b64url(signature)}`;
}

function defaultClaims(overrides: Partial<JwtClaims> = {}): JwtClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'mgr1',
    scopes: 'manager admin',
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describeWithJava('57 — Forward blocks + JWT through the stub', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({ fixtureName: 'crm-forward' });
    // Every assertion in this suite is driven through app.stubUrl to prove the
    // forward blocks reach the client via Specmatic. Fail fast in beforeAll if
    // stub→plugin→engine forwarding did not warm up healthy — never silently
    // skip or fall back to the engine.
    expect(app.stubForwardingHealthy).toBe(true);
  }, 180_000);

  afterAll(async () => {
    if (app) await app.shutdown();
  }, 30_000);

  // ---- Seeds ---------------------------------------------------------------

  it('seed with base:contract serves the patched body through the stub', async () => {
    const res = await fetch(`${app.stubUrl}/seed-contract/contract-1`, {
      headers: { Accept: 'application/json', authorization: `Bearer ${signHs256(defaultClaims())}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['origin']).toBe('CONTRACT_SEED');
    expect(body['label']).toBe('from-contract');
  }, 60_000);

  it('seed with base:empty serves the patched body through the stub', async () => {
    const res = await fetch(`${app.stubUrl}/seed-empty/empty-1`, {
      headers: { Accept: 'application/json', authorization: `Bearer ${signHs256(defaultClaims())}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['origin']).toBe('EMPTY_SEED');
    expect(body['label']).toBe('from-empty');
  }, 60_000);

  // ---- Workflow id-propagation --------------------------------------------

  it('workflow.ids propagate the created lead id into a later request', async () => {
    const auth = { authorization: `Bearer ${signHs256(defaultClaims())}` };

    // 1. Create a lead through the stub; the plugin captures its id under leadId.
    const createRes = await fetch(`${app.stubUrl}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        companyName: 'Workflow Corp',
        contactName: 'Workflow User',
        phone: '+61 2 9900 5701',
        email: 'workflow@g6.test',
        source: 'WEBSITE',
      }),
    });
    expect([200, 201]).toContain(createRes.status);
    const created = (await createRes.json()) as Record<string, unknown>;
    const createdId = created['id'];
    expect(typeof createdId).toBe('string');

    // 2. GET /leads/{leadId} — the placeholder resolves to the captured id, so
    //    the stub returns the lead just created (no id threaded by the caller).
    const getRes = await fetch(`${app.stubUrl}/leads/{leadId}`, {
      headers: { Accept: 'application/json', ...auth },
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as Record<string, unknown>;
    expect(fetched['id']).toBe(createdId);
    expect(fetched['companyName']).toBe('Workflow Corp');
  }, 60_000);

  // ---- Overlay deprecation ------------------------------------------------

  it('overlay deprecates GET /leads/{id}; the served response carries Deprecation: true', async () => {
    const auth = { authorization: `Bearer ${signHs256(defaultClaims())}` };

    // Create a lead so the GET has a real target.
    const createRes = await fetch(`${app.stubUrl}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        companyName: 'Deprecation Corp',
        contactName: 'Dep User',
        phone: '+61 2 9900 5702',
        email: 'dep@g6.test',
        source: 'PARTNER',
      }),
    });
    expect([200, 201]).toContain(createRes.status);
    const id = ((await createRes.json()) as Record<string, unknown>)['id'];

    const getRes = await fetch(`${app.stubUrl}/leads/${id}`, {
      headers: { Accept: 'application/json', ...auth },
    });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('deprecation')).toBe('true');
  }, 60_000);

  // ---- JWT through the stub -----------------------------------------------

  it('valid JWT → 200 through the stub', async () => {
    const res = await fetch(`${app.stubUrl}/leads`, {
      headers: { Accept: 'application/json', authorization: `Bearer ${signHs256(defaultClaims())}` },
    });
    expect(res.status).toBe(200);
  }, 60_000);

  it('expired JWT → 401 with WWW-Authenticate through the stub', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = signHs256(defaultClaims({ exp: past, iat: past - 3600 }));
    const res = await fetch(`${app.stubUrl}/leads`, {
      headers: { Accept: 'application/json', authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/i);
  }, 60_000);

  it('missing JWT → 401 with WWW-Authenticate through the stub', async () => {
    const res = await fetch(`${app.stubUrl}/leads`, {
      headers: { Accept: 'application/json' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/i);
  }, 60_000);
});
