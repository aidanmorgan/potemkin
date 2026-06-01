/**
 * CORS credentialed-request tests
 *
 * Verifies:
 *  1. Non-credentialed requests get '*' (default behaviour, unbroken).
 *  2. Credentialed requests (Authorization header) get the specific reflected
 *     Origin and Access-Control-Allow-Credentials: true.
 *  3. Credentialed preflight (OPTIONS + Authorization) also reflects Origin
 *     and sets Allow-Credentials.
 *  4. Cookie-carrying requests are also treated as credentialed.
 */

import { createGateway } from '../../../src/http/gateway.js';
import { bootSystem, type BootedSystem } from '../../../src/engine/boot.js';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { compileDsl } from '../../../src/dsl/parser.js';
import { resetSystem } from '../../../src/engine/reset.js';
import {
  withPersistentServer,
  type PersistentAgent,
  type PersistentServer,
} from '../../_support/persistentAgent.js';

// ── Minimal fixture ───────────────────────────────────────────────────────────

const MINIMAL_OPENAPI = `
openapi: "3.0.3"
info:
  title: CORS Test
  version: "1.0.0"
paths:
  /items:
    get:
      operationId: listItems
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Item"
components:
  schemas:
    Item:
      type: object
      properties:
        id:
          type: string
`;

const ITEM_DSL = `
boundary: Item
contract_path: /items
fallback_override: true
event_catalog: []
behaviors: []
reducers: []
`;

describe('gateway — CORS credentialed requests', () => {
  let sys: BootedSystem;
  let agent: PersistentAgent;
  let persistent: PersistentServer;

  beforeAll(async () => {
    const openapi = await loadOpenApi(MINIMAL_OPENAPI);
    sys = await bootSystem({
      openapi,
      compiledDsl: await compileDsl([{ name: 'item', yaml: ITEM_DSL }]),
    });
    persistent = await withPersistentServer(createGateway(sys));
    agent = persistent.agent;
  });

  afterAll(async () => {
    await persistent.close();
  });

  afterEach(() => {
    resetSystem(sys);
    // Restore any env changes
    delete process.env['ALLOWED_ORIGINS'];
  });

  // ── Non-credentialed request — should still get '*' ───────────────────────

  it('non-credentialed request gets wildcard Access-Control-Allow-Origin', async () => {
    const res = await agent
      .get('/items')
      .set('Origin', 'https://example.com')
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  // ── Authorization header → credentialed ──────────────────────────────────

  it('request with Authorization header gets reflected Origin instead of *', async () => {
    const res = await agent
      .get('/items')
      .set('Origin', 'https://app.example.com')
      .set('Authorization', 'Bearer alice:reader')
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('credentialed request without an Origin header does not set Allow-Credentials', async () => {
    // No Origin header: browser cross-origin logic does not apply; no reflected origin needed.
    const res = await agent
      .get('/items')
      .set('Authorization', 'Bearer alice:reader')
      .expect(200);

    // No Origin → no reflected origin / no Allow-Credentials
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  // ── Cookie header → credentialed ─────────────────────────────────────────

  it('request with Cookie header gets reflected Origin and Allow-Credentials', async () => {
    const res = await agent
      .get('/items')
      .set('Origin', 'https://portal.example.com')
      .set('Cookie', 'sid=abc123')
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBe('https://portal.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  // ── OPTIONS preflight — credentialed ─────────────────────────────────────

  it('credentialed OPTIONS preflight gets reflected Origin and Allow-Credentials', async () => {
    const res = await agent
      .options('/items')
      .set('Origin', 'https://preflight.example.com')
      .set('Authorization', 'Bearer alice:reader')
      .expect(204);

    expect(res.headers['access-control-allow-origin']).toBe('https://preflight.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('non-credentialed OPTIONS preflight still gets wildcard origin', async () => {
    const res = await agent
      .options('/items')
      .set('Origin', 'https://preflight.example.com')
      .expect(204);

    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  // ── Restricted ALLOWED_ORIGINS allowlist — credentialed requests ──────────

  it('credentialed request from an admitted origin is reflected with Allow-Credentials when allowlist is restricted', async () => {
    process.env['ALLOWED_ORIGINS'] = 'https://app.com';

    const res = await agent
      .get('/items')
      .set('Origin', 'https://app.com')
      .set('Authorization', 'Bearer alice:reader')
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBe('https://app.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('credentialed request from a non-admitted origin is NOT reflected and gets NO Allow-Credentials when allowlist is restricted', async () => {
    process.env['ALLOWED_ORIGINS'] = 'https://app.com';

    const res = await agent
      .get('/items')
      .set('Origin', 'https://evil.com')
      .set('Authorization', 'Bearer alice:reader')
      .expect(200);

    // The non-admitted origin must not be reflected; fallback to configured first entry.
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.com');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('credentialed OPTIONS preflight from an admitted origin is reflected with Allow-Credentials when allowlist is restricted', async () => {
    process.env['ALLOWED_ORIGINS'] = 'https://app.com';

    const res = await agent
      .options('/items')
      .set('Origin', 'https://app.com')
      .set('Authorization', 'Bearer alice:reader')
      .expect(204);

    expect(res.headers['access-control-allow-origin']).toBe('https://app.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('credentialed OPTIONS preflight from a non-admitted origin is NOT reflected and gets NO Allow-Credentials when allowlist is restricted', async () => {
    process.env['ALLOWED_ORIGINS'] = 'https://app.com';

    const res = await agent
      .options('/items')
      .set('Origin', 'https://evil.com')
      .set('Authorization', 'Bearer alice:reader')
      .expect(204);

    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.com');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  // ── Access-Control-Allow-Headers includes browser-sent custom headers ────────

  it('OPTIONS preflight includes Authorization in Access-Control-Allow-Headers', async () => {
    const res = await agent
      .options('/items')
      .set('Origin', 'https://browser.example.com')
      .expect(204);

    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
  });

  it('OPTIONS preflight includes Idempotency-Key in Access-Control-Allow-Headers', async () => {
    const res = await agent
      .options('/items')
      .set('Origin', 'https://browser.example.com')
      .expect(204);

    expect(res.headers['access-control-allow-headers']).toContain('Idempotency-Key');
  });

  it('GET response includes Authorization and Idempotency-Key in Access-Control-Allow-Headers', async () => {
    const res = await agent
      .get('/items')
      .set('Origin', 'https://browser.example.com')
      .expect(200);

    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    expect(res.headers['access-control-allow-headers']).toContain('Idempotency-Key');
  });

  // ── X-Potemkin-* simulation-control headers in OPTIONS preflight (potemkin-hqgo) ──

  it('OPTIONS preflight includes representative X-Potemkin-* request headers in Access-Control-Allow-Headers', async () => {
    const res = await agent
      .options('/items')
      .set('Origin', 'https://browser.example.com')
      .expect(204);

    const allowHeaders = res.headers['access-control-allow-headers'] as string;
    expect(allowHeaders).toContain('x-potemkin-dry-run');
    expect(allowHeaders).toContain('x-potemkin-seed');
    expect(allowHeaders).toContain('x-potemkin-actor');
    expect(allowHeaders).toContain('x-potemkin-read-at-version');
  });

  it('GET response includes representative X-Potemkin-* request headers in Access-Control-Allow-Headers', async () => {
    const res = await agent
      .get('/items')
      .set('Origin', 'https://browser.example.com')
      .expect(200);

    const allowHeaders = res.headers['access-control-allow-headers'] as string;
    expect(allowHeaders).toContain('x-potemkin-dry-run');
    expect(allowHeaders).toContain('x-potemkin-seed');
    expect(allowHeaders).toContain('x-potemkin-actor');
    expect(allowHeaders).toContain('x-potemkin-read-at-version');
  });

  it('OPTIONS preflight does not include x-potemkin-signature (outbound-only, not a client header)', async () => {
    const res = await agent
      .options('/items')
      .set('Origin', 'https://browser.example.com')
      .expect(204);

    expect(res.headers['access-control-allow-headers']).not.toContain('x-potemkin-signature');
  });
});
