/**
 * Engine driver — starts and stops the Potemkin Node CQRS engine in-process,
 * using the real `bootSystem` + `createGateway` API.  Each instance is
 * independent; multiple drivers can coexist on different ports within a test
 * suite (serialised via maxWorkers: 1).
 */

import * as http from 'node:http';
import type { BootedSystem } from '../../../src/engine/boot';
import { bootSystem } from '../../../src/engine/boot';
import { resetSystem } from '../../../src/engine/reset';
import { createGateway } from '../../../src/http/gateway';
import { loadEngineFixture } from '../../fixtures/index';
import { expandByContractPath } from '../../integration/_helpers/crm-boot';
import { getFreePort } from './port-allocator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EngineHandle {
  readonly port: number;
  readonly url: string;
  readonly system: BootedSystem;
  stop(): Promise<void>;
  restart(pluginControlUrl?: string): Promise<void>;
}

interface EngineDriverOpts {
  port?: number;
  /** If set, the engine will POST /ready and /shutdown notifications here. */
  pluginControlUrl?: string;
  /**
   * Fixture directory under tests/fixtures (e.g. "crm", "crm-jwt",
   * "crm-session", "ts-reducer"). Defaults to "crm". When the fixture declares
   * a typescript: reducer block, the engine boots via its potemkin.yaml so the
   * TS reducers are scanned + registered; otherwise it boots from the composed
   * CompiledDsl + global config.
   */
  fixtureName?: string;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startEngine(opts: EngineDriverOpts = {}): Promise<EngineHandle> {
  const port = opts.port ?? (await getFreePort());
  const fixtureName = opts.fixtureName ?? 'crm';

  let sys = await _boot(opts.pluginControlUrl, fixtureName);
  let server = await _serve(sys, port);

  const handle: EngineHandle = {
    get port() {
      return port;
    },
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    get system() {
      return sys;
    },

    async stop(): Promise<void> {
      // Notify the plugin control server that the engine is shutting down,
      // mirroring what installGracefulShutdown does on SIGTERM.
      if (opts.pluginControlUrl) {
        await _notifyShutdown(opts.pluginControlUrl).catch(() => { /* non-fatal */ });
      }
      await _closeServer(server);
    },

    async restart(newPluginControlUrl?: string) {
      const controlUrl = newPluginControlUrl ?? opts.pluginControlUrl;
      if (controlUrl) {
        await _notifyShutdown(controlUrl).catch(() => { /* non-fatal */ });
      }
      await _closeServer(server);
      resetSystem(sys);
      sys = await _boot(controlUrl, fixtureName);
      server = await _serve(sys, port);
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function _boot(pluginControlUrl?: string, fixtureName = 'crm'): Promise<BootedSystem> {
  // Each bootSystem() creates its own idempotency store, so a fresh boot
  // already starts with a clean slate. Every fixture boots through its
  // potemkin.yaml (the canonical loader) so module globbing/exclusions, the
  // global-config merge, and the TypeScript-reducer scan all run identically
  // to production.
  const fixture = await loadEngineFixture(fixtureName);
  const pluginControl = pluginControlUrl
    ? { pluginControl: { url: pluginControlUrl, timeoutMs: 2000 } }
    : {};
  const sys = await bootSystem({
    openapi: fixture.openapi,
    potemkinConfigPath: fixture.potemkinConfigPath,
    ...pluginControl,
  });
  // Expand byContractPath so the gateway registers routes for all OpenAPI
  // sub-paths (e.g. /leads/{id}/contact), not just the boundary base paths.
  expandByContractPath(sys);
  return sys;
}

async function _serve(sys: BootedSystem, port: number): Promise<http.Server> {
  const app = createGateway(sys);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolveBindHost } = require('../../../src/http/bindHost.js');
  const host: string = resolveBindHost('dsl');
  return new Promise<http.Server>((resolve, reject) => {
    const srv = app.listen(port, host, () => resolve(srv));
    srv.on('error', reject);
  });
}

async function _notifyShutdown(pluginControlUrl: string): Promise<void> {
  const url = `${pluginControlUrl}/shutdown`;
  const body = JSON.stringify({
    engine: 'potemkin-stateful',
    version: '0.1.0',
    reason: 'SIGTERM',
    stoppedAt: new Date().toISOString(),
  });
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(500),
  }).catch(() => { /* fire-and-forget */ });
}

function _closeServer(srv: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    // Force-close all connections and resolve regardless — the server may already be closed.
    srv.closeAllConnections?.();
    srv.close(() => resolve());
  });
}
