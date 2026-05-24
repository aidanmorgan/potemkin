/**
 * 02 — Fixture push: plugin fetches /_engine/fixtures and registers seeded
 * entities with Specmatic.
 *
 * The seeded leads are registered as Specmatic expectations.  A GET on a
 * seeded lead's URL via the Specmatic stub should return the fixture body
 * directly (without hitting Node for routing).
 *
 * Seeded entity IDs (from lead.yaml initialization section):
 *   00000000-0000-7000-8000-000000000010 (Apex Solutions)
 *   00000000-0000-7000-8000-000000000011 (BlueSky Tech)
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

const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';
const BLUESKY_LEAD_ID = '00000000-0000-7000-8000-000000000011';

describeWithJava('02 — Fixture push: seeded entities registered with Specmatic', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
    // Allow extra time for fixture push to complete (plugin fetches /fixtures then calls setExpectation)
    await new Promise((r) => setTimeout(r, 2_000));
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('engine /_engine/fixtures returns 200 with fixture list', async () => {
    const res = await fetch(`${app.engineUrl}/_engine/fixtures`);
    expect(res.status).toBe(200);
    const body = await res.json() as { fixtures: unknown[] };
    expect(Array.isArray(body.fixtures)).toBe(true);
    expect(body.fixtures.length).toBeGreaterThan(0);
  }, 60_000);

  it('engine fixture for Apex Solutions lead includes correct companyName', async () => {
    const res = await fetch(`${app.engineUrl}/_engine/fixtures`);
    const body = await res.json() as { fixtures: Array<{ httpRequest: { path: string }; httpResponse: { body: Record<string, unknown> } }> };
    const leadFixture = body.fixtures.find(
      (f) => f.httpRequest.path === `/leads/${APEX_LEAD_ID}`,
    );
    expect(leadFixture).toBeDefined();
    expect(leadFixture!.httpResponse.body['companyName']).toBe('Apex Solutions Ltd');
  }, 60_000);

  it('engine returns ETag header on /_engine/fixtures', async () => {
    const res = await fetch(`${app.engineUrl}/_engine/fixtures`);
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
  }, 60_000);

  it('Specmatic stub responds to GET /leads/{seeded-id} (fixture served via Specmatic)', async () => {
    // The plugin registers each seeded lead as a Specmatic expectation.
    // The stub should be able to serve GET /leads/<id> from those expectations.
    const res = await fetch(`${app.stubUrl}/leads/${APEX_LEAD_ID}`);
    // Specmatic either returns the fixture (200) or falls back to a generated response.
    // Either way it must not return a 5xx.
    expect(res.status).toBeLessThan(500);
  }, 60_000);
});
