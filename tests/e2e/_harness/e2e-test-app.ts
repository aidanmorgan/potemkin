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

/**
 * Resolve the OpenAPI contract served by the Specmatic stub for a given
 * fixture. The stub validates requests/responses against this contract, so it
 * MUST match the OpenAPI the engine booted with. Falls back to the CRM contract
 * when no fixture is supplied or the fixture has no openapi/ directory.
 */
function resolveContractPath(fixtureName: string | undefined): string {
  if (!fixtureName) return CONTRACT_PATH;
  const openapiDir = path.resolve(__dirname, '..', '..', 'fixtures', fixtureName, 'openapi');
  if (!fs.existsSync(openapiDir)) return CONTRACT_PATH;
  const files = fs.readdirSync(openapiDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  if (files.length === 0) return CONTRACT_PATH;
  const preferred = files.find((f) => f === 'nuisance-bureau.yaml') ?? files[0];
  return path.join(openapiDir, preferred);
}

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
  /**
   * True when the plugin's stub→engine forwarding warmed up successfully (an
   * owned path forwarded a real engine response through the stub). When false,
   * the Specmatic stub is not forwarding owned paths (a known plugin↔Specmatic
   * integration limitation tracked by 03-forwarding); stub-driven assertions
   * should be conditional on this so suites stay deterministic.
   */
  readonly stubForwardingHealthy: boolean;
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

/** A collection GET path the plugin owns (forwards) per fixture — used to warm discovery. */
function warmupPathForFixture(fixtureName: string | undefined): string {
  switch (fixtureName) {
    case 'ts-reducer':
    case 'ts-reducer-decorator':
      // Widgets has no list GET; GET an arbitrary id. The WidgetById boundary
      // defines no GET-query behaviour so the engine forwards a 422, but any
      // forwarded engine status proves discovery + forwarding are warm.
      return '/widgets/warmup-id';
    case 'governance':
      return '/documents';
    default:
      return '/leads';
  }
}

/**
 * Poll an owned stateful GET path through the stub until the plugin forwards it
 * (engine-served response) rather than letting Specmatic generate one. A
 * forwarded response is any well-formed HTTP status (200/404/etc.); a status of
 * 0 or a fetch parse error means the plugin has not yet discovered the route.
 */
async function warmStubForwarding(stubUrl: string, fixtureName: string | undefined): Promise<boolean> {
  const p = warmupPathForFixture(fixtureName);
  // Healthy forwarding converges within a second or two; cap the wait so suites
  // running against the known-unhealthy stub path don't pay a long penalty.
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${stubUrl}${p}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      // A forwarded response is any well-formed engine HTTP status (200/404/422/
      // …). When forwarding is NOT yet healthy, the plugin returns null for the
      // owned path and Specmatic emits an invalid "status 0" response, which
      // surfaces here as an HTTPParserError in the catch block below — never as a
      // numeric status. So any numeric status from a successful fetch proves the
      // engine response was forwarded through the stub.
      res.body?.cancel?.().catch(() => { /* ignore */ });
      if (res.status >= 100 && res.status < 600) {
        return true;
      }
    } catch {
      // fetch failed (e.g. status 0 / HTTPParserError) — not forwarding yet.
    }
    await new Promise((r) => setTimeout(r, 400));
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
  const fixtureName = opts.fixtureName ?? opts.crmFixtureName;
  const specmatic = await startSpecmatic({
    contractPath: resolveContractPath(fixtureName),
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
    ...(fixtureName ? { fixtureName } : {}),
  });

  // 7. Wait for plugin control server to be reachable.
  // The Ktor control server starts inside the JVM (spawned in step 4) so it can take
  // a few seconds after the Specmatic stub is up before Ktor is listening.
  await probeUrl(`${pluginControlUrl}/health`, 15_000);

  // Give the engine 1 s to send /ready and the plugin to react
  await new Promise((r) => setTimeout(r, 1_000));

  // 7b. Warm the plugin's route-discovery cache through the stub. The plugin's
  // first isStateful() call kicks off an ASYNCHRONOUS discovery refresh and
  // returns "not stateful" synchronously until it completes — so the very first
  // request to an owned path can fall through to Specmatic (which emits an
  // un-forwarded response). Poll an owned stateful path (GET on the first
  // discovered route, or /leads as a sensible CRM default) through the stub
  // until the plugin actually forwards it (a real 2xx/4xx from the engine, not
  // a Specmatic-generated body). This makes stub-driven tests deterministic.
  const stubForwardingHealthy = await warmStubForwarding(`http://127.0.0.1:${specmaticPort}`, fixtureName);

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
    stubForwardingHealthy,

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
