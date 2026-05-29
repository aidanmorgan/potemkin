/**
 * 15 — Event Stream Integrity via full Specmatic stack.
 *
 * Verifies the event store is the source of truth for the CRM system
 * by inspecting events via /_admin/events after mutations through
 * the full Specmatic+plugin+Node pipeline.
 */

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { fwd, getGraphNode, getEventsByAggregate, getAllEvents } from './_harness/crm-e2e-helpers';
import type { JsonObject, DomainEvent } from './_harness/crm-e2e-helpers';

function javaAvailable(): boolean {
  try { execSync('java -version', { stdio: 'pipe' }); return true; } catch { return false; }
}
const describeWithJava = javaAvailable() ? describe : describe.skip;

const AGENT_ID = '00000000-0000-7000-8000-000000000003';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';

describeWithJava('15 — Event Stream Integrity (full Specmatic stack)', () => {
  let app: E2eApp;
  let leadId: string;

  beforeAll(async () => {
    app = await startE2eApp();

    // Create a lead and progress it: create → call → contact → qualify
    const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'EventStream E2E Corp', contactName: 'ES',
      phone: '+61 0', email: 'es@e2e.test', source: 'REFERRAL',
    });
    leadId = (createRes.body as JsonObject)['id'] as string;

    await fwd(app.engineUrl, 'POST', '/calls', {
      leadId, agentId: AGENT_ID, campaignId: CAMPAIGN_ID, outcome: 'INTERESTED',
    });
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
  }, 120_000);

  afterAll(async () => { await app.shutdown(); }, 30_000);

  it('events per aggregate have monotonically increasing sequenceVersion', async () => {
    const events = await getEventsByAggregate(app.engineUrl, leadId);
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].sequenceVersion).toBeGreaterThan(events[i - 1].sequenceVersion);
    }
  }, 60_000);

  it('events have non-decreasing timestamps', async () => {
    const events = await getEventsByAggregate(app.engineUrl, leadId);
    for (let i = 1; i < events.length; i++) {
      expect(new Date(events[i].timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(events[i - 1].timestamp).getTime(),
      );
    }
  }, 60_000);

  it('every event has required DomainEvent fields', async () => {
    const events = await getAllEvents(app.engineUrl);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(typeof event.eventId).toBe('string');
      expect(typeof event.boundary).toBe('string');
      expect(typeof event.aggregateId).toBe('string');
      expect(typeof event.type).toBe('string');
      expect(typeof event.payload).toBe('object');
      expect(typeof event.timestamp).toBe('string');
      expect(typeof event.sequenceVersion).toBe('number');
    }
  }, 60_000);

  it('LeadCreated event payload matches DSL event_catalog definition', async () => {
    const events = await getEventsByAggregate(app.engineUrl, leadId);
    const created = events.find(e => e.type === 'LeadCreated')!;
    expect(created.payload['companyName']).toBe('EventStream E2E Corp');
    expect(created.payload['status']).toBe('NEW');
    expect(created.payload['score']).toBe(80);
  }, 60_000);

  it('event stream contains correct event types for full lifecycle', async () => {
    const events = await getEventsByAggregate(app.engineUrl, leadId);
    const types = events.map(e => e.type);
    expect(types).toContain('LeadCreated');
    expect(types).toContain('CallIdAppended');
    expect(types).toContain('LeadContacted');
    expect(types).toContain('LeadQualified');
  }, 60_000);

  it('successful command produces events, rejected command produces none', async () => {
    const eventsBefore = await getEventsByAggregate(app.engineUrl, leadId);
    const countBefore = eventsBefore.length;

    // Already QUALIFIED — re-qualifying should fail (422)
    const qualRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
    expect([422]).toContain(qualRes.status);

    const eventsAfter = await getEventsByAggregate(app.engineUrl, leadId);
    expect(eventsAfter.length).toBe(countBefore); // no new events
  }, 60_000);
});
