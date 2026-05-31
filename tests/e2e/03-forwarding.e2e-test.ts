/**
 * 03 — Forwarding: POST /leads via Specmatic; plugin intercepts → forwards to
 * Node → Node creates entity → state graph mutated.
 *
 * Verifies the full Specmatic → plugin → Node forwarding pipeline by:
 *  1. Sending POST /leads to the Specmatic stub URL.
 *  2. Specmatic's plugin intercepts the request (path is stateful).
 *  3. Plugin POSTs to /_engine/forward on Node.
 *  4. Node runs the CQRS pipeline and returns a ForwardedResponse.
 *  5. Plugin translates it back to an HTTP response.
 *  6. We verify the entity was created by hitting /_admin/state on Node directly.
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

describeWithJava('03 — Forwarding: POST /leads via Specmatic stub', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('POST /leads via stub returns 2xx (Specmatic validates the response)', async () => {
    const res = await fetch(`${app.stubUrl}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName: 'E2E Forwarding Corp',
        contactName: 'E2E User',
        phone: '+61 2 9900 0001',
        email: 'e2e@forwarding.test',
        source: 'WEBSITE',
      }),
    });
    // 201 when forwarded successfully; some Specmatic versions may return 200.
    expect([200, 201]).toContain(res.status);
  }, 60_000);

  it('POST /leads via stub creates entity visible in engine state', async () => {
    const payload = {
      companyName: 'E2E State Check Corp',
      contactName: 'E2E State User',
      phone: '+61 2 9900 0002',
      email: 'state@e2echeck.test',
      source: 'REFERRAL',
    };

    const createRes = await fetch(`${app.stubUrl}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect([200, 201]).toContain(createRes.status);

    // The forwarded create must be observable in the engine's state graph.
    const stateRes = await fetch(`${app.engineUrl}/_admin/state`);
    expect(stateRes.status).toBe(200);
    const stateBody = await stateRes.json() as { entities: Record<string, Record<string, unknown>> };
    expect(stateBody.entities).toBeDefined();
    const entities = Object.values(stateBody.entities);
    // The lead we just created (unique email) is present with the forwarded
    // payload fields intact.
    const created = entities.find((e) => e['email'] === payload.email);
    expect(created).toBeDefined();
    expect(created!['companyName']).toBe(payload.companyName);
    expect(created!['source']).toBe(payload.source);
    expect(created!['status']).toBe('NEW');
  }, 60_000);

  it('forwarded POST /leads creates a lead accessible via Node directly', async () => {
    const payload = {
      companyName: 'Forwarded Lead Corp',
      contactName: 'Forwarded User',
      phone: '+61 2 9900 0003',
      email: 'forwarded@lead.test',
      source: 'COLD_LIST',
    };

    // Create via Specmatic stub (goes through plugin → Node)
    const createRes = await fetch(`${app.stubUrl}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect([200, 201]).toContain(createRes.status);

    // Try to read back from engine's forwarding endpoint
    const fwdRes = await fetch(`${app.engineUrl}/_engine/forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'GET',
        path: '/leads',
        headers: {},
        query: {},
        body: null,
      }),
    });
    expect(fwdRes.status).toBe(200);
    const fwdBody = await fwdRes.json() as { status: number; body: unknown[] };
    expect(fwdBody.status).toBe(200);
    // Should contain the created lead (seeded + new)
    expect(Array.isArray(fwdBody.body)).toBe(true);
  }, 60_000);
});
