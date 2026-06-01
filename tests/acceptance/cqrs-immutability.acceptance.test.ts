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

const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';
const AGENT_ID = '00000000-0000-7000-8000-000000000003';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';

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
    // Create a lead to generate some events
    const createRes = await app.agent
      .post('/leads')
      .send({
        companyName: 'CQRS Test Corp',
        contactName: 'CQRS User',
        phone: '+61 2 9000 1111',
        email: 'cqrs@testcorp.com',
        source: 'WEBSITE',
      })
      .expect(201);

    const leadId = createRes.body.id as string;

    // Retrieve events for this aggregate
    const eventsRes = await app.agent
      .get(`/_admin/events?aggregateId=${leadId}`)
      .expect(200);

    const events = eventsRes.body.events as Array<{ sequenceVersion: number }>;
    expect(events.length).toBeGreaterThan(0);

    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.sequenceVersion).toBeGreaterThan(events[i - 1]!.sequenceVersion);
    }
  });

  it('baseline lead events have sequenceVersion = 1', async () => {
    const apexEvents = await app.agent
      .get(`/_admin/events?aggregateId=${APEX_LEAD_ID}`)
      .expect(200);

    const events = apexEvents.body.events as Array<{ sequenceVersion: number }>;
    expect(events.length).toBe(1);
    expect(events[0]!.sequenceVersion).toBe(1);
  });

  it('events are append-only: hash of existing events does not change after new events added', async () => {
    // Get initial event hash
    const before = await app.agent.get('/_admin/events').expect(200);
    const beforeEvents = before.body.events as unknown[];
    const beforeHash = hashEvents(beforeEvents);
    const beforeCount = beforeEvents.length;

    // Add a new lead (which appends new events)
    await app.agent
      .post('/leads')
      .send({
        companyName: 'New Corp',
        contactName: 'New User',
        phone: '+61 2 9000 2222',
        email: 'new@newcorp.com',
        source: 'COLD_LIST',
      })
      .expect(201);

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

  it('each call log cascade produces events for both aggregate IDs', async () => {
    const callRes = await app.agent
      .post('/calls')
      .send({
        leadId: APEX_LEAD_ID,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED',
      })
      .expect(201);

    const callId = callRes.body.id as string;

    // Call events
    const callEvents = await app.agent.get(`/_admin/events?aggregateId=${callId}`).expect(200);
    expect(callEvents.body.events.length).toBeGreaterThanOrEqual(1);

    // Lead events (should now have 2: baseline + cascade callIdAppended)
    const leadEvents = await app.agent.get(`/_admin/events?aggregateId=${APEX_LEAD_ID}`).expect(200);
    expect(leadEvents.body.events.length).toBeGreaterThanOrEqual(2);
  });

  it('sequenceVersions for a single aggregate form a contiguous 1-based sequence', async () => {
    await app.agent
      .post('/calls')
      .send({
        leadId: APEX_LEAD_ID,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'NO_ANSWER',
      })
      .expect(201);

    // Log another call to the same lead to generate more events
    await app.agent
      .post('/calls')
      .send({
        leadId: APEX_LEAD_ID,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'CALLBACK_SCHEDULED',
      })
      .expect(201);

    // Check lead events for contiguous sequence
    const eventsRes = await app.agent
      .get(`/_admin/events?aggregateId=${APEX_LEAD_ID}`)
      .expect(200);

    const events = eventsRes.body.events as Array<{ sequenceVersion: number }>;
    expect(events.length).toBeGreaterThanOrEqual(3); // baseline + 2 cascade appends

    // Versions should be 1, 2, 3, ... (contiguous starting from 1)
    for (let i = 0; i < events.length; i++) {
      expect(events[i]!.sequenceVersion).toBe(i + 1);
    }
  });
});
