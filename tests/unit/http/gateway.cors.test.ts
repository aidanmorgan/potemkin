/**
 * CORS credentialed-request tests (potemkin-yq1l)
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

describe('gateway — CORS credentialed requests (potemkin-yq1l)', () => {
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
});
