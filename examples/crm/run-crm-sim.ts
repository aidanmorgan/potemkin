/**
 * The Nuisance Bureau CRM simulation example entry point.
 *
 * Lifecycle wiring:
 *  1. Boot the engine (loads CRM DSL + OpenAPI, hydrates state graph).
 *     - If PLUGIN_CONTROL_URL is set, a POST /ready notification is sent
 *       fire-and-forget to the Specmatic-side plugin immediately after boot.
 *  2. Create the Express HTTP gateway.
 *  3. Call `installGracefulShutdown` on the http.Server returned by app.listen.
 *     - On SIGTERM or SIGINT, terminus will:
 *         a. Wait BEFORE_SHUTDOWN_DELAY_MS ms (default 0) for load-balancer drain.
 *         b. POST /shutdown to the plugin control server (500 ms budget).
 *         c. Drain in-flight HTTP connections within 10 s.
 *         d. Exit with code 0.
 *
 * Domain: The Nuisance Bureau CRM — 5 boundaries: Lead, Campaign, Agent, Call, Opportunity.
 */

import { bootSystem, createGateway, installGracefulShutdown } from '../../src/index.js';
import { loadFixture } from '../../tests/fixtures/index.js';
import { createLogger } from '../../src/observability/logger.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const version: string = (require('../../package.json') as { version: string }).version;

const log = createLogger({ name: 'nuisance-bureau-sim' });

const PORT = Number(process.env['PORT'] ?? 3001);

async function main(): Promise<void> {
  // --- Boot ----------------------------------------------------------------
  const fixture = await loadFixture('crm');

  const sys = await bootSystem({
    ...fixture,
    logger: log,
    // Wire the plugin control URL from the environment.
    // After successful boot, a POST /ready notification is sent fire-and-forget.
    pluginControl: {
      url: process.env['PLUGIN_CONTROL_URL'] ?? 'http://localhost:9090',
    },
  });

  log.info(
    {
      boundaries: sys.dsl.boundaries.map(b => b.boundary),
      seededEntities: sys.graph.size(),
    },
    'nuisance-bureau-sim: CRM system booted',
  );

  // --- HTTP gateway --------------------------------------------------------
  const app = createGateway(sys);

  const server = app.listen(PORT, () => {
    log.info({ port: PORT }, 'nuisance-bureau-sim: listening');
  });

  // --- Graceful shutdown ---------------------------------------------------
  // installGracefulShutdown wraps the server with @godaddy/terminus.
  // On SIGTERM/SIGINT it will:
  //   1. Optionally pause (BEFORE_SHUTDOWN_DELAY_MS env var, default 0).
  //   2. POST /shutdown to the plugin control server via sys.pluginControl.
  //   3. Drain open connections within 10 s then call process.exit(0).
  installGracefulShutdown({
    server,
    pluginControl: sys.pluginControl,
    shutdownPayload: () => ({
      engine: 'potemkin-stateful',
      domain: 'nuisance-bureau',
      version,
      reason: 'SIGTERM',
      stoppedAt: new Date().toISOString(),
    }),
    // Close the TypeScript reducer file-watcher (when typescript.watch is on) so
    // chokidar's inotify/kqueue descriptors are released before process.exit(0).
    afterDrain: () => sys.tsWatcher?.stop(),
    logger: log,
  });
}

main().catch((err) => {
  log.error({ err }, 'nuisance-bureau-sim: failed to start');
  process.exit(1);
});
