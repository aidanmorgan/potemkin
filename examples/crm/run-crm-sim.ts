/**
 * Run the Nuisance Bureau CRM simulation as it is meant to run: the FULL
 * Specmatic + plugin + engine stack. Potemkin is a Specmatic EXTENSION — the
 * canonical way to use a simulation is to launch the Specmatic stub with the
 * plugin pointed at the contract, which forwards stateful paths to the engine.
 * (The engine-only gateway exists only as an internal framework-test convenience,
 * not a user-facing way to run a simulation.)
 *
 * Requires Java 17+ and the plugin JAR:
 *   cd plugin && ./gradlew shadowJar && cd ..
 *   npm run start:example
 *
 * Then drive requests at the printed STUB URL (Specmatic enforces the contract):
 *   curl -s -XPOST <stubUrl>/leads -H 'Content-Type: application/json' \
 *        -d '{"companyName":"Acme","contactName":"A","phone":"+61...","email":"a@x","source":"WEBSITE"}'
 */

import { startExampleStack } from '../_harness/example-stack.js';
import { createLogger } from '../../src/observability/logger.js';

const log = createLogger({ name: 'nuisance-bureau-sim' });

async function main(): Promise<void> {
  log.info('Booting the full Specmatic + plugin + engine stack for the CRM example…');
  const stack = await startExampleStack({ exampleName: 'crm' });

  log.info(
    {
      stubUrl: stack.stubUrl,
      engineUrl: stack.engineUrl,
      boundaries: stack.system.dsl.boundaries.map((b) => b.boundary),
      seededEntities: stack.system.graph.size(),
    },
    'CRM simulation running — send requests to the STUB URL (Specmatic-validated). ' +
      'The engine URL exposes /_admin/* and /_engine/* for introspection.',
  );

  const shutdown = (): void => {
    log.info('Shutting down the CRM simulation stack…');
    void stack.shutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error({ err }, 'nuisance-bureau-sim: failed to start (is the plugin JAR built? cd plugin && ./gradlew shadowJar)');
  process.exit(1);
});
