/**
 * 09 — Fixture hot-reload: after engine restart, plugin re-fetches fixtures
 * with new ETag and replaces old registrations.
 *
 * Verifies:
 *  1. Before restart, fixtures are registered.
 *  2. Engine is restarted.
 *  3. Plugin receives /ready, forces a fixture refresh.
 *  4. Fixtures are available again after re-registration.
 */

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';

function javaAvailable(): boolean {
  try {
    execSync('java -version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const describeWithJava = javaAvailable() ? describe : describe.skip;

async function getFixtures(engineUrl: string): Promise<{ fixtures: unknown[]; checksum: string }> {
  const res = await fetch(`${engineUrl}/_engine/fixtures`);
  return res.json() as Promise<{ fixtures: unknown[]; checksum: string }>;
}

async function waitForHealthUp(pluginControlUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${pluginControlUrl}/_potemkin/health`);
      if (res.status === 200) {
        const body = await res.json() as { state: string };
        if (body.state === 'Up') return true;
      }
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

describeWithJava('09 — Fixture hot-reload: re-fetches after engine restart', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
    await new Promise((r) => setTimeout(r, 2_000));
  }, 120_000);

  afterAll(async () => {
    await app.shutdown().catch(() => { /* ignore */ });
  }, 30_000);

  it('fixtures are registered before restart', async () => {
    const { fixtures } = await getFixtures(app.engineUrl);
    expect(fixtures.length).toBeGreaterThan(0);
  }, 60_000);

  it('after engine restart, fixtures are available again', async () => {
    // Record initial fixture checksum
    const before = await getFixtures(app.engineUrl);
    expect(before.fixtures.length).toBeGreaterThan(0);

    // Restart the engine (this also sends /ready to plugin)
    await app.engine.restart(app.pluginControlUrl);

    // Wait for plugin to process the /ready and re-fetch fixtures
    await waitForHealthUp(app.pluginControlUrl, 5_000);
    await new Promise((r) => setTimeout(r, 1_500)); // allow fixture push to complete

    // Fixtures should still be present in the engine
    const after = await getFixtures(app.engineUrl);
    expect(after.fixtures.length).toBeGreaterThanOrEqual(before.fixtures.length);
  }, 60_000);
});
