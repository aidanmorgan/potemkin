import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';

async function main(): Promise<void> {
  const fixture = await loadBankingFixture();
  const sys = await bootSystem(fixture);
  const app = createGateway(sys);

  const PORT = parseInt(process.env['PORT'] ?? '19001', 10);

  const server = app.listen(PORT, '127.0.0.1', () => {
    process.stderr.write(`SERVER_READY:${PORT}\n`);
  });
  process.on('SIGTERM', () => { server.close(); process.exit(0); });
}

main().catch((err) => { console.error(err); process.exit(1); });
