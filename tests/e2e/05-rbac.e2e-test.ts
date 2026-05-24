/**
 * 05 — RBAC: POST /leads/{id}/dnc without manager scope → 403;
 * with manager scope → 200.
 *
 * The DNC behavior requires `required_scopes: [manager]` in the DSL.
 * We drive this via the engine's /_engine/forward endpoint to isolate RBAC
 * from Specmatic stub response matching.
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

// Seeded NEW lead
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
  return res.json() as Promise<{ status: number; body: unknown }>;
}

/**
 * Create a simulation-shortcut Authorization header.
 * The engine's extractActor() expects `Bearer <actorId>:<scope1>,<scope2>`.
 */
function bearerToken(id: string, scopes: string[]): string {
  return `Bearer ${id}:${scopes.join(',')}`;
}

describeWithJava('05 — RBAC: DNC requires manager scope', () => {
  let app: E2eApp;
  let freshLeadId: string;

  beforeAll(async () => {
    app = await startE2eApp();

    // Create a fresh lead for DNC tests (need a NEW lead)
    const createResult = await postForward(app.engineUrl, 'POST', '/leads', {
      companyName: 'RBAC Test Corp',
      contactName: 'RBAC User',
      phone: '+61 2 9900 1001',
      email: 'rbac@test.com',
      source: 'WEBSITE',
    });
    freshLeadId = (createResult.body as Record<string, unknown>)['id'] as string;
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('POST /leads/{id}/dnc without Authorization header → 403', async () => {
    const result = await postForward(
      app.engineUrl,
      'POST',
      `/leads/${freshLeadId}/dnc`,
      { reason: 'Test' },
    );
    // No auth header → should be 401 or 403
    expect([401, 403]).toContain(result.status);
  }, 60_000);

  it('POST /leads/{id}/dnc with non-manager scope → 403', async () => {
    const result = await postForward(
      app.engineUrl,
      'POST',
      `/leads/${freshLeadId}/dnc`,
      { reason: 'Test' },
      { authorization: bearerToken('agent1', ['agent', 'viewer']) },
    );
    expect(result.status).toBe(403);
  }, 60_000);

  it('POST /leads/{id}/dnc with manager scope → 200', async () => {
    // Create a second fresh lead for the DNC success test (in case freshLeadId is already DNC'd)
    const secondCreate = await postForward(app.engineUrl, 'POST', '/leads', {
      companyName: 'RBAC Manager Test Corp',
      contactName: 'Manager User',
      phone: '+61 2 9900 1002',
      email: 'rbacmgr@test.com',
      source: 'WEBSITE',
    });
    const managerTestLeadId = (secondCreate.body as Record<string, unknown>)['id'] as string;

    const result = await postForward(
      app.engineUrl,
      'POST',
      `/leads/${managerTestLeadId}/dnc`,
      { reason: 'DNC requested by manager' },
      { authorization: bearerToken('mgr1', ['manager']) },
    );
    // 200 or 201 depending on engine intent classification
    expect([200, 201]).toContain(result.status);
    const body = result.body as Record<string, unknown>;
    expect(body['status']).toBe('DNC');
  }, 60_000);
});
