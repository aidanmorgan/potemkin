/**
 * Container-friendly Potemkin engine server.
 *
 * The Node process owns the canonical runtime and watches the configured
 * potemkin.yml. Specmatic remains a separate
 * process (normally the sibling service in docker-compose) and forwards to
 * this HTTP server through the plugin.
 */

import type * as http from 'node:http';
import * as path from 'node:path';

import { createPluginControlClient } from '../lifecycle/pluginControlClient.js';
import { createLogger, type Logger } from '../observability/logger.js';
import { createYamlRuntimeExtensions } from '../parser/gateway.js';
import { bootYamlRuntimeFromConfig } from '../parser/files.js';
import { loadConfiguredOpenApi } from '../parser/configuredOpenApi.js';
import { createRuntimeGateway } from '../http/runtimeGateway.js';
import { resolveBindHost } from '../http/bindHost.js';
import { createRuntimeOtelRequestResponseObserver } from '../observability/runtimeExchange.js';
import { createRuntimeOtelMetricObserver } from '../observability/metrics.js';
import {
  getTracer,
  initTracing,
  type Tracer,
  type TracingOptions,
} from '../observability/tracing.js';
import type {
  RuntimeObservability,
  RuntimeRequestResponseCapturePolicy,
} from '../contracts/ports.js';
import { createRuntimeWebhookTransport } from '../webhooks/transport.js';
import { createDefaultRuntimeHost } from '../runtime/host.js';

export interface ServerOptions {
  readonly configPath?: string;
  readonly port?: number;
  readonly host?: string;
  /** Explicit runtime observability for embedding and deterministic tests. */
  readonly observability?: RuntimeObservability;
  /** OTEL SDK configuration used by the production server. */
  readonly tracing?: TracingOptions;
  /** Optional bounded/redacted body policy for the default OTEL observer. */
  readonly requestResponseCapture?: RuntimeRequestResponseCapturePolicy;
  /** Host-owned process services used by the production composition root. */
  readonly logger?: Logger;
  readonly tracer?: Tracer;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
  readonly nowMs?: () => number;
}

export async function startServer(
  options: ServerOptions = {},
): Promise<{ readonly close: () => Promise<void>; readonly port: number }> {
  const log = options.logger ?? createLogger({ name: 'potemkin.server', env: process.env });
  const tracer = options.tracer ?? getTracer('potemkin.server');
  const request = options.fetch ?? globalThis.fetch;
  const timeoutSignal =
    options.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  const nowMs = options.nowMs ?? Date.now;
  const tracing = await initTracing({
    ...options.tracing,
    env: options.tracing?.env ?? process.env,
    logger: options.tracing?.logger ?? log,
  });
  try {
    const configPath = path.resolve(
      options.configPath ?? process.env['POTEMKIN_CONFIG_PATH'] ?? 'potemkin.yml',
    );
    const authoringObservability = { logger: log, tracer };
    const openapi = await loadConfiguredOpenApi(configPath, undefined, authoringObservability);
    const pluginControlUrl = process.env['POTEMKIN_PLUGIN_CONTROL_URL'];
    const system = await bootYamlRuntimeFromConfig({
      openapi,
      potemkinConfigPath: configPath,
      host: createDefaultRuntimeHost(),
      authoringObservability,
      webhooks: createRuntimeWebhookTransport({
        fetch: request,
        timeoutSignal,
      }),
      ...(pluginControlUrl === undefined
        ? {}
        : {
            pluginControl: createPluginControlClient(
              { url: pluginControlUrl, timeoutMs: 5_000, logger: log },
              { fetch: request, nowMs, timeoutSignal },
            ),
          }),
      observability: {
        ...options.observability,
        metric: options.observability?.metric ?? createRuntimeOtelMetricObserver(),
        observeTransportRequestResponse:
          options.observability?.observeTransportRequestResponse ??
          createRuntimeOtelRequestResponseObserver({ tracer }),
        ...(options.requestResponseCapture === undefined
          ? {}
          : { requestResponseCapture: options.requestResponseCapture }),
      } satisfies RuntimeObservability,
      version: process.env['npm_package_version'] ?? '0.1.0',
      onConfigurationError: (error) =>
        log.error({ err: error }, 'Configuration reload rejected; previous runtime remains active'),
    });
    const app = createRuntimeGateway(system, {
      ...createYamlRuntimeExtensions(system),
      ...(process.env['ADMIN_TOKEN'] === undefined
        ? {}
        : { adminToken: process.env['ADMIN_TOKEN'] }),
      ...(process.env['ENGINE_ROUTES_TTL_SECONDS'] === undefined
        ? {}
        : { routesTtlSeconds: Number(process.env['ENGINE_ROUTES_TTL_SECONDS']) }),
      ...(process.env['ALLOWED_ORIGINS'] === undefined
        ? {}
        : {
            allowedOrigins:
              process.env['ALLOWED_ORIGINS'] === '*'
                ? '*'
                : process.env['ALLOWED_ORIGINS'].split(',').map((origin) => origin.trim()),
          }),
    });
    const host = options.host ?? resolveBindHost('dsl');
    const port = options.port ?? Number(process.env['POTEMKIN_ENGINE_PORT'] ?? 3000);
    const server = await listen(app, port, host);

    log.info(
      {
        configPath,
        openapi: system.configuration?.openapi,
        host,
        port,
        watching: true,
      },
      'Potemkin engine ready',
    );

    return {
      port,
      close: async () => {
        try {
          await closeServer(server);
          await system.dispose();
        } finally {
          await tracing.shutdown();
        }
      },
    };
  } catch (error) {
    await tracing.shutdown();
    throw error;
  }
}

function listen(
  app: ReturnType<typeof createRuntimeGateway>,
  port: number,
  host: string,
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.on('error', reject);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

export async function runServer(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const running = await startServer(parseServerArgs(argv));
  const shutdown = (): void => {
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

export function parseServerArgs(args: readonly string[]): ServerOptions {
  const options: { configPath?: string; port?: number; host?: string } = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = args[index + 1];
    if (value === undefined) continue;
    if (arg === '--config' || arg === '--config-path') options.configPath = value;
    if (arg === '--port') options.port = Number(value);
    if (arg === '--host') options.host = value;
    index += 1;
  }
  return options;
}
