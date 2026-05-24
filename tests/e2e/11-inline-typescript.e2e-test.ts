/**
 * 11 — Inline TypeScript: create Lead; inline TS computeScore script runs in
 * Node engine; resulting score field present in entity.
 *
 * The lead.yaml DSL defines a `computeScore` script:
 *   source REFERRAL → score 80
 *   source PARTNER  → score 70
 *   source WEBSITE  → score 50
 *   source COLD_LIST → score 20
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

async function createLead(
  engineUrl: string,
  source: string,
  suffix: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${engineUrl}/_engine/forward`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'POST',
      path: '/leads',
      headers: {},
      query: {},
      body: {
        companyName: `Score Test Corp ${suffix}`,
        contactName: `Score User ${suffix}`,
        phone: `+61 2 9200 00${suffix}`,
        email: `score${suffix}@test.com`,
        source,
      },
    }),
  });
  return res.json() as Promise<{ status: number; body: Record<string, unknown> }>;
}

describeWithJava('11 — Inline TypeScript: computeScore script sets lead score', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('REFERRAL lead gets score 80', async () => {
    const result = await createLead(app.engineUrl, 'REFERRAL', '01');
    expect([200, 201]).toContain(result.status);
    expect(result.body['score']).toBe(80);
  }, 60_000);

  it('PARTNER lead gets score 70', async () => {
    const result = await createLead(app.engineUrl, 'PARTNER', '02');
    expect([200, 201]).toContain(result.status);
    expect(result.body['score']).toBe(70);
  }, 60_000);

  it('WEBSITE lead gets score 50', async () => {
    const result = await createLead(app.engineUrl, 'WEBSITE', '03');
    expect([200, 201]).toContain(result.status);
    expect(result.body['score']).toBe(50);
  }, 60_000);

  it('COLD_LIST lead gets score 20', async () => {
    const result = await createLead(app.engineUrl, 'COLD_LIST', '04');
    expect([200, 201]).toContain(result.status);
    expect(result.body['score']).toBe(20);
  }, 60_000);

  it('created lead has score field as integer', async () => {
    const result = await createLead(app.engineUrl, 'WEBSITE', '05');
    expect([200, 201]).toContain(result.status);
    expect(typeof result.body['score']).toBe('number');
    expect(Number.isInteger(result.body['score'])).toBe(true);
  }, 60_000);
});
