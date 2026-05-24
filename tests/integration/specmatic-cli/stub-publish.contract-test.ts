/**
 * stub-publish.contract-test.ts
 *
 * Proves our engine accepts stubs published via POST /_specmatic/expectations
 * in the Specmatic wire format, which is exactly what the Specmatic CLI posts
 * internally when it sets up stub expectations.
 *
 * Strategy (single-process):
 *  1. Boot our engine and bind it to a real TCP port.
 *  2. POST a Specmatic-format expectation directly — this is the same HTTP call
 *     the Specmatic CLI makes when it publishes stubs to a running server.
 *  3. Assert the stub is registered and a subsequent GET returns the canned body.
 *  4. Assert the stub lifecycle: registered → visible in list → deleteable.
 *
 * Java requirement:
 *  This file needs Java only if you want to use the Specmatic CLI directly.
 *  These tests simulate the CLI's HTTP traffic WITHOUT spawning a Java process,
 *  so they run in any environment.  Java-dependent tests are in the other files.
 */

import * as http from 'node:http';
import type { Server } from 'node:http';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Promisified HTTP request to a running server. */
function httpRequest(opts: {
  method: string;
  host: string;
  port: number;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const reqHeaders: Record<string, string> = {
      'Accept': 'application/json',
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

/** Start the engine and return the server + bound port. */
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

/** Stop an HTTP server. */
function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stub-publish: Specmatic wire-format stub registration', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startEngine());
  }, 30_000);

  afterAll(async () => {
    await stopServer(server);
  });

  it('POST /_specmatic/expectations with Specmatic wire format → 200', async () => {
    const body = {
      'http-request': { method: 'GET', path: '/customers/cust-cli-1' },
      'http-response': {
        status: 200,
        body: { id: 'cust-cli-1', name: 'CLI Customer', riskBand: 'LOW' },
      },
    };

    const res = await httpRequest({
      method: 'POST',
      host: '127.0.0.1',
      port,
      path: '/_specmatic/expectations',
      body,
    });

    expect(res.status).toBe(200);
  });

  it('registered stub → subsequent GET returns the canned response', async () => {
    const stubBody = { id: 'cust-cli-2', name: 'Canned Customer', riskBand: 'MED' };

    await httpRequest({
      method: 'POST',
      host: '127.0.0.1',
      port,
      path: '/_specmatic/expectations',
      body: {
        'http-request': { method: 'GET', path: '/customers/cust-cli-2' },
        'http-response': { status: 200, body: stubBody },
      },
    });

    const getRes = await httpRequest({
      method: 'GET',
      host: '127.0.0.1',
      port,
      path: '/customers/cust-cli-2',
    });

    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual(stubBody);
  });

  it('stub response carries X-Specmatic-Result: success header', async () => {
    await httpRequest({
      method: 'POST',
      host: '127.0.0.1',
      port,
      path: '/_specmatic/expectations',
      body: {
        'http-request': { method: 'GET', path: '/customers/hdr-cli-test' },
        'http-response': {
          status: 200,
          body: { id: 'hdr-cli-test', name: 'H', riskBand: 'LOW' },
        },
      },
    });

    const res = await httpRequest({
      method: 'GET',
      host: '127.0.0.1',
      port,
      path: '/customers/hdr-cli-test',
    });

    expect(res.headers['x-specmatic-result']).toBe('success');
  });

  it('GET /_specmatic/expectations lists the registered stub', async () => {
    const expectRes = await httpRequest({
      method: 'POST',
      host: '127.0.0.1',
      port,
      path: '/_specmatic/expectations',
      body: {
        'http-request': { method: 'GET', path: '/customers/list-check' },
        'http-response': {
          status: 200,
          body: { id: 'list-check', name: 'Listed', riskBand: 'LOW' },
        },
      },
    });

    const newId = (expectRes.body as Record<string, unknown>)['id'] as string;

    const listRes = await httpRequest({
      method: 'GET',
      host: '127.0.0.1',
      port,
      path: '/_specmatic/expectations',
    });

    expect(listRes.status).toBe(200);
    const list = listRes.body as Array<Record<string, unknown>>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((e) => e['id'] === newId)).toBe(true);
  });

  it('DELETE /_specmatic/expectations/:id removes the stub → CQRS fallback returns 404', async () => {
    const postRes = await httpRequest({
      method: 'POST',
      host: '127.0.0.1',
      port,
      path: '/_specmatic/expectations',
      body: {
        'http-request': { method: 'GET', path: '/customers/del-cli-test' },
        'http-response': {
          status: 200,
          body: { id: 'del-cli-test', name: 'To Delete', riskBand: 'LOW' },
        },
      },
    });

    const stubId = (postRes.body as Record<string, unknown>)['id'] as string;

    // Stub is active
    const active = await httpRequest({
      method: 'GET',
      host: '127.0.0.1',
      port,
      path: '/customers/del-cli-test',
    });
    expect(active.status).toBe(200);

    // Delete the stub
    const delRes = await httpRequest({
      method: 'DELETE',
      host: '127.0.0.1',
      port,
      path: `/_specmatic/expectations/${stubId}`,
    });
    expect(delRes.status).toBe(200);

    // Fallback to CQRS — entity doesn't exist → 404
    const after = await httpRequest({
      method: 'GET',
      host: '127.0.0.1',
      port,
      path: '/customers/del-cli-test',
    });
    expect(after.status).toBe(404);
  });

  it('DELETE /_specmatic/expectations (bulk clear) removes all stubs', async () => {
    // Add two stubs
    for (const id of ['bulk-1', 'bulk-2']) {
      await httpRequest({
        method: 'POST',
        host: '127.0.0.1',
        port,
        path: '/_specmatic/expectations',
        body: {
          'http-request': { method: 'GET', path: `/customers/${id}` },
          'http-response': {
            status: 200,
            body: { id, name: `Bulk ${id}`, riskBand: 'LOW' },
          },
        },
      });
    }

    // Confirm stubs are active
    for (const id of ['bulk-1', 'bulk-2']) {
      const res = await httpRequest({
        method: 'GET',
        host: '127.0.0.1',
        port,
        path: `/customers/${id}`,
      });
      expect(res.status).toBe(200);
    }

    // Bulk-clear
    const clearRes = await httpRequest({
      method: 'DELETE',
      host: '127.0.0.1',
      port,
      path: '/_specmatic/expectations',
    });
    expect(clearRes.status).toBe(200);

    // Both should now 404
    for (const id of ['bulk-1', 'bulk-2']) {
      const res = await httpRequest({
        method: 'GET',
        host: '127.0.0.1',
        port,
        path: `/customers/${id}`,
      });
      expect(res.status).toBe(404);
    }
  });
});
