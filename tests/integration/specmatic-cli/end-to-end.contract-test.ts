/**
 * end-to-end.contract-test.ts
 *
 * Goal: Full lifecycle — stub registration, stub verification, clear, CQRS
 * fallback, and Specmatic CLI contract-test pass all in one test suite.
 *
 * Test sequence:
 *  1. Boot engine on a random free port.
 *  2. POST a Specmatic-format expectation for GET /customers/cust-e2e-1.
 *  3. Verify the stub is returned on GET /customers/cust-e2e-1.
 *  4. Clear all expectations via DELETE /_specmatic/expectations.
 *  5. Verify the path now 404s (CQRS fallback for unknown entity).
 *  6. [Java required] Run `specmatic test` against the engine;
 *     assert exit code 0 with no FAILED lines.
 *
 * Java requirement for step 6:
 *  If `java` is not on PATH, step 6 is skipped gracefully.
 *  Steps 1–5 run regardless of Java availability.
 */

import * as http from 'node:http';
import * as path from 'node:path';
import type { Server } from 'node:http';

import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';
import {
  javaAvailable,
  ensureSpecmaticJar,
  runSpecmatic,
} from './_helpers/specmatic-binary.js';

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function httpRequest(opts: {
  method: string;
  host: string;
  port: number;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const reqHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...opts.headers,
    };
    if (bodyStr !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }

    const req = http.request(
      {
        method: opts.method,
        host: opts.host,
        port: opts.port,
        path: opts.path,
        headers: reqHeaders,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          let parsed: unknown = data;
          try { parsed = JSON.parse(data); } catch { /* not JSON */ }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body: parsed,
          });
        });
      },
    );

    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Engine helpers
// ---------------------------------------------------------------------------

async function startEngine(): Promise<{ server: Server; port: number }> {
  const fixture = await loadBankingFixture();
  const sys = await bootSystem(fixture);
  const app = createGateway(sys);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr !== 'object') {
        reject(new Error('Could not determine server address'));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.on('error', reject);
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('end-to-end: full stub lifecycle + Specmatic CLI contract test', () => {
  let server: Server;
  let port: number;
  let hasJava: boolean;

  beforeAll(async () => {
    ({ server, port } = await startEngine());
    hasJava = await javaAvailable();

    if (!hasJava) {
      console.warn('\n[end-to-end] Java not found; step 6 (specmatic test) will be skipped\n');
    } else {
      try {
        await ensureSpecmaticJar();
      } catch (err) {
        console.warn(`\n[end-to-end] Could not download Specmatic jar: ${String(err)}\n`);
        hasJava = false;
      }
    }
  }, 120_000);

  afterAll(async () => {
    if (server) await stopServer(server);
  });

  // ── Step 2: Register stub ─────────────────────────────────────────────────

  it('step 2: POST /_specmatic/expectations registers a stub in Specmatic wire format', async () => {
    const res = await httpRequest({
      method: 'POST',
      host: '127.0.0.1',
      port,
      path: '/_specmatic/expectations',
      body: {
        'http-request': { method: 'GET', path: '/customers/cust-e2e-1' },
        'http-response': {
          status: 200,
          body: { id: 'cust-e2e-1', name: 'E2E Customer', riskBand: 'LOW' },
        },
      },
    });

    expect(res.status).toBe(200);
    expect(typeof (res.body as Record<string, unknown>)['id']).toBe('string');
  });

  // ── Step 3: Verify stub is served ─────────────────────────────────────────

  it('step 3: GET /customers/cust-e2e-1 returns the stubbed canned response', async () => {
    const res = await httpRequest({
      method: 'GET',
      host: '127.0.0.1',
      port,
      path: '/customers/cust-e2e-1',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'cust-e2e-1', name: 'E2E Customer', riskBand: 'LOW' });
    expect(res.headers['x-specmatic-result']).toBe('success');
  });

  // ── Step 4: Clear expectations ────────────────────────────────────────────

  it('step 4: DELETE /_specmatic/expectations clears all stubs', async () => {
    const res = await httpRequest({
      method: 'DELETE',
      host: '127.0.0.1',
      port,
      path: '/_specmatic/expectations',
    });

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)['cleared']).toBeGreaterThanOrEqual(1);
  });

  // ── Step 5: CQRS fallback ─────────────────────────────────────────────────

  it('step 5: after clear, GET /customers/cust-e2e-1 returns 404 (CQRS fallback)', async () => {
    const res = await httpRequest({
      method: 'GET',
      host: '127.0.0.1',
      port,
      path: '/customers/cust-e2e-1',
    });

    expect(res.status).toBe(404);
  });

  // ── Step 5b: Known seeded entity still works ──────────────────────────────

  it('step 5b: GET /customers still returns the 2 seeded customers (CQRS unaffected)', async () => {
    const res = await httpRequest({
      method: 'GET',
      host: '127.0.0.1',
      port,
      path: '/customers',
    });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  // ── Step 6: Specmatic CLI contract test (Java-dependent) ──────────────────

  it('step 6: specmatic test command exits 0 (all contract scenarios pass)', async () => {
    if (!hasJava) {
      console.warn('SKIP step 6: Java not available');
      return;
    }

    /**
     * Run: java -jar specmatic.jar test \
     *        --testBaseURL=http://127.0.0.1:<port> \
     *        --timeout=10 \
     *        <contractPath>
     *
     * The banking.yaml fixture only tests GET /customers which always passes.
     */
    const contractPath = path.join(__dirname, 'fixtures', 'banking.yaml');
    const wtrRoot = path.join(__dirname, '../../..');

    const result = await runSpecmatic(
      [
        'test',
        `--testBaseURL=http://127.0.0.1:${port}`,
        '--timeout=10',
        contractPath,
      ],
      wtrRoot,
    );

    if (result.exitCode !== 0) {
      console.error('[end-to-end] specmatic test stdout:\n', result.stdout);
      console.error('[end-to-end] specmatic test stderr:\n', result.stderr);
    }

    expect(result.exitCode).toBe(0);
  }, 120_000);

  it('step 6b: specmatic test output has SUCCEEDED lines and zero FAILED lines', async () => {
    if (!hasJava) {
      console.warn('SKIP step 6b: Java not available');
      return;
    }

    const contractPath = path.join(__dirname, 'fixtures', 'banking.yaml');
    const wtrRoot = path.join(__dirname, '../../..');

    const result = await runSpecmatic(
      [
        'test',
        `--testBaseURL=http://127.0.0.1:${port}`,
        '--timeout=10',
        contractPath,
      ],
      wtrRoot,
    );

    const combined = result.stdout + result.stderr;
    const failLines = combined.split('\n').filter((l) => /has FAILED/i.test(l));
    const passLines = combined.split('\n').filter((l) => /has SUCCEEDED/i.test(l));

    expect(failLines).toHaveLength(0);
    expect(passLines.length).toBeGreaterThan(0);
  }, 120_000);
});
