/**
 * RBAC: POST /leads/{id}/dnc without manager scope → 403;
 * with manager scope → 200.
 *
 * The DNC behavior requires `required_scopes: [manager]` in the DSL.
 * We drive this through the public Specmatic URL and assert the engine's RBAC behavior
 * from Specmatic stub response matching.
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/crm-e2e-helpers';

async function postForward(
  stubUrl: string,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return requestThroughSpecmatic(stubUrl, method, path, body, headers);
}

/**
 * Create a simulation-shortcut Authorization header.
 * The engine's extractActor() expects `Bearer <actorId>:<scope1>,<scope2>`.
 */
function bearerToken(id: string, scopes: string[]): string {
  return `Bearer ${id}:${scopes.join(',')}`;
}

describe('RBAC: DNC requires manager scope', () => {
  let app: E2eApp;
  let freshLeadId: string;

  beforeAll(async () => {
    app = await startE2eApp();

    // Create a fresh lead for DNC tests (need a NEW lead)
    const createResult = await postForward(app.stubUrl, 'POST', '/leads', {
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
    const result = await postForward(app.stubUrl, 'POST', `/leads/${freshLeadId}/dnc`, {
      reason: 'Test',
    });
    // No auth header → should be 401 or 403
    expect([401, 403]).toContain(result.status);
  }, 60_000);

  it('POST /leads/{id}/dnc with non-manager scope → 403', async () => {
    const result = await postForward(
      app.stubUrl,
      'POST',
      `/leads/${freshLeadId}/dnc`,
      { reason: 'Test' },
      { authorization: bearerToken('agent1', ['agent', 'viewer']) },
    );
    expect(result.status).toBe(403);
  }, 60_000);

  it('POST /leads/{id}/dnc with manager scope → 200', async () => {
    // Create a second fresh lead for the DNC success test (in case freshLeadId is already DNC'd)
    const secondCreate = await postForward(app.stubUrl, 'POST', '/leads', {
      companyName: 'RBAC Manager Test Corp',
      contactName: 'Manager User',
      phone: '+61 2 9900 1002',
      email: 'rbacmgr@test.com',
      source: 'WEBSITE',
    });
    const managerTestLeadId = (secondCreate.body as Record<string, unknown>)['id'] as string;

    const result = await postForward(
      app.stubUrl,
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
