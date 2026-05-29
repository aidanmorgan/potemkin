/**
 * 24 — Ephemeral Lifecycle: Boot/Reset/Isolation via full Specmatic stack.
 *
 * Tests the lifecycle management of the CRM DSL system:
 *   - Reset completeness (graph/events/idempotency restored to baseline)
 *   - Boot determinism (identical state across separate boots)
 *   - Parallel isolation (two booted systems do not share state)
 *   - Boot performance (completes within acceptable time)
 *
 * Each describe block manages its own boot/shutdown lifecycle to test
 * independent system instances.
 *
 * DSL files under test:
 *   All CRM DSL boundary YAML files + global.yaml
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd, getGraphNode, getEntityCount, getEventCount, getAllEntities,
  adminReset, javaAvailable,
} from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

const APEX_LEAD_NEW = '00000000-0000-7000-8000-000000000010';
const AGENT_ID = '00000000-0000-7000-8000-000000000003';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';

// ---------------------------------------------------------------------------
// Section 1: Reset completeness
// ---------------------------------------------------------------------------

describeWithJava('24 — Ephemeral Lifecycle: reset completeness (full Specmatic stack)', () => {
  let app: E2eApp;
  let newLeadId: string;
  let idempotencyKey: string;

  beforeAll(async () => {
    app = await startE2eApp();

    // Create a new entity
    const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Ephemeral Corp',
      contactName: 'EP User',
      phone: '+61 2 9200 0001',
      email: 'ephemeral@test.com',
      source: 'WEBSITE',
    });
    expect([200, 201]).toContain(createRes.status);
    newLeadId = (createRes.body as JsonObject)['id'] as string;

    // Modify a seeded entity (contact the Apex lead to change status to CONTACTED)
    await fwd(app.engineUrl, 'POST', `/leads/${APEX_LEAD_NEW}/contact`, {});

    // Use an idempotency key so we can test cache clearing
    idempotencyKey = `reset-test-${Date.now()}`;
    await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Idem Reset Corp',
      contactName: 'IR',
      phone: '+61 0',
      email: 'idemreset@t.com',
      source: 'COLD_LIST',
    }, { 'idempotency-key': idempotencyKey });
  }, 120_000);

  afterAll(async () => { await app.shutdown(); }, 30_000);

  // --- 1. POST /_admin/reset clears state ---

  it('POST /_admin/reset succeeds', async () => {
    await adminReset(app.engineUrl);
  }, 60_000);

  // --- 2. After reset: graph size === 10 (5 leads + 2 campaigns + 3 agents) ---

  it('after reset: graph size matches baseline (10 seeded entities)', async () => {
    const count = await getEntityCount(app.engineUrl);
    expect(count).toBe(10);
  }, 60_000);

  // --- 3. After reset: event count matches baseline ---

  it('after reset: event count equals baseline (10 seeded events)', async () => {
    const count = await getEventCount(app.engineUrl);
    expect(count).toBe(10);
  }, 60_000);

  // --- 4. After reset: created entity gone ---

  it('after reset: dynamically created entity is gone from graph', async () => {
    const node = await getGraphNode(app.engineUrl, newLeadId);
    expect(node).toBeNull();
  }, 60_000);

  // --- 5. After reset: seeded entity state restored ---

  it('after reset: seeded entity status restored to NEW', async () => {
    const node = await getGraphNode(app.engineUrl, APEX_LEAD_NEW);
    expect(node).not.toBeNull();
    expect(node!['status']).toBe('NEW');
  }, 60_000);

  // --- 6. After reset: idempotency cache cleared ---

  it('after reset: previously-used idempotency key succeeds as new request', async () => {
    // Replay the same idempotency key with the same body -- should succeed
    // as a new command (not replay), proving the cache was cleared
    const res = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Idem Reset Corp',
      contactName: 'IR',
      phone: '+61 0',
      email: 'idemreset@t.com',
      source: 'COLD_LIST',
    }, { 'idempotency-key': idempotencyKey });

    expect([200, 201]).toContain(res.status);
    // If the idempotency cache was NOT cleared, this would be a replay
    // and would return the old entity ID. Since reset clears it, it creates a new one.
    expect(res.headers?.['x-idempotency-replay']).toBeUndefined();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Section 2: Boot determinism
// ---------------------------------------------------------------------------

describeWithJava('24 — Ephemeral Lifecycle: boot determinism (full Specmatic stack)', () => {
  it('two boots produce identical graph size, event counts, and seeded field values', async () => {
    // Boot A
    const appA = await startE2eApp();
    const sizeA = await getEntityCount(appA.engineUrl);
    const eventCountA = await getEventCount(appA.engineUrl);
    const leadA = await getGraphNode(appA.engineUrl, APEX_LEAD_NEW);
    await appA.shutdown();

    // Boot B
    const appB = await startE2eApp();
    const sizeB = await getEntityCount(appB.engineUrl);
    const eventCountB = await getEventCount(appB.engineUrl);
    const leadB = await getGraphNode(appB.engineUrl, APEX_LEAD_NEW);
    await appB.shutdown();

    // 7. Identical graph size
    expect(sizeA).toBe(sizeB);

    // 8. Identical event counts
    expect(eventCountA).toBe(eventCountB);

    // 9. Identical seeded entity field values
    expect(leadA!['companyName']).toBe(leadB!['companyName']);
    expect(leadA!['status']).toBe(leadB!['status']);
    expect(leadA!['score']).toBe(leadB!['score']);
    expect(leadA!['companyName']).toBe('Apex Solutions Ltd');
    expect(leadA!['status']).toBe('NEW');
    expect(leadA!['score']).toBe(50);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// Section 3: Parallel isolation
// ---------------------------------------------------------------------------

describeWithJava('24 — Ephemeral Lifecycle: parallel isolation (full Specmatic stack)', () => {
  it('mutation in system A does not affect system B', async () => {
    // Boot two systems simultaneously
    const [appA, appB] = await Promise.all([
      startE2eApp(),
      startE2eApp(),
    ]);

    try {
      // Verify both start with the same baseline
      const sizeA = await getEntityCount(appA.engineUrl);
      const sizeB = await getEntityCount(appB.engineUrl);
      expect(sizeA).toBe(sizeB);

      // 10. Contact a lead in system A -- verify B is unaffected
      await fwd(appA.engineUrl, 'POST', `/leads/${APEX_LEAD_NEW}/contact`, {});
      const nodeA = await getGraphNode(appA.engineUrl, APEX_LEAD_NEW);
      expect(nodeA!['status']).toBe('CONTACTED');

      const nodeB = await getGraphNode(appB.engineUrl, APEX_LEAD_NEW);
      expect(nodeB!['status']).toBe('NEW');

      // Create an additional lead in A to diverge event counts
      await fwd(appA.engineUrl, 'POST', '/leads', {
        companyName: 'Isolation Corp',
        contactName: 'IC',
        phone: '+61 0',
        email: 'isolation@t.com',
        source: 'WEBSITE',
      });

      // 11. Event counts diverge independently
      const eventsA = await getEventCount(appA.engineUrl);
      const eventsB = await getEventCount(appB.engineUrl);
      expect(eventsA).toBeGreaterThan(eventsB);
    } finally {
      await appA.shutdown();
      await appB.shutdown();
    }
  }, 300_000);
});

// ---------------------------------------------------------------------------
// Section 4: Boot performance
// ---------------------------------------------------------------------------

describeWithJava('24 — Ephemeral Lifecycle: boot performance (full Specmatic stack)', () => {
  it('startE2eApp() completes in under 120 seconds', async () => {
    const start = Date.now();
    const app = await startE2eApp();
    const elapsed = Date.now() - start;

    try {
      expect(elapsed).toBeLessThan(120_000);
      // Verify the boot actually produced a working system
      const count = await getEntityCount(app.engineUrl);
      expect(count).toBe(10);
    } finally {
      await app.shutdown();
    }
  }, 180_000);
});
