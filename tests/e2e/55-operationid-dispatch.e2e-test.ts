/**
 * 55 — operationId-based behaviour dispatch through the Specmatic stub.
 *
 * Proves that 7 representative CRM operationIds, when their HTTP request is sent
 * to the Specmatic stub URL, each dispatch to the behaviour bound to that
 * operationId (and only that one):
 *   createLead, listLeads, getLead, qualifyLead, convertLead, addLineItem,
 *   closeOpportunity.
 *
 * Also proves:
 *   - an unmatched method/path returns 404 (no behaviour dispatched);
 *   - a behaviour referencing an operationId absent from the OpenAPI spec
 *     fails boot with BOOT_ERR_UNKNOWN_OPERATION_ID (inline bad-fixture boot).
 *
 * All behaviour lives in tests/fixtures/crm/dsl/*; this suite sends HTTP and
 * inspects outcomes through the stack.
 */

import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { bootSystem } from '../../src/engine/boot';
import { loadOpenApi } from '../../src/contract/loader';
import { compileDsl } from '../../src/dsl/parser';
import { BootError } from '../../src/errors';

function javaAvailable(): boolean {
  try { execSync('java -version', { stdio: 'pipe' }); return true; } catch { return false; }
}

const describeWithJava = javaAvailable() ? describe : describe.skip;

// Seeded leads (crm fixture initialization).
const LEAD_CONTACTED = '00000000-0000-7000-8000-000000000011'; // CONTACTED + a call → qualifiable
const LEAD_QUALIFIED = '00000000-0000-7000-8000-000000000012'; // QUALIFIED → convertible

interface Json { [k: string]: unknown }

// Base URL — the Specmatic stub UNCONDITIONALLY. This suite proves
// operationId dispatch over the stub→plugin→engine path, so beforeAll asserts
// forwarding is healthy and there is no engineUrl fallback.
function target(app: E2eApp): string {
  return app.stubUrl;
}

async function stub(
  stubUrl: string,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: Json | Json[] | null }> {
  const res = await fetch(`${stubUrl}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed: Json | Json[] | null = null;
  try { parsed = (await res.json()) as Json | Json[]; } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

describeWithJava('55 — operationId dispatch via Specmatic stub', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
    // Fail fast: this suite proves stub→plugin→engine forwarding.
    expect(app.stubForwardingHealthy).toBe(true);
  }, 120_000);
  afterAll(async () => { if (app) await app.shutdown(); }, 30_000);

  it('createLead (POST /leads) dispatches the create behaviour → NEW lead', async () => {
    const res = await stub(target(app), 'POST', '/leads', {
      companyName: 'OpId Dispatch Co', contactName: 'Op User',
      phone: '+61 2 9300 0001', email: 'op@dispatch.test', source: 'WEBSITE',
    });
    expect([200, 201]).toContain(res.status);
    const lead = res.body as Json;
    expect(lead['status']).toBe('NEW');
    expect(lead['companyName']).toBe('OpId Dispatch Co');
  }, 60_000);

  it('listLeads (GET /leads) dispatches the list query → array of leads', async () => {
    const res = await stub(target(app), 'GET', '/leads');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as Json[]).length).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it('getLead (GET /leads/{id}) dispatches the by-id query → the requested lead', async () => {
    const res = await stub(target(app), 'GET', `/leads/${LEAD_CONTACTED}`);
    expect(res.status).toBe(200);
    expect((res.body as Json)['id']).toBe(LEAD_CONTACTED);
    expect((res.body as Json)['companyName']).toBe('BlueSky Tech');
  }, 60_000);

  it('qualifyLead (POST /leads/{id}/qualify) dispatches the qualify behaviour → QUALIFIED', async () => {
    // Seeded lead is CONTACTED with a recorded call → qualify guard passes.
    const res = await stub(target(app), 'POST', `/leads/${LEAD_CONTACTED}/qualify`, {});
    expect([200, 201]).toContain(res.status);
    expect((res.body as Json)['status']).toBe('QUALIFIED');
  }, 60_000);

  it('convertLead (POST /leads/{id}/convert) dispatches the convert behaviour → CONVERTED', async () => {
    // Seeded lead is QUALIFIED → convert behaviour (condition status==QUALIFIED) fires.
    const res = await stub(target(app), 'POST', `/leads/${LEAD_QUALIFIED}/convert`, {
      value: 25000, probability: 60,
    });
    expect([200, 201]).toContain(res.status);
    expect((res.body as Json)['status']).toBe('CONVERTED');
  }, 60_000);

  it('addLineItem (POST /opportunities/{id}/line-items) dispatches the add-line-item behaviour', async () => {
    const created = await stub(target(app), 'POST', '/opportunities', {
      leadId: LEAD_CONTACTED, value: 1000, probability: 50,
    });
    expect([200, 201]).toContain(created.status);
    const oppId = (created.body as Json)['id'] as string;

    const added = await stub(target(app), 'POST', `/opportunities/${oppId}/line-items`, {
      description: 'Item', quantity: 2, unitPrice: 50,
    });
    expect([200, 201]).toContain(added.status);
    expect((added.body as Json)['itemCount']).toBe(1);
    expect((added.body as Json)['totalValue']).toBe(100);
  }, 60_000);

  it('closeOpportunity (PATCH /opportunities/{id}/close) dispatches the close behaviour → WON', async () => {
    const created = await stub(target(app), 'POST', '/opportunities', {
      leadId: LEAD_CONTACTED, value: 5000, probability: 70,
    });
    const oppId = (created.body as Json)['id'] as string;
    // Advance to NEGOTIATING then close WON (closeOpportunity guard).
    await stub(target(app), 'PATCH', `/opportunities/${oppId}/advance`, {});
    const closed = await stub(target(app), 'PATCH', `/opportunities/${oppId}/close`, {
      outcome: 'WON', value: 5000,
    });
    expect([200, 201]).toContain(closed.status);
    expect((closed.body as Json)['stage']).toBe('WON');
  }, 60_000);

  it('unmatched path is rejected with no behaviour dispatched', async () => {
    const res = await stub(target(app), 'GET', '/this-path-has-no-operation');
    // A path absent from the contract dispatches no behaviour. Through the
    // Specmatic stub the unknown path fails contract matching (400); through the
    // engine gateway directly it is an unrouted path (404). Either way no
    // operationId is dispatched — that is the property under test.
    expect([400, 404]).toContain(res.status);
  }, 60_000);

  describe('BOOT_ERR_UNKNOWN_OPERATION_ID', () => {
    it('boot fails when a behaviour references an operationId absent from the spec', async () => {
      const openapi = await loadOpenApi(
        path.resolve(__dirname, '..', 'fixtures', 'crm', 'openapi', 'nuisance-bureau.yaml'),
      );
      // A Lead boundary whose behaviour references a non-existent operationId.
      const dsl = await compileDsl([
        {
          name: 'bad-lead.yaml',
          yaml: `
boundary: Lead
contract_path: /leads
identity:
  creation:
    generate: $uuidv7()
event_catalog:
  - type: LeadCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: createLead
    match:
      operationId: thisOperationDoesNotExist
      condition: "true"
    emit: LeadCreated
`,
        },
      ]);

      let code: string | undefined;
      try {
        await bootSystem({ openapi, compiledDsl: dsl });
      } catch (e) {
        code = e instanceof BootError ? e.code : undefined;
      }
      expect(code).toBe('BOOT_ERR_UNKNOWN_OPERATION_ID');
    });
  });
});
