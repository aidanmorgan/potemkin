/**
 * Engine driver — starts and stops the Potemkin Node runtime in-process,
 * using the real YAML parser + canonical `RuntimeSystem` + runtime gateway. Each instance is
 * independent; multiple drivers can coexist on different ports within a test
 * suite (serialised via maxWorkers: 1).
 */

import type * as http from "node:http";
import type { RuntimeSystem } from "../../../src/runtime/system";
import type { RuntimeObservability } from "../../../src/model/runtime";
import type { OpenApiDoc } from "../../../src/contract/loader";
import { bootYamlRuntimeFromConfig } from "../../../src/parser/files";
import { createDefaultRuntimeHost } from "../../../src/runtime/host";
import { createRuntimeWebhookTransport } from "../../../src/webhooks/transport";
import { createYamlRuntimeExtensions } from "../../../src/parser/gateway";
import { createRuntimeGateway } from "../../../src/http/runtimeGateway";
import { createPluginControlClient } from "../../../src/lifecycle/pluginControlClient";
import { loadEngineFixture } from "../../fixtures/index";
import { getFreePort } from "../../../src/conformance/portAllocator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EngineHandle {
  readonly port: number;
  readonly url: string;
  readonly system: RuntimeSystem;
  stop(): Promise<void>;
  restart(pluginControlUrl?: string): Promise<void>;
}

interface EngineDriverOpts {
  port?: number;
  /** If set, the engine will POST /_potemkin/ready and /shutdown notifications here. */
  pluginControlUrl?: string;
  /**
   * Fixture directory under tests/fixtures (e.g. "crm", "crm-jwt",
   * "crm-session"). Defaults to "crm". When the fixture declares TypeScript
   * factories, the engine boots via its potemkin.yml so the configured SDK
   * modules are discovered by the parser boot path.
   */
  fixtureName?: string;
  /** Boot a caller-supplied potemkin.yml instead of a named test fixture. */
  potemkinConfigPath?: string;
  /** Composite OpenAPI document for a caller-supplied potemkin.yml. */
  openapi?: OpenApiDoc;
  onConfigurationError?: (error: unknown) => void;
  /** Test-owned transport observation port for real Specmatic assertions. */
  observability?: RuntimeObservability;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startEngine(opts: EngineDriverOpts = {}): Promise<EngineHandle> {
  const port = opts.port ?? (await getFreePort());
  const fixtureName = opts.fixtureName ?? "crm";
  let sys = await _boot(
    opts.pluginControlUrl,
    fixtureName,
    opts.potemkinConfigPath,
    opts.openapi,
    opts.onConfigurationError,
    opts.observability,
  );
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
      await _closeServer(server);
      await sys.dispose();
    },

    async restart(newPluginControlUrl?: string) {
      const controlUrl = newPluginControlUrl ?? opts.pluginControlUrl;
      await _closeServer(server);
      await sys.dispose();
      sys = await _boot(
        controlUrl,
        fixtureName,
        opts.potemkinConfigPath,
        opts.openapi,
        opts.onConfigurationError,
        opts.observability,
      );
      server = await _serve(sys, port);
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function _boot(
  pluginControlUrl?: string,
  fixtureName = "crm",
  potemkinConfigPath?: string,
  openapi?: OpenApiDoc,
  onConfigurationError?: (error: unknown) => void,
  observability?: RuntimeObservability,
): Promise<RuntimeSystem> {
  if (potemkinConfigPath !== undefined) {
    if (openapi === undefined)
      throw new Error("openapi is required when potemkinConfigPath is supplied");
    return bootYamlRuntimeFromConfig({
      openapi,
      potemkinConfigPath,
      host: createDefaultRuntimeHost(),
      webhooks: createRuntimeWebhookTransport({
        fetch: globalThis.fetch,
        timeoutSignal: (milliseconds) => AbortSignal.timeout(milliseconds),
      }),
      ...(pluginControlUrl === undefined
        ? {}
        : {
            pluginControl: createPluginControlClient(
              { url: pluginControlUrl, timeoutMs: 2_000 },
              {
                fetch: globalThis.fetch,
                nowMs: Date.now,
                timeoutSignal: (milliseconds) => AbortSignal.timeout(milliseconds),
              },
            ),
          }),
      ...(onConfigurationError === undefined ? {} : { onConfigurationError }),
      ...(observability === undefined ? {} : { observability }),
    });
  }
  // Every fixture boots through potemkin.yml so module globbing/exclusions,
  // global policy compilation, and the TypeScript extension scan run exactly
  // as they do in production.
  const fixture = await loadEngineFixture(fixtureName);
  return bootYamlRuntimeFromConfig({
    openapi: fixture.openapi,
    potemkinConfigPath: fixture.potemkinConfigPath,
    host: createDefaultRuntimeHost(),
    webhooks: createRuntimeWebhookTransport({
      fetch: globalThis.fetch,
      timeoutSignal: (milliseconds) => AbortSignal.timeout(milliseconds),
    }),
    ...(pluginControlUrl === undefined
      ? {}
      : {
          pluginControl: createPluginControlClient(
            { url: pluginControlUrl, timeoutMs: 2_000 },
            {
              fetch: globalThis.fetch,
              nowMs: Date.now,
              timeoutSignal: (milliseconds) => AbortSignal.timeout(milliseconds),
            },
          ),
        }),
    ...(onConfigurationError === undefined ? {} : { onConfigurationError }),
    ...(observability === undefined ? {} : { observability }),
  });
}

async function _serve(sys: RuntimeSystem, port: number): Promise<http.Server> {
  const app = createRuntimeGateway(sys, createYamlRuntimeExtensions(sys));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolveBindHost } = require("../../../src/http/bindHost.js");
  const host: string = resolveBindHost("dsl");
  return new Promise<http.Server>((resolve, reject) => {
    const srv = app.listen(port, host, () => resolve(srv));
    srv.unref();
    srv.on("error", reject);
  });
}

function _closeServer(srv: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    // Force-close all connections and resolve regardless — the server may already be closed.
    srv.closeAllConnections?.();
    srv.close(() => resolve());
  });
}
