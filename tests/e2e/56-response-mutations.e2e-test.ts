/**
 * 56 — Response mutations reach the Specmatic-served response AND are
 * reproduced by the /_engine/forward _patches replay.
 *
 * Boots the `governance` fixture (Document boundary declares static hateoas:,
 * mask:, and deprecated: blocks; the OpenAPI permits _links and makes
 * internalNotes optional so the mutated body still validates against the
 * contract). Proves through the Specmatic stub URL that:
 *   - HATEOAS _links.self is injected into the served body;
 *   - the masked field (internalNotes) is REMOVED from the served body;
 *   - Deprecation + Sunset + successor-version Link headers are set on the
 *     deprecated getDocument response.
 *
 * Then proves the SAME effect via /_engine/forward: the response carries a
 * `_patches` envelope (hateoas + mask body patches) and the deprecation
 * headers, which the Kotlin PotemkinResponseInterceptor replays.
 */

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';

function javaAvailable(): boolean {
  try { execSync('java -version', { stdio: 'pipe' }); return true; } catch { return false; }
}

const describeWithJava = javaAvailable() ? describe : describe.skip;

interface DocLinks { self?: { href: string } }
interface DocumentState {
  id: string;
  title: string;
  status?: string;
  internalNotes?: string;
  _links?: DocLinks;
}

// Served-response tests target the Specmatic stub UNCONDITIONALLY — this suite
// proves the mutations reach the Specmatic-served response, so beforeAll
// asserts stub→plugin→engine forwarding is healthy (no engineUrl fallback). The
// separate _patches replay describe deliberately uses /_engine/forward directly.
function target(app: E2eApp): string {
  return app.stubUrl;
}

async function createDocViaStub(base: string, title: string): Promise<string> {
  const res = await fetch(`${base}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, internalNotes: 'classified' }),
  });
  expect([200, 201]).toContain(res.status);
  const body = (await res.json()) as DocumentState;
  expect(body.id).toBeTruthy();
  return body.id;
}

describeWithJava('56 — response mutations via Specmatic + _patches replay', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({ fixtureName: 'governance' });
    // Fail fast: this suite proves stub→plugin→engine forwarding.
    expect(app.stubForwardingHealthy).toBe(true);
  }, 120_000);
  afterAll(async () => { if (app) await app.shutdown(); }, 30_000);

  describe('Specmatic-served response carries the mutations', () => {
    it('POST /documents: _links.self is injected and internalNotes is masked away', async () => {
      const res = await fetch(`${target(app)}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Quarterly Report', internalNotes: 'eyes only' }),
      });
      expect([200, 201]).toContain(res.status);
      const body = (await res.json()) as DocumentState;

      // HATEOAS self link present in the served body.
      expect(body._links?.self?.href).toBe('/documents');
      // The masked field has been REMOVED from the served body.
      expect(body.internalNotes).toBeUndefined();
      expect(body.title).toBe('Quarterly Report');
    }, 60_000);

    it('GET /documents/{id}: mask + HATEOAS apply and Deprecation/Sunset/Link headers are set', async () => {
      const id = await createDocViaStub(target(app), 'Doc With Headers');

      const res = await fetch(`${target(app)}/documents/${id}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      expect(res.status).toBe(200);

      // Deprecation headers on the served response.
      expect(res.headers.get('deprecation')).toBe('true');
      expect(res.headers.get('sunset')).toBe('2027-01-01T00:00:00Z');
      const link = res.headers.get('link');
      expect(link).toContain('/v2/documents');
      expect(link).toContain('rel="successor-version"');

      const body = (await res.json()) as DocumentState;
      expect(body._links?.self?.href).toBe('/documents');
      expect(body.internalNotes).toBeUndefined();
    }, 60_000);
  });

  describe('/_engine/forward reproduces the same effect via _patches + headers', () => {
    it('GET /documents/{id} forward returns _patches (hateoas+mask) and deprecation headers', async () => {
      const id = await createDocViaStub(target(app), 'Forward Doc');

      const res = await fetch(`${app.engineUrl}/_engine/forward`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'GET', path: `/documents/${id}`, headers: {}, query: {}, body: null }),
      });
      const fwd = (await res.json()) as {
        status: number;
        body: DocumentState;
        headers: Record<string, string>;
        _patches?: Array<{ op: string; path: string; source?: string }>;
      };

      expect(fwd.status).toBe(200);

      // The forward response returns the RAW body plus a `_patches` envelope:
      // the plugin's PotemkinResponseInterceptor re-applies those patches to the
      // Specmatic-served body to reach the same mutated shape. So the
      // un-patched body still carries internalNotes and has no _links yet.
      expect(fwd.body.internalNotes).toBeDefined();
      expect(fwd.body._links).toBeUndefined();

      // _patches envelope present and carries the hateoas merge + mask remove —
      // applying them reproduces the same effect as the served response.
      expect(Array.isArray(fwd._patches)).toBe(true);
      const ops = (fwd._patches ?? []).map((p) => `${p.op} ${p.path}`);
      expect(ops.some((o) => o.includes('/_links'))).toBe(true);
      expect(ops.some((o) => o.includes('/internalNotes'))).toBe(true);

      // Deprecation headers travel as response headers (not body patches).
      const headerKeys = Object.keys(fwd.headers).map((k) => k.toLowerCase());
      expect(headerKeys).toContain('deprecation');
      expect(headerKeys).toContain('sunset');
      expect(headerKeys).toContain('link');
    }, 60_000);
  });
});
