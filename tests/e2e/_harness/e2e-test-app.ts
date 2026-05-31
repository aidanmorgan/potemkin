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
import { buildFixtureForwardBlocks } from './forward-blocks';
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

// Shared JWT secret for the crm-jwt / crm-forward fixtures (auth.mode: jwt).
// Kept in sync with tests/fixtures/crm-jwt/dsl/global.yaml — used only to mint a
// warmup token so the discovery probe can reach the engine past JWT auth.
const WARMUP_JWT_SECRET = 'potemkin-jwt-e2e-test-secret-do-not-use';
const WARMUP_JWT_ISSUER = 'potemkin-test';
const WARMUP_JWT_AUDIENCE = 'potemkin-api';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Mint an HS256 JWT valid for the crm-jwt/crm-forward fixtures. */
function mintWarmupJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8'));
  const payload = base64url(Buffer.from(JSON.stringify({
    sub: 'warmup', scopes: 'manager admin',
    iss: WARMUP_JWT_ISSUER, aud: WARMUP_JWT_AUDIENCE,
    iat: now, exp: now + 3600,
  }), 'utf8'));
  const signingInput = `${header}.${payload}`;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac } = require('node:crypto');
  const sig = base64url(createHmac('sha256', WARMUP_JWT_SECRET).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

/**
 * An owned single-entity GET on a KNOWN-ABSENT id per fixture — used to warm
 * discovery AND to prove the response came from the engine rather than from
 * Specmatic's generator.
 *
 * Why a bogus id: a well-formed GET /leads/{uuid} satisfies the OpenAPI
 * contract, so when the plugin is NOT forwarding, Specmatic generates a happy
 * 2xx example for it. The ENGINE, in contrast, returns a deterministic
 * entity-absence response for an id it does not hold (404 for query boundaries;
 * 422 for the ts-reducer WidgetById boundary, which declares no GET-query
 * behaviour). So a 404/422 on a bogus id is something ONLY the engine produces
 * — a Specmatic-generated response for the same request would be a 2xx example.
 *
 * For JWT-auth fixtures (crm-jwt, crm-forward) the probe carries a valid bearer
 * token so it reaches the engine's entity-absence path rather than the auth
 * 401 (which would be ambiguous against operations that declare a 401 response).
 */
function warmupProbeForFixture(
  fixtureName: string | undefined,
): { path: string; engineStatuses: readonly number[]; headers: Record<string, string> } {
  // A syntactically valid UUID that no fixture seeds, so the engine never holds
  // an entity for it.
  const BOGUS_ID = '00000000-0000-7000-8000-0000deadbeef';
  const accept: Record<string, string> = { Accept: 'application/json' };
  switch (fixtureName) {
    case 'ts-reducer':
    case 'ts-reducer-decorator':
      // WidgetById declares no GET-query behaviour, so the engine returns 422
      // (unhandled operation) for any GET — a status Specmatic would not
      // generate for a contract-valid request.
      return { path: `/widgets/${BOGUS_ID}`, engineStatuses: [422], headers: accept };
    case 'governance':
      return { path: `/documents/${BOGUS_ID}`, engineStatuses: [404, 422], headers: accept };
    case 'crm-jwt':
    case 'crm-forward':
      return {
        path: `/leads/${BOGUS_ID}`,
        engineStatuses: [404],
        headers: { ...accept, authorization: `Bearer ${mintWarmupJwt()}` },
      };
    default:
      return { path: `/leads/${BOGUS_ID}`, engineStatuses: [404], headers: accept };
  }
}

/**
 * Poll an owned single-entity GET path through the stub until the plugin
 * forwards it to the ENGINE — proven by an engine-specific status (entity
 * absence / unhandled query) on a known-absent id, NOT merely any numeric
 * status. A 2xx here means Specmatic generated the response itself (forwarding
 * is not yet healthy); a status 0 / parse error means the route is not yet
 * discovered. Only the engine-specific status proves a real forwarded response.
 */
async function warmStubForwarding(stubUrl: string, fixtureName: string | undefined): Promise<boolean> {
  const { path: p, engineStatuses, headers } = warmupProbeForFixture(fixtureName);
  // Healthy forwarding converges within a second or two; cap the wait so suites
  // running against the known-unhealthy stub path don't pay a long penalty.
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${stubUrl}${p}`, { method: 'GET', headers });
      res.body?.cancel?.().catch(() => { /* ignore */ });
      // Only an engine-specific status proves the engine served this response.
      // A 2xx is a Specmatic-generated example (not forwarding); 0/parse error
      // means the route is not yet discovered.
      if (engineStatuses.includes(res.status)) {
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
  // the plugin: block; the plugin reads engine.url, controlPort etc. The
  // fixture's auth + forward-blocks (seeds/workflow/overlay/governance) are
  // spliced in so the plugin exercises them through the stub.
  const fixtureName = opts.fixtureName ?? opts.crmFixtureName;
  const forward = buildFixtureForwardBlocks(fixtureName);

  const potemkinConfig = [
    `version: 1`,
    `specmatic: ./specmatic.yaml`,
    `modules: ["dsl/**/*.yaml"]`,
    `plugin:`,
    `  engine:`,
    `    url: "http://127.0.0.1:${enginePort}"`,
    `    timeoutMs: 5000`,
    `  controlPort: ${pluginControlPort}`,
    forward.pluginConfigYaml,
  ].join('\n');

  const tmpConfigPath = path.join(os.tmpdir(), `potemkin-${Date.now()}.yaml`);
  fs.writeFileSync(tmpConfigPath, potemkinConfig, 'utf8');

  // 4. Start Specmatic (which loads plugin via SPI on startup). When the fixture
  // declares an overlay, point Specmatic at the generated overlay file via the
  // `overlayFilePath` env var — Specmatic reads it at HttpStub construction and
  // serves the overlaid spec (E5).
  const specmaticEnv: Record<string, string> = { POTEMKIN_CONFIG_PATH: tmpConfigPath };
  if (forward.overlayFilePath) {
    specmaticEnv['overlayFilePath'] = forward.overlayFilePath;
  }
  const specmatic = await startSpecmatic({
    contractPath: resolveContractPath(fixtureName),
    pluginJar,
    specmaticJar,
    stubPort: specmaticPort,
    extraEnv: specmaticEnv,
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

  // 8. Cleanup tmp config + overlay file on JVM exit
  specmatic.process.on('exit', () => {
    try { fs.unlinkSync(tmpConfigPath); } catch { /* ignore */ }
    if (forward.overlayFilePath) {
      try { fs.unlinkSync(forward.overlayFilePath); } catch { /* ignore */ }
    }
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
