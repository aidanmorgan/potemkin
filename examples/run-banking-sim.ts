import { bootSystem, createGateway } from '../src/index.js';
import { loadBankingFixture } from '../tests/fixtures/index.js';

async function main(): Promise<void> {
  const fixture = await loadBankingFixture();
  const sys = await bootSystem(fixture);
  const app = createGateway(sys);
  app.listen(3000, () => {
    console.log('ready on 3000');
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
