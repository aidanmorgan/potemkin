/**
 * 00 — Bootstrap: plugin loads via SPI; control server responds.
 *
 * Verifies:
 *  - Specmatic starts cleanly with the plugin on the classpath.
 *  - The plugin's control server is listening on the allocated port.
 *  - GET /health on the control server returns a 200 with a JSON body that
 *    includes a `state` field.
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

describeWithJava('00 — Bootstrap: Specmatic + plugin SPI load', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('Specmatic stub server is reachable', async () => {
    const res = await fetch(`${app.stubUrl}/`);
    // Specmatic returns 404 on unknown paths but the server IS up
    expect([200, 400, 404]).toContain(res.status);
  }, 60_000);

  it('plugin control server responds to GET /health', async () => {
    const res = await fetch(`${app.pluginControlUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body['state']).toBe('string');
  }, 60_000);

  it('plugin control server health state is a known HealthState value', async () => {
    const res = await fetch(`${app.pluginControlUrl}/health`);
    const body = await res.json() as { state: string };
    expect(['UP', 'DEGRADED', 'DOWN']).toContain(body.state);
  }, 60_000);
});
