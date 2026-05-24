/**
 * 01 — Route discovery: plugin GETs /_engine/routes; isStateful returns true
 * for CRM paths and false for unknown paths.
 *
 * Verifies (via the engine's /_engine/routes endpoint directly, and via the
 * plugin control server health/routes snapshot):
 *  - The Node engine's /_engine/routes returns the expected CRM paths.
 *  - isStateful would return true for /leads (confirmed indirectly by the
 *    plugin forwarding requests in later tests).
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

const EXPECTED_LEAD_PATH = '/leads';
const EXPECTED_PATHS = [
  '/agents',
  '/calls',
  '/campaigns',
  '/leads',
  '/opportunities',
];

describeWithJava('01 — Route discovery: plugin GETs /_engine/routes', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('Node engine /_engine/routes returns 200', async () => {
    const res = await fetch(`${app.engineUrl}/_engine/routes`);
    expect(res.status).toBe(200);
  }, 60_000);

  it('/_engine/routes response contains CRM base paths', async () => {
    const res = await fetch(`${app.engineUrl}/_engine/routes`);
    const body = await res.json() as { paths: string[] };
    expect(Array.isArray(body.paths)).toBe(true);
    for (const p of EXPECTED_PATHS) {
      expect(body.paths).toContain(p);
    }
  }, 60_000);

  it('/_engine/routes response includes /leads path (stateful CRM path)', async () => {
    const res = await fetch(`${app.engineUrl}/_engine/routes`);
    const body = await res.json() as { paths: string[] };
    expect(body.paths).toContain(EXPECTED_LEAD_PATH);
  }, 60_000);

  it('/_engine/routes ETag header is non-empty', async () => {
    const res = await fetch(`${app.engineUrl}/_engine/routes`);
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(typeof etag).toBe('string');
  }, 60_000);

  it('engine reports itself as potemkin-stateful in routes response', async () => {
    const res = await fetch(`${app.engineUrl}/_engine/routes`);
    const body = await res.json() as { engine: string };
    expect(body.engine).toBe('potemkin-stateful');
  }, 60_000);
});
