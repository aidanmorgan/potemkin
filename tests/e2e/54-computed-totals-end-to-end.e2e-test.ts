/**
 * 54 — G3: Opportunity computed fields (totalValue = sum(lineItems.*.lineTotal),
 * itemCount = length(lineItems)) recompute end-to-end through the Specmatic
 * stub as line items are added.
 *
 * Drives a 3-line-item sequence through the Specmatic stub URL and asserts:
 *  - GET /opportunities/{id} (served by Specmatic) reports the correct
 *    totalValue + itemCount after each addition;
 *  - GET /_engine/state/Opportunity/{id} reports the same totals AND lists the
 *    computed fields in _meta.computedFields (C4 surface).
 *
 * The computed-field formulas + the addLineItem behaviour live entirely in the
 * CRM fixtures (tests/fixtures/crm/dsl/opportunity-add-line-item.yaml).
 */

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';

function javaAvailable(): boolean {
  try { execSync('java -version', { stdio: 'pipe' }); return true; } catch { return false; }
}

const describeWithJava = javaAvailable() ? describe : describe.skip;

const SEEDED_LEAD = '00000000-0000-7000-8000-000000000010';

interface OpportunityState {
  id: string;
  lineItems?: Array<{ lineTotal: number }>;
  totalValue?: number;
  itemCount?: number;
}

// Requests target the Specmatic stub UNCONDITIONALLY — this suite proves the
// stub→plugin→engine forwarding path, so beforeAll asserts forwarding is
// healthy and there is no engineUrl fallback.
function target(app: E2eApp): string {
  return app.stubUrl;
}

async function createOpportunityViaStub(stubUrl: string): Promise<string> {
  const res = await fetch(`${stubUrl}/opportunities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId: SEEDED_LEAD, value: 1000, probability: 50 }),
  });
  expect([200, 201]).toContain(res.status);
  const body = (await res.json()) as OpportunityState;
  expect(body.id).toBeTruthy();
  return body.id;
}

async function addLineItemViaStub(
  stubUrl: string,
  oppId: string,
  item: { description: string; quantity: number; unitPrice: number },
): Promise<OpportunityState> {
  const res = await fetch(`${stubUrl}/opportunities/${oppId}/line-items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  expect([200, 201]).toContain(res.status);
  return (await res.json()) as OpportunityState;
}

async function getOpportunityViaStub(stubUrl: string, oppId: string): Promise<OpportunityState> {
  const res = await fetch(`${stubUrl}/opportunities/${oppId}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as OpportunityState;
}

describeWithJava('54 — G3: Opportunity computed totalValue + itemCount via Specmatic', () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp();
    // Fail fast: this suite proves stub→plugin→engine forwarding.
    expect(app.stubForwardingHealthy).toBe(true);
  }, 120_000);
  afterAll(async () => { if (app) await app.shutdown(); }, 30_000);

  it('totalValue + itemCount recompute through the stub across a 3-line-item sequence', async () => {
    const oppId = await createOpportunityViaStub(target(app));

    // Line item 1: 2 × 100 = 200
    const after1 = await addLineItemViaStub(target(app), oppId, {
      description: 'Widget A', quantity: 2, unitPrice: 100,
    });
    expect(after1.itemCount).toBe(1);
    expect(after1.totalValue).toBe(200);

    // Line item 2: 3 × 50 = 150 → running total 350
    const after2 = await addLineItemViaStub(target(app), oppId, {
      description: 'Widget B', quantity: 3, unitPrice: 50,
    });
    expect(after2.itemCount).toBe(2);
    expect(after2.totalValue).toBe(350);

    // Line item 3: 5 × 20 = 100 → running total 450
    const after3 = await addLineItemViaStub(target(app), oppId, {
      description: 'Widget C', quantity: 5, unitPrice: 20,
    });
    expect(after3.itemCount).toBe(3);
    expect(after3.totalValue).toBe(450);

    // GET /opportunities/{id} via the stub reports the final totals.
    const fetched = await getOpportunityViaStub(target(app), oppId);
    expect(fetched.itemCount).toBe(3);
    expect(fetched.totalValue).toBe(450);
    // totalValue equals the sum of each line's lineTotal.
    const sum = (fetched.lineItems ?? []).reduce((acc, i) => acc + i.lineTotal, 0);
    expect(fetched.totalValue).toBe(sum);
  }, 60_000);

  it('GET /_engine/state/Opportunity/{id} reports the same totals and carries _meta.computedFields', async () => {
    const oppId = await createOpportunityViaStub(target(app));
    await addLineItemViaStub(target(app), oppId, { description: 'X', quantity: 4, unitPrice: 25 });
    await addLineItemViaStub(target(app), oppId, { description: 'Y', quantity: 1, unitPrice: 100 });
    await addLineItemViaStub(target(app), oppId, { description: 'Z', quantity: 2, unitPrice: 10 });

    const res = await fetch(`${app.engineUrl}/_engine/state/Opportunity/${oppId}`);
    expect(res.status).toBe(200);
    // GET /_engine/state merges the entity state fields at the top level and
    // attaches a _meta block carrying the computed-field surface (C4).
    const body = (await res.json()) as OpportunityState & {
      _meta: { computedFields: string[]; version: number };
    };

    // 4*25 + 1*100 + 2*10 = 100 + 100 + 20 = 220
    expect(body.itemCount).toBe(3);
    expect(body.totalValue).toBe(220);

    // The C4 computed-field surface is present (array of declared computed names
    // for the boundary, in topological order).
    expect(Array.isArray(body._meta.computedFields)).toBe(true);
    expect(typeof body._meta.version).toBe('number');
  }, 60_000);
});
