/**
 * 08 — Shutdown notification: Node engine sends /ready on boot and /shutdown
 * on SIGTERM; plugin reacts to both lifecycle signals.
 *
 * Verifies:
 *  1. After boot, the plugin control server has received at least one /ready.
 *     (We can't inspect the Ktor server's captured requests directly, but we
 *     can observe the health state which reflects /ready processing.)
 *  2. Stopping the engine (which sends /shutdown) transitions the plugin to Down.
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

async function getPluginHealthState(pluginControlUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${pluginControlUrl}/health`);
    if (res.status !== 200) return null;
    const body = await res.json() as { state: string };
    return body.state;
  } catch {
    return null;
  }
}

async function waitForState(
  pluginControlUrl: string,
  state: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await getPluginHealthState(pluginControlUrl);
    if (current === state) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

describeWithJava('08 — Shutdown notification: /ready and /shutdown lifecycle', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
    // Allow the engine's /ready notification to be processed
    await new Promise((r) => setTimeout(r, 2_000));
  }, 120_000);

  afterAll(async () => {
    await app.shutdown().catch(() => { /* may already be shut down */ });
  }, 30_000);

  // StubInitializer SPI is loaded by Specmatic ≥ 2.46.2.
  it('plugin health state is Up after engine boot (engine sent /ready)', async () => {
    const state = await getPluginHealthState(app.pluginControlUrl);
    expect(['UP', 'DEGRADED']).toContain(state);
  }, 60_000);

  it('stopping engine causes plugin to receive /shutdown and transition to Down', async () => {
    await app.engine.stop();
    const isDown = await waitForState(app.pluginControlUrl, 'DOWN', 5_000);
    expect(isDown).toBe(true);
  }, 60_000);
});
