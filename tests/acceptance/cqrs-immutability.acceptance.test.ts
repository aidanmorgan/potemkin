/**
 * cqrs-immutability.acceptance.test.ts
 *
 * Acceptance test:
 *  - Submit several mutations.
 *  - GET /_admin/events shows monotonically increasing sequenceVersion per aggregate.
 *  - Events array is never mutated after append (verify by hash).
 */

import { createTestApp, type TestApp } from './_helpers/test-app.js';
import { createHash } from 'crypto';

const ACME_ID = '00000000-0000-7000-8000-000000000001';

function hashEvents(events: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex');
}

describe('cqrs-immutability.acceptance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  it('sequenceVersion is monotonically increasing per aggregate across events', async () => {
    // Create a customer to generate some events
    const createRes = await app.agent
      .post('/customers')
      .send({ name: 'CQRS Test Customer', riskBand: 'MED' })
      .expect(201);

    const customerId = createRes.body.id as string;

    // Retrieve events for this aggregate
    const eventsRes = await app.agent
      .get(`/_admin/events?aggregateId=${customerId}`)
      .expect(200);

    const events = eventsRes.body.events as Array<{ sequenceVersion: number }>;
    expect(events.length).toBeGreaterThan(0);

    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.sequenceVersion).toBeGreaterThan(events[i - 1]!.sequenceVersion);
    }
  });

  it('baseline events have sequenceVersion = 1', async () => {
    const acmeEvents = await app.agent
      .get(`/_admin/events?aggregateId=${ACME_ID}`)
      .expect(200);

    const events = acmeEvents.body.events as Array<{ sequenceVersion: number }>;
    expect(events.length).toBe(1);
    expect(events[0]!.sequenceVersion).toBe(1);
  });

  it('events are append-only: hash of existing events does not change after new events added', async () => {
    // Get initial event hash
    const before = await app.agent.get('/_admin/events').expect(200);
    const beforeEvents = before.body.events as unknown[];
    const beforeHash = hashEvents(beforeEvents);
    const beforeCount = beforeEvents.length;

    // Add a new customer (which appends new events)
    await app.agent.post('/customers').send({ name: 'New', riskBand: 'LOW' }).expect(201);

    // Retrieve events again
    const after = await app.agent.get('/_admin/events').expect(200);
    const afterEvents = after.body.events as unknown[];

    // New events were appended (count grew)
    expect(afterEvents.length).toBeGreaterThan(beforeCount);

    // The first N events (the original ones) should be unchanged
    const originalSlice = afterEvents.slice(0, beforeCount);
    const originalHash = hashEvents(originalSlice);

    expect(originalHash).toBe(beforeHash);
  });

  // it.failing: BUG — POST /loans triggers loanIds append cascade, Bug 1 (SCHEMA_TYPE_MISMATCH).
  it.failing('each loan cascade produces events for both aggregate IDs', async () => {
    const loanRes = await app.agent
      .post('/loans')
      .send({ customerId: ACME_ID, principal: 500 })
      .expect(201);

    const loanId = loanRes.body.id as string;

    // Loan events
    const loanEvents = await app.agent.get(`/_admin/events?aggregateId=${loanId}`).expect(200);
    expect(loanEvents.body.events.length).toBeGreaterThanOrEqual(1);

    // Customer events (should now have 2: baseline + cascade)
    const customerEvents = await app.agent.get(`/_admin/events?aggregateId=${ACME_ID}`).expect(200);
    expect(customerEvents.body.events.length).toBeGreaterThanOrEqual(2);
  });

  // it.failing: BUG — POST /loans triggers loanIds append cascade, Bug 1 (SCHEMA_TYPE_MISMATCH).
  it.failing('sequenceVersions for a single aggregate form a contiguous 1-based sequence', async () => {
    const loanRes = await app.agent
      .post('/loans')
      .send({ customerId: ACME_ID, principal: 3000 })
      .expect(201);

    const loanId = loanRes.body.id as string;

    // Add a repayment to generate another event
    await app.agent.post(`/loans/${loanId}/repay`).send({ amount: 500 }).expect(200);

    const eventsRes = await app.agent
      .get(`/_admin/events?aggregateId=${loanId}`)
      .expect(200);

    const events = eventsRes.body.events as Array<{ sequenceVersion: number }>;
    expect(events.length).toBeGreaterThanOrEqual(2);

    // Versions should be 1, 2, 3, ... (contiguous starting from 1)
    for (let i = 0; i < events.length; i++) {
      expect(events[i]!.sequenceVersion).toBe(i + 1);
    }
  });
});
