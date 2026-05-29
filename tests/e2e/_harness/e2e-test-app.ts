/**
 * Combined e2e test app — boots Specmatic JVM + plugin + Node engine together
 * and exposes a clean shutdown handle.
 *
 * Usage:
 *   const app = await startE2eApp();
 *   // hit app.stubUrl for Specmatic-proxied requests
 *   // hit app.engineUrl for direct engine requests (admin/state checks)
 *   await app.shutdown();
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { ensureSpecmaticJar, ensurePluginJar } from './binary-fetcher';
import { startSpecmatic } from './specmatic-driver';
import { startEngine } from './engine-driver';
import { getFreePort } from './port-allocator';
import type { SpecmaticHandle } from './specmatic-driver';
import type { EngineHandle } from './engine-driver';

// Path to the CRM OpenAPI YAML used as the contract for the Specmatic stub.
const CONTRACT_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'fixtures',
  'crm',
  'openapi',
  'nuisance-bureau.yaml',
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface E2eApp {
  readonly specmatic: SpecmaticHandle;
  readonly engine: EngineHandle;
  /** http://127.0.0.1:<specmatic-port> — send test requests here */
  readonly stubUrl: string;
  /** http://127.0.0.1:<engine-port> — direct Node engine access */
  readonly engineUrl: string;
  /** http://127.0.0.1:<plugin-control-port> — plugin's control server */
  readonly pluginControlUrl: string;
  shutdown(): Promise<void>;
}

export interface E2eAppOptions {
  specmaticPort?: number;
  enginePort?: number;
  pluginControlPort?: number;
  /** Optional fixture name (e.g. "crm-jwt", "crm-session", "crm-versioned"). */
  fixtureName?: string;
  /** Alias for `fixtureName` used by the CRM fixtures. */
  crmFixtureName?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Probe until the given URL responds with any HTTP status. */
async function probeUrl(targetUrl: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(targetUrl, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }

  return false;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function startE2eApp(opts: E2eAppOptions = {}): Promise<E2eApp> {
  // 1. Allocate ports
  const specmaticPort = opts.specmaticPort ?? (await getFreePort());
  const enginePort = opts.enginePort ?? (await getFreePort());
  const pluginControlPort = opts.pluginControlPort ?? (await getFreePort());

  // 2. Ensure binaries exist
  const [specmaticJar, pluginJar] = await Promise.all([
    ensureSpecmaticJar('2.46.2'),
    ensurePluginJar(),
  ]);

  // 3. Write a temporary potemkin.yaml carrying the dynamic ports under
  // the plugin: block; the plugin reads engine.url, controlPort etc.
  const potemkinConfig = [
    `version: 1`,
    `specmatic: ./specmatic.yaml`,
    `modules: ["dsl/**/*.yaml"]`,
    `plugin:`,
    `  engine:`,
    `    url: "http://127.0.0.1:${enginePort}"`,
    `    timeoutMs: 5000`,
    `  controlPort: ${pluginControlPort}`,
  ].join('\n');

  const tmpConfigPath = path.join(os.tmpdir(), `potemkin-${Date.now()}.yaml`);
  fs.writeFileSync(tmpConfigPath, potemkinConfig, 'utf8');

  // 4. Start Specmatic (which loads plugin via SPI on startup)
  const specmatic = await startSpecmatic({
    contractPath: CONTRACT_PATH,
    pluginJar,
    specmaticJar,
    stubPort: specmaticPort,
    extraEnv: {
      POTEMKIN_CONFIG_PATH: tmpConfigPath,
    },
  });

  // 5. Wait for Specmatic stub to be ready
  try {
    await specmatic.ready();
  } catch (err) {
    await specmatic.shutdown();
    fs.unlinkSync(tmpConfigPath);
    throw new Error(`Specmatic did not start: ${err}`);
  }

  // 6. Start Node engine — sends /ready to plugin control server on boot
  const pluginControlUrl = `http://127.0.0.1:${pluginControlPort}`;
  const engine = await startEngine({
    port: enginePort,
    pluginControlUrl,
  });

  // 7. Wait for plugin control server to be reachable.
  // The Ktor control server starts inside the JVM (spawned in step 4) so it can take
  // a few seconds after the Specmatic stub is up before Ktor is listening.
  await probeUrl(`${pluginControlUrl}/health`, 15_000);

  // Give the engine 1 s to send /ready and the plugin to react
  await new Promise((r) => setTimeout(r, 1_000));

  // 8. Cleanup tmp config on JVM exit
  specmatic.process.on('exit', () => {
    try { fs.unlinkSync(tmpConfigPath); } catch { /* ignore */ }
  });

  const app: E2eApp = {
    specmatic,
    engine,
    stubUrl: `http://127.0.0.1:${specmaticPort}`,
    engineUrl: `http://127.0.0.1:${enginePort}`,
    pluginControlUrl,

    async shutdown() {
      // Stop engine first (sends /shutdown to plugin)
      await engine.stop().catch(() => { /* ignore */ });
      // Give plugin a moment to react
      await new Promise((r) => setTimeout(r, 500));
      // Then stop Specmatic
      await specmatic.shutdown();
    },
  };

  return app;
}
