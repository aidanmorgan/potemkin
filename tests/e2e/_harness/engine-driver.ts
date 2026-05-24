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
import { compileDsl } from '../../../src/dsl/parser';
import { loadCrmFixtureWithGlobal } from '../../fixtures/index';
import { resetIdempotencyStore } from '../../../src/idempotency/store';
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
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startEngine(opts: EngineDriverOpts = {}): Promise<EngineHandle> {
  const port = opts.port ?? (await getFreePort());

  let sys = await _boot(opts.pluginControlUrl);
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
      sys = await _boot(controlUrl);
      server = await _serve(sys, port);
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function _boot(pluginControlUrl?: string): Promise<BootedSystem> {
  // Reset idempotency store so each engine boot starts with a clean slate.
  resetIdempotencyStore();
  const fixture = await loadCrmFixtureWithGlobal();
  const sys = await bootSystem({
    ...fixture,
    ...(pluginControlUrl
      ? {
          pluginControl: {
            url: pluginControlUrl,
            timeoutMs: 2000,
          },
        }
      : {}),
  });
  // Patch the compiled DSL to include Tier-2 config (sagas, idempotency, projections)
  // from the global.yaml.  bootSystem only calls compileDsl(dslModules) without
  // globalYaml, so we recompile and replace the dsl on the booted system.
  const dslWithGlobal = await compileDsl(fixture.dslModules, fixture.globalYaml);
  // Merge the expanded byContractPath from the boot dsl into the global dsl.
  // expandByContractPath mutates sys.dsl.byContractPath, so we first expand the
  // original (boot) dsl, then copy those entries into the global dsl.
  const originalDsl = sys.dsl;
  expandByContractPath(sys); // expands originalDsl.byContractPath
  // Copy all expanded paths into dslWithGlobal.byContractPath
  const expandedPaths = originalDsl.byContractPath as Record<string, unknown>;
  const globalPaths = dslWithGlobal.byContractPath as Record<string, unknown>;
  for (const [k, v] of Object.entries(expandedPaths)) {
    globalPaths[k] = v;
  }
  (sys as unknown as { dsl: typeof dslWithGlobal }).dsl = dslWithGlobal;
  return sys;
}

async function _serve(sys: BootedSystem, port: number): Promise<http.Server> {
  const app = createGateway(sys);
  return new Promise<http.Server>((resolve, reject) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
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
