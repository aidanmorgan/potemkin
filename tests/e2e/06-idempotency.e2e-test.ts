/**
 * 06 — Idempotency: POST /calls with Idempotency-Key; replay returns same
 * body + X-Idempotency-Replay: true.
 *
 * Uses the engine's /_engine/forward endpoint to avoid Specmatic matching
 * complexity.  The CRM fixture's global.yaml enables idempotency.
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
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';
const AGENT_ID = '00000000-0000-7000-8000-000000000003';

async function postForward(
  engineUrl: string,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${engineUrl}/_engine/forward`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, path, headers, query: {}, body }),
  });
  return res.json() as Promise<{ status: number; body: unknown; headers: Record<string, string> }>;
}

describeWithJava('06 — Idempotency: replay returns cached response', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('first POST /calls with Idempotency-Key creates the call (201)', async () => {
    const key = `idem-key-${Date.now()}-1`;
    const result = await postForward(
      app.engineUrl,
      'POST',
      '/calls',
      {
        leadId: APEX_LEAD_ID,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED',
      },
      { 'idempotency-key': key },
    );
    expect([200, 201]).toContain(result.status);
    expect(result.headers['x-idempotency-replay']).not.toBe('true');
  }, 60_000);

  it('second POST /calls with same Idempotency-Key returns X-Idempotency-Replay: true', async () => {
    const key = `idem-key-${Date.now()}-replay`;
    const callBody = {
      leadId: APEX_LEAD_ID,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'NO_ANSWER',
    };

    // First request — creates
    const first = await postForward(
      app.engineUrl,
      'POST',
      '/calls',
      callBody,
      { 'idempotency-key': key },
    );
    expect([200, 201]).toContain(first.status);
    const firstId = (first.body as Record<string, unknown>)['id'] as string;

    // Second request — should replay
    const second = await postForward(
      app.engineUrl,
      'POST',
      '/calls',
      callBody,
      { 'idempotency-key': key },
    );
    expect(second.status).toBe(first.status);
    expect((second.body as Record<string, unknown>)['id']).toBe(firstId);
    expect(second.headers['x-idempotency-replay']).toBe('true');
  }, 60_000);

  it('different Idempotency-Key produces a new call entity', async () => {
    const key1 = `idem-key-${Date.now()}-a`;
    const key2 = `idem-key-${Date.now()}-b`;
    const callBody = {
      leadId: APEX_LEAD_ID,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'CALLBACK_SCHEDULED',
    };

    const res1 = await postForward(app.engineUrl, 'POST', '/calls', callBody, { 'idempotency-key': key1 });
    const res2 = await postForward(app.engineUrl, 'POST', '/calls', callBody, { 'idempotency-key': key2 });

    const id1 = (res1.body as Record<string, unknown>)['id'] as string;
    const id2 = (res2.body as Record<string, unknown>)['id'] as string;

    // Different keys must produce different call IDs
    expect(id1).not.toBe(id2);
    expect(res2.headers['x-idempotency-replay']).not.toBe('true');
  }, 60_000);
});
