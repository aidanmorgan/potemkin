/**
 * 07 — Reliability: engine health monitoring and circuit breaker.
 *
 * Tests that:
 *  1. When the engine is running, the plugin's health state is Up.
 *  2. After sending /shutdown to the plugin control server, the state
 *     transitions to Down.
 *  3. The engine's health endpoint returns UP when running.
 *
 * Note: Full kill-and-restart cycle with 5s detection is tested here via
 * the control server's external mark-down/mark-up rather than a real process
 * kill, keeping test time within 60s.
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

async function waitForHealthState(
  pluginControlUrl: string,
  expectedState: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // /health reports DOWN with 503 and UP with 200; the state is in the body
      // regardless of status, so read it either way.
      const res = await fetch(`${pluginControlUrl}/health`);
      const body = await res.json() as { state?: string };
      if (body.state === expectedState) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

describeWithJava('07 — Reliability: plugin health monitoring', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
    // Give the health monitor time to observe the engine
    await new Promise((r) => setTimeout(r, 1_500));
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('engine health endpoint returns UP', async () => {
    const res = await fetch(`${app.engineUrl}/_engine/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('UP');
  }, 60_000);

  it('plugin control health reports Up when engine is running', async () => {
    const res = await fetch(`${app.pluginControlUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { state: string };
    expect(['UP', 'DEGRADED']).toContain(body.state);
  }, 60_000);

  it('sending POST /shutdown to plugin control transitions health to Down', async () => {
    const shutdownRes = await fetch(`${app.pluginControlUrl}/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine: 'potemkin-stateful',
        version: '0.1.0',
        reason: 'SIGTERM',
        stoppedAt: new Date().toISOString(),
      }),
    });
    expect([200, 204]).toContain(shutdownRes.status);
    const downNow = await waitForHealthState(app.pluginControlUrl, 'DOWN', 5_000);
    expect(downNow).toBe(true);
  }, 60_000);

  it('sending POST /ready to plugin control transitions health back to Up', async () => {
    await fetch(`${app.pluginControlUrl}/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: 'potemkin-stateful', version: '0.1.0', reason: 'SIGTERM', stoppedAt: new Date().toISOString() }),
    });
    await waitForHealthState(app.pluginControlUrl, 'DOWN', 3_000);
    const readyRes = await fetch(`${app.pluginControlUrl}/ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine: 'potemkin-stateful',
        version: '0.1.0',
        startedAt: new Date().toISOString(),
        contractPaths: ['/leads'],
        routesChecksum: 'abc',
        fixturesChecksum: 'def',
      }),
    });
    expect([200, 204]).toContain(readyRes.status);
    const upNow = await waitForHealthState(app.pluginControlUrl, 'UP', 5_000);
    expect(upNow).toBe(true);
  }, 60_000);
});
