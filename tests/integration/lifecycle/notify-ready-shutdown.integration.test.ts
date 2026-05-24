/**
 * Integration tests for lifecycle plugin control notifications.
 *
 * Each test spins up a tiny real Express server that acts as the plugin
 * control endpoint — no mocks for the HTTP layer.  We use the real
 * `createPluginControlClient` and drive `bootSystem` with a pluginControl
 * URL pointing at the test server.
 *
 * Scenarios:
 *  1. After boot with a live plugin control server, POST /ready is received
 *     within 500 ms and its payload matches ReadyNotification shape.
 *  2. `notifyShutdown` sends a correct POST /shutdown payload.
 *  3. When the plugin control server is DOWN, boot still succeeds and the
 *     ready notification fails gracefully (no exception escapes).
 */

import * as http from 'node:http';
import express from 'express';
import type { Express } from 'express';
import { bootSystem } from '../../../src/engine/boot.js';
import { createPluginControlClient } from '../../../src/lifecycle/pluginControlClient.js';
import type { ReadyNotification, ShutdownNotification } from '../../../src/lifecycle/types.js';
import { loadCrmFixture } from '../../fixtures/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedPost {
  path: string;
  body: unknown;
  receivedAt: number;
}

/**
 * Spin up a minimal Express server that captures POST /ready and POST /shutdown.
 * Returns the server, its bound port, and a list of captured requests.
 */
async function startControlServer(): Promise<{
  server: http.Server;
  port: number;
  captured: CapturedPost[];
  url: string;
}> {
  const app: Express = express();
  app.use(express.json());

  const captured: CapturedPost[] = [];

  app.post('/ready', (req, res) => {
    captured.push({ path: '/ready', body: req.body as unknown, receivedAt: Date.now() });
    res.status(200).json({ ok: true });
  });

  app.post('/shutdown', (req, res) => {
    captured.push({ path: '/shutdown', body: req.body as unknown, receivedAt: Date.now() });
    res.status(200).json({ ok: true });
  });

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        port: addr.port,
        captured,
        url: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

async function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Wait up to `timeoutMs` for `captured` to contain at least one entry matching `path`. */
async function waitForCapture(
  captured: CapturedPost[],
  path: string,
  timeoutMs = 1000,
): Promise<CapturedPost | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = captured.find((c) => c.path === path);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lifecycle: notify-ready integration', () => {
  let controlServer: http.Server;
  let captured: CapturedPost[];
  let controlUrl: string;

  beforeEach(async () => {
    const result = await startControlServer();
    controlServer = result.server;
    captured = result.captured;
    controlUrl = result.url;
  });

  afterEach(async () => {
    await stopServer(controlServer);
  });

  it('sends POST /ready within 500 ms of boot completion', async () => {
    const fixture = await loadCrmFixture();
    const bootCompletedAt = Date.now();

    await bootSystem({ ...fixture, pluginControl: { url: controlUrl } });

    const cap = await waitForCapture(captured, '/ready', 500);

    expect(cap).not.toBeNull();
    expect(cap!.receivedAt - bootCompletedAt).toBeLessThan(500);
  });

  it('POST /ready payload matches ReadyNotification shape', async () => {
    const fixture = await loadCrmFixture();
    await bootSystem({ ...fixture, pluginControl: { url: controlUrl } });

    const cap = await waitForCapture(captured, '/ready', 500);
    expect(cap).not.toBeNull();

    const body = cap!.body as Partial<ReadyNotification>;
    expect(body.engine).toBe('potemkin-stateful');
    expect(typeof body.version).toBe('string');
    expect(typeof body.startedAt).toBe('string');
    expect(Array.isArray(body.contractPaths)).toBe(true);
    expect(typeof body.routesChecksum).toBe('string');
    expect(typeof body.fixturesChecksum).toBe('string');
    // contractPaths should be non-empty (CRM fixture has several paths)
    expect((body.contractPaths as string[]).length).toBeGreaterThan(0);
    // Paths should be sorted
    const paths = body.contractPaths as string[];
    expect(paths).toEqual([...paths].sort());
  });

  it('bootSystem attaches pluginControl client to BootedSystem', async () => {
    const fixture = await loadCrmFixture();
    const sys = await bootSystem({ ...fixture, pluginControl: { url: controlUrl } });

    expect(sys.pluginControl).toBeDefined();
  });

  it('boot port is unused by default (no pluginControl property on BootedSystem)', async () => {
    const fixture = await loadCrmFixture();
    // Boot without pluginControl URL
    const sys = await bootSystem({ ...fixture });

    expect(sys.pluginControl).toBeUndefined();
  });
});

describe('lifecycle: notify-shutdown integration', () => {
  let controlServer: http.Server;
  let captured: CapturedPost[];
  let controlUrl: string;

  beforeEach(async () => {
    const result = await startControlServer();
    controlServer = result.server;
    captured = result.captured;
    controlUrl = result.url;
  });

  afterEach(async () => {
    await stopServer(controlServer);
  });

  it('notifyShutdown sends correct payload to POST /shutdown', async () => {
    const client = createPluginControlClient({ url: controlUrl });

    const payload: ShutdownNotification = {
      engine: 'potemkin-stateful',
      version: '0.1.0',
      reason: 'SIGTERM',
      stoppedAt: new Date().toISOString(),
    };

    const result = await client.notifyShutdown(payload);

    expect(result.ok).toBe(true);

    const cap = captured.find((c) => c.path === '/shutdown');
    expect(cap).toBeDefined();

    const body = cap!.body as Partial<ShutdownNotification>;
    expect(body.engine).toBe('potemkin-stateful');
    expect(body.reason).toBe('SIGTERM');
    expect(typeof body.stoppedAt).toBe('string');
  });

  it('notifyShutdown returns ok:true with attempts:1', async () => {
    const client = createPluginControlClient({ url: controlUrl });

    const result = await client.notifyShutdown({
      engine: 'potemkin-stateful',
      version: '0.1.0',
      reason: 'SIGINT',
      stoppedAt: new Date().toISOString(),
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
  });
});

describe('lifecycle: plugin control server DOWN', () => {
  it('boot still succeeds when plugin control server is unreachable', async () => {
    // Use a port that is almost certainly not listening.
    const fixture = await loadCrmFixture();

    // bootSystem must not throw even though the control server is down.
    const sys = await bootSystem({
      ...fixture,
      pluginControl: { url: 'http://127.0.0.1:19999', timeoutMs: 100 },
    });

    // The system must be fully operational.
    expect(sys.frozenBaseline.length).toBeGreaterThanOrEqual(0);
    expect(sys.pluginControl).toBeDefined();

    // Give the fire-and-forget notification a moment to complete (it should
    // fail silently rather than crashing the process).
    await new Promise((r) => setTimeout(r, 300));
  });

  it('notifyReady returns ok:false when server is unreachable', async () => {
    const client = createPluginControlClient({
      url: 'http://127.0.0.1:19999',
      timeoutMs: 100,
      retries: 1,
      minBackoffMs: 10,
      maxBackoffMs: 50,
      factor: 1,
    });

    const result = await client.notifyReady({
      engine: 'potemkin-stateful',
      version: '0.1.0',
      startedAt: new Date().toISOString(),
      contractPaths: [],
      routesChecksum: 'x',
      fixturesChecksum: 'y',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe('string');
    }
  });

  it('notifyShutdown returns ok:false when server is unreachable', async () => {
    const client = createPluginControlClient({
      url: 'http://127.0.0.1:19999',
      timeoutMs: 100,
    });

    const result = await client.notifyShutdown({
      engine: 'potemkin-stateful',
      version: '0.1.0',
      reason: 'manual',
      stoppedAt: new Date().toISOString(),
    });

    expect(result.ok).toBe(false);
  });
});

