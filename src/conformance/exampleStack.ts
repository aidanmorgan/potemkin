/**
 * Dedicated harness for the consumer-side example tests (examples/<name>/tests).
 *
 * Boots the FULL stack for an example — the Node CQRS engine, the Specmatic stub,
 * and the plugin JAR — and exposes the STUB URL the tests drive. The tests are the
 * consumer: they make contract calls through the stub (Specmatic enforces the
 * OpenAPI contract) and force known states THROUGH the stub (X-Potemkin-* control
 * headers, Idempotency-Key, and /_admin/* reset/clock/faults proxied by the plugin).
 *
 * Unlike the framework E2E composition root, this points
 * at an example's REAL specmatic.yaml + potemkin.yml + OpenAPI, and gates on the
 * plugin's forwarding-readiness endpoint (/_potemkin/ready) instead of a timing sleep.
 *
 * Requires Java + the plugin JAR (built via `cd plugin && ./gradlew shadowJar`); this
 * is e2e-tier and not part of `npm test`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as http from "node:http";
import { ensureSpecmaticJar, ensurePluginJar } from "./binaries.js";
import { startSpecmatic, type SpecmaticHandle } from "./specmaticProcess.js";
import { getFreePort } from "./portAllocator.js";
import { bootYamlRuntimeFromConfig } from "../parser/files.js";
import { createYamlRuntimeExtensions } from "../parser/gateway.js";
import { createRuntimeGateway } from "../http/runtimeGateway.js";
import type { RuntimeSystem } from "../runtime/system.js";
import { createDefaultRuntimeHost } from "../runtime/host.js";
import { createPluginControlClient } from "../lifecycle/pluginControlClient.js";
import { loadOpenApi } from "../contract/loader.js";
import { resolveBindHost } from "../http/bindHost.js";
import { createRuntimeWebhookTransport } from "../webhooks/transport.js";
import { seedRuntimeFromExportedExamples } from "./exportedCorpus.js";

const SPECMATIC_VERSION = "2.46.2";

export interface ExampleStack {
  /** http://127.0.0.1:<stub-port> — the consumer hits THIS (Specmatic-validated). */
  readonly stubUrl: string;
  /** http://127.0.0.1:<engine-port> — direct engine access for test introspection. */
  readonly engineUrl: string;
  /** http://127.0.0.1:<plugin-control-port> — the plugin's Ktor control server. */
  readonly pluginControlUrl: string;
  /** The booted engine system (for white-box assertions when needed). */
  readonly system: RuntimeSystem;
  /** Reset the simulation to its frozen baseline THROUGH the stub (plugin-proxied). */
  reset(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ExampleStackOptions {
  /** Example directory name under examples/ (e.g. "crm", "stripe"). */
  readonly exampleName: string;
  /**
   * Optional contract used by Specmatic. The engine still loads the example's
   * authoritative contract, which allows a large upstream document to be
   * paired with a deliberately scoped Specmatic contract when the pinned
   * Specmatic runtime cannot parse the upstream document.
   */
  readonly specmaticContractPath?: string;
  /** Optional exported Specmatic corpus whose positive states should be live. */
  readonly seedExamplesDir?: string;
}

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Resolve the single OpenAPI contract file in examples/<name>/openapi/. */
function resolveContractPath(exampleDir: string): string {
  const openapiDir = path.join(exampleDir, "openapi");
  const files = fs
    .readdirSync(openapiDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml") || f.endsWith(".json"));
  if (files.length === 0) {
    throw new Error(`No OpenAPI contract found in ${openapiDir}`);
  }
  return path.join(openapiDir, files[0]);
}

/** Poll the plugin's forwarding-readiness endpoint until routes are discovered. */
async function awaitForwardingReady(pluginControlUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${pluginControlUrl}/_potemkin/ready`, {
        method: "GET",
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { ready?: boolean };
        if (body.ready === true) return;
        last = `ready=false ${JSON.stringify(body)}`;
      } else {
        last = `HTTP ${res.status}`;
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Plugin forwarding never became ready after ${timeoutMs}ms (last: ${last})`);
}

function closeServer(srv: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    srv.closeAllConnections?.();
    srv.close(() => resolve());
  });
}

/**
 * Boot the full example stack. Order: Specmatic stub (loads the plugin via SPI) →
 * engine (POSTs /ready to the plugin control server) → await forwarding-ready.
 */
export async function startExampleStack(opts: ExampleStackOptions): Promise<ExampleStack> {
  const exampleDir = path.join(REPO_ROOT, "examples", opts.exampleName);
  const contractPath = resolveContractPath(exampleDir);
  const specmaticContractPath = opts.specmaticContractPath ?? contractPath;
  const potemkinConfigPath = path.join(exampleDir, "potemkin.yml");

  const stubPort = await getFreePort();
  const enginePort = await getFreePort();
  const pluginControlPort = await getFreePort();
  const pluginControlUrl = `http://127.0.0.1:${pluginControlPort}`;

  const [specmaticJar, pluginJar] = await Promise.all([
    ensureSpecmaticJar(SPECMATIC_VERSION),
    ensurePluginJar(),
  ]);

  // The plugin reads only the `plugin:` block (engine URL + control port) from
  // POTEMKIN_CONFIG_PATH; the engine boots from the example's real potemkin.yml.
  const tmpPluginConfig = [
    "version: 1",
    `specmatic: ${path.join(exampleDir, "specmatic.yaml")}`,
    "plugin:",
    "  engine:",
    `    url: "http://127.0.0.1:${enginePort}"`,
    "    timeoutMs: 5000",
    `  controlPort: ${pluginControlPort}`,
    "",
  ].join("\n");
  const tmpConfigPath = path.join(
    os.tmpdir(),
    `potemkin-example-${opts.exampleName}-${enginePort}.yaml`,
  );
  fs.writeFileSync(tmpConfigPath, tmpPluginConfig, "utf8");

  let specmatic: SpecmaticHandle | undefined;
  let server: http.Server | undefined;
  let system: RuntimeSystem | undefined;

  try {
    specmatic = await startSpecmatic({
      contractPaths: [specmaticContractPath],
      pluginJar,
      specmaticJar,
      stubPort,
      extraEnv: { POTEMKIN_CONFIG_PATH: tmpConfigPath },
    });
    await specmatic.ready();

    const openapi = await loadOpenApi(contractPath);
    system = await bootYamlRuntimeFromConfig({
      openapi,
      potemkinConfigPath,
      host: createDefaultRuntimeHost(),
      webhooks: createRuntimeWebhookTransport({
        fetch: globalThis.fetch,
        timeoutSignal: (milliseconds) => AbortSignal.timeout(milliseconds),
      }),
      pluginControl: createPluginControlClient(
        { url: pluginControlUrl, timeoutMs: 2_000 },
        {
          fetch: globalThis.fetch,
          nowMs: Date.now,
          timeoutSignal: (milliseconds) => AbortSignal.timeout(milliseconds),
        },
      ),
    });
    const app = createRuntimeGateway(system, createYamlRuntimeExtensions(system));
    const host = resolveBindHost("dsl");
    server = await new Promise<http.Server>((resolve, reject) => {
      const srv = app.listen(enginePort, host, () => resolve(srv));
      srv.on("error", reject);
    });
    if (opts.seedExamplesDir !== undefined)
      seedRuntimeFromExportedExamples(system, opts.seedExamplesDir);

    // Deterministic gate: the plugin reports ready once the engine is up and its
    // route-discovery cache is populated (self-healing via forceRefresh) — so the
    // first consumer request to an owned path forwards instead of falling through.
    await awaitForwardingReady(pluginControlUrl);
  } catch (err) {
    if (server)
      await closeServer(server).catch(() => {
        /* ignore */
      });
    if (specmatic)
      await specmatic.shutdown().catch(() => {
        /* ignore */
      });
    try {
      fs.unlinkSync(tmpConfigPath);
    } catch {
      /* ignore */
    }
    throw err;
  }

  const stubUrl = `http://127.0.0.1:${stubPort}`;
  const engineUrl = `http://127.0.0.1:${enginePort}`;
  const boundServer = server;
  const boundSpecmatic = specmatic;
  const boundSystem = system;

  return {
    stubUrl,
    engineUrl,
    pluginControlUrl,
    system: boundSystem,

    async reset(): Promise<void> {
      // Reset THROUGH the stub: the plugin proxies /_admin/* to the engine.
      const res = await fetch(`${stubUrl}/_admin/reset`, { method: "POST" });
      if (!res.ok && res.status !== 204) {
        throw new Error(`reset-through-stub failed: HTTP ${res.status}`);
      }
      res.body?.cancel?.().catch(() => {
        /* ignore */
      });
      if (opts.seedExamplesDir !== undefined)
        seedRuntimeFromExportedExamples(boundSystem, opts.seedExamplesDir);
    },

    async shutdown(): Promise<void> {
      await closeServer(boundServer).catch(() => {
        /* ignore */
      });
      await boundSystem.dispose().catch(() => {
        /* ignore */
      });
      await new Promise((r) => setTimeout(r, 300));
      await boundSpecmatic.shutdown().catch(() => {
        /* ignore */
      });
      try {
        fs.unlinkSync(tmpConfigPath);
      } catch {
        /* ignore */
      }
    },
  };
}
