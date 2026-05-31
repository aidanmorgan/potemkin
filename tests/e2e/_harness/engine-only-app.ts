/**
 * Engine-only e2e app — boots ONLY the Potemkin Node engine (no Specmatic JVM,
 * no Kotlin plugin) and exposes the same surface that engine-only suites use.
 *
 * Many e2e suites exercise behaviour that lives entirely in the Node engine and
 * reach it exclusively through `app.engineUrl` (the /_engine/forward surface and
 * the /_admin endpoints) — they never touch `app.stubUrl`. Those suites do not
 * need Java or a running Specmatic stub, so they can run UNCONDITIONALLY in CI
 * even where the JVM is unavailable.
 *
 * This factory returns an object shaped like the full E2eApp (so suites can be
 * switched over without touching their bodies), but `stubUrl` is intentionally
 * pointed at the engine and `stubForwardingHealthy` is false — engine-only
 * suites must not depend on a real stub.
 */

import { startEngine } from './engine-driver';
import type { EngineHandle } from './engine-driver';

export interface EngineOnlyApp {
  readonly engine: EngineHandle;
  /** http://127.0.0.1:<engine-port> — direct Node engine access. */
  readonly engineUrl: string;
  /**
   * Engine-only apps have no Specmatic stub. `stubUrl` aliases the engine so
   * accidental stub usage fails loudly rather than hitting a phantom port, and
   * `stubForwardingHealthy` is always false.
   */
  readonly stubUrl: string;
  readonly stubForwardingHealthy: boolean;
  shutdown(): Promise<void>;
}

export interface EngineOnlyAppOptions {
  enginePort?: number;
  /** Fixture name (e.g. "crm", "crm-jwt", "crm-session", "crm-versioned"). */
  fixtureName?: string;
  /** Alias for `fixtureName` used by the CRM fixtures. */
  crmFixtureName?: string;
}

export async function startEngineOnlyApp(opts: EngineOnlyAppOptions = {}): Promise<EngineOnlyApp> {
  const fixtureName = opts.fixtureName ?? opts.crmFixtureName;
  const engine = await startEngine({
    ...(opts.enginePort !== undefined ? { port: opts.enginePort } : {}),
    ...(fixtureName ? { fixtureName } : {}),
  });

  return {
    engine,
    engineUrl: engine.url,
    stubUrl: engine.url,
    stubForwardingHealthy: false,
    async shutdown() {
      await engine.stop().catch(() => { /* ignore */ });
    },
  };
}
