/**
 * 23 — Temporal Data Quality: Temporal Coherence + Boundary Values
 * via full Specmatic+plugin+Node stack.
 *
 * Verifies temporal ordering of timestamps across mutations and enforces
 * boundary-value constraints from the DSL schema.
 *
 * Tests:
 *   1-3:  Lead timestamp ordering (createdAt, lastContactedAt progression)
 *   4:    Sequential notes have increasing createdAt
 *   5:    Sequential line items have increasing addedAt
 *   6:    Sequential transcript entries have increasing sequenceNum
 *   7-11: Boundary value acceptance/rejection (quotas, dates, amounts, lengths)
 *
 * DSL files under test:
 *   tests/fixtures/crm/dsl/lead.yaml
 *   tests/fixtures/crm/dsl/lead-contact.yaml
 *   tests/fixtures/crm/dsl/lead-add-note.yaml
 *   tests/fixtures/crm/dsl/opportunity.yaml
 *   tests/fixtures/crm/dsl/opportunity-add-line-item.yaml
 *   tests/fixtures/crm/dsl/call.yaml
 *   tests/fixtures/crm/dsl/call-add-transcript.yaml
 *   tests/fixtures/crm/dsl/agent.yaml
 *   tests/fixtures/crm/dsl/campaign.yaml
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { fwd, getGraphNode, getEntityCount, javaAvailable } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

const AGENT_ID = '00000000-0000-7000-8000-000000000003';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';

describeWithJava('23 — Temporal Data Quality (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // --- 1. Lead createdAt is set on creation ---

  it('lead createdAt is a non-empty string after creation', async () => {
    const res = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Temporal Corp',
      contactName: 'TC User',
      phone: '+61 2 9100 0001',
      email: 'temporal@test.com',
      source: 'WEBSITE',
    });
    expect([200, 201]).toContain(res.status);
    const id = (res.body as JsonObject)['id'] as string;

    const node = await getGraphNode(app.engineUrl, id);
    expect(node).not.toBeNull();
    expect(typeof node!['createdAt']).toBe('string');
    expect((node!['createdAt'] as string).length).toBeGreaterThan(0);
  }, 60_000);

  // --- 2. Lead lastContactedAt > createdAt after contact ---

  it('lastContactedAt >= createdAt after contacting a lead', async () => {
    const res = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Time Order Corp',
      contactName: 'TO User',
      phone: '+61 2 9100 0002',
      email: 'timeorder@test.com',
      source: 'REFERRAL',
    });
    expect([200, 201]).toContain(res.status);
    const id = (res.body as JsonObject)['id'] as string;

    await fwd(app.engineUrl, 'POST', `/leads/${id}/contact`, {});

    const node = await getGraphNode(app.engineUrl, id);
    expect(node).not.toBeNull();
    const createdAt = new Date(node!['createdAt'] as string).getTime();
    const lastContactedAt = new Date(node!['lastContactedAt'] as string).getTime();
    expect(lastContactedAt).toBeGreaterThanOrEqual(createdAt);
  }, 60_000);

  // --- 3. Lead lastContactedAt updates on re-contact ---

  it('lastContactedAt updates to a newer timestamp on re-contact', async () => {
    const res = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Recontact Corp',
      contactName: 'RC User',
      phone: '+61 2 9100 0003',
      email: 'recontact@test.com',
      source: 'PARTNER',
    });
    expect([200, 201]).toContain(res.status);
    const id = (res.body as JsonObject)['id'] as string;

    // First contact
    await fwd(app.engineUrl, 'POST', `/leads/${id}/contact`, {});
    const nodeAfterFirst = await getGraphNode(app.engineUrl, id);
    const firstContactAt = new Date(nodeAfterFirst!['lastContactedAt'] as string).getTime();

    // Second contact
    await fwd(app.engineUrl, 'POST', `/leads/${id}/contact`, {});
    const nodeAfterSecond = await getGraphNode(app.engineUrl, id);
    const secondContactAt = new Date(nodeAfterSecond!['lastContactedAt'] as string).getTime();

    expect(secondContactAt).toBeGreaterThanOrEqual(firstContactAt);
  }, 60_000);

  // --- 4. Sequential notes have increasing createdAt ---

  it('sequential notes on a lead have increasing createdAt', async () => {
    const res = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Notes Corp',
      contactName: 'N User',
      phone: '+61 2 9100 0004',
      email: 'notes@test.com',
      source: 'WEBSITE',
    });
    expect([200, 201]).toContain(res.status);
    const id = (res.body as JsonObject)['id'] as string;

    // Add 2 notes sequentially
    await fwd(app.engineUrl, 'POST', `/leads/${id}/notes`, {
      text: 'First note',
      author: 'Agent A',
    });

    await fwd(app.engineUrl, 'POST', `/leads/${id}/notes`, {
      text: 'Second note',
      author: 'Agent B',
    });

    const node = await getGraphNode(app.engineUrl, id);
    expect(node).not.toBeNull();
    const notes = node!['notes'] as JsonObject[];
    expect(notes.length).toBe(2);

    const firstCreatedAt = new Date(notes[0]['createdAt'] as string).getTime();
    const secondCreatedAt = new Date(notes[1]['createdAt'] as string).getTime();
    expect(secondCreatedAt).toBeGreaterThanOrEqual(firstCreatedAt);
  }, 60_000);

  // --- 5. Sequential line items have increasing addedAt ---

  it('sequential line items on an opportunity have increasing addedAt', async () => {
    // Create opportunity via full lead lifecycle + saga
    const leadRes = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'LineItem Corp',
      contactName: 'LI User',
      phone: '+61 2 9100 0005',
      email: 'lineitem@test.com',
      source: 'REFERRAL',
    });
    expect([200, 201]).toContain(leadRes.status);
    const leadId = (leadRes.body as JsonObject)['id'] as string;

    await fwd(app.engineUrl, 'POST', '/calls', {
      leadId,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'INTERESTED',
    });
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/convert`, {
      value: 50000,
      probability: 60,
    });

    // Find the created opportunity
    const opps = await fwd(app.engineUrl, 'GET', '/opportunities');
    const oppList = opps.body as JsonObject[];
    const opp = oppList.find(o => o['leadId'] === leadId);
    expect(opp).toBeDefined();
    const oppId = opp!['id'] as string;

    // Add 2 line items sequentially
    await fwd(app.engineUrl, 'POST', `/opportunities/${oppId}/line-items`, {
      description: 'First item',
      quantity: 2,
      unitPrice: 100,
    });

    await fwd(app.engineUrl, 'POST', `/opportunities/${oppId}/line-items`, {
      description: 'Second item',
      quantity: 3,
      unitPrice: 200,
    });

    const oppNode = await getGraphNode(app.engineUrl, oppId);
    expect(oppNode).not.toBeNull();
    const lineItems = oppNode!['lineItems'] as JsonObject[];
    expect(lineItems.length).toBe(2);

    const firstAddedAt = new Date(lineItems[0]['addedAt'] as string).getTime();
    const secondAddedAt = new Date(lineItems[1]['addedAt'] as string).getTime();
    expect(secondAddedAt).toBeGreaterThanOrEqual(firstAddedAt);
  }, 60_000);

  // --- 6. Sequential transcript entries have increasing sequenceNum ---

  it('sequential transcript entries have sequenceNum 1, 2, 3', async () => {
    const leadRes = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Transcript Corp',
      contactName: 'TR User',
      phone: '+61 2 9100 0006',
      email: 'transcript@test.com',
      source: 'COLD_LIST',
    });
    expect([200, 201]).toContain(leadRes.status);
    const leadId = (leadRes.body as JsonObject)['id'] as string;

    const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
      leadId,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'INTERESTED',
    });
    expect([200, 201]).toContain(callRes.status);
    const callId = (callRes.body as JsonObject)['id'] as string;

    // Add 3 transcript entries
    await fwd(app.engineUrl, 'POST', `/calls/${callId}/transcript`, {
      speaker: 'Agent',
      text: 'Hello, how are you?',
    });

    await fwd(app.engineUrl, 'POST', `/calls/${callId}/transcript`, {
      speaker: 'Customer',
      text: 'I am fine, thanks.',
    });

    await fwd(app.engineUrl, 'POST', `/calls/${callId}/transcript`, {
      speaker: 'Agent',
      text: 'Great, let me tell you about our product.',
    });

    const callNode = await getGraphNode(app.engineUrl, callId);
    expect(callNode).not.toBeNull();
    const transcript = callNode!['transcript'] as JsonObject[];
    expect(transcript.length).toBe(3);

    expect(transcript[0]['sequenceNum']).toBe(1);
    expect(transcript[1]['sequenceNum']).toBe(2);
    expect(transcript[2]['sequenceNum']).toBe(3);
  }, 60_000);

  // --- 7. Agent dailyCallQuota:1 (minimum valid boundary) ---

  it('agent with dailyCallQuota:1 is accepted (minimum valid boundary)', async () => {
    const res = await fwd(app.engineUrl, 'POST', '/agents', {
      name: 'Min Quota Agent',
      email: 'minquota@test.com',
      dailyCallQuota: 1,
      skills: [],
    });
    expect([200, 201]).toContain(res.status);
    const id = (res.body as JsonObject)['id'] as string;

    const node = await getGraphNode(app.engineUrl, id);
    expect(node).not.toBeNull();
    expect(node!['dailyCallQuota']).toBe(1);
  }, 60_000);

  // --- 8. Campaign startedAt equals endedAt -> rejected ---

  it('campaign with startedAt == endedAt is rejected by guard', async () => {
    const entityCountBefore = await getEntityCount(app.engineUrl);
    const sameDate = '2025-06-01T00:00:00.000Z';

    const res = await fwd(app.engineUrl, 'POST', '/campaigns', {
      name: 'Same Date Campaign',
      targetSource: 'WEBSITE',
      script: 'test',
      startedAt: sameDate,
      endedAt: sameDate,
      targetCalls: 100,
      targetConversions: 10,
    });
    expect(res.status).toBe(422);
    const details = (res.body as JsonObject)['details'] as Record<string, unknown> | undefined;
    expect(details?.['code']).toBe('INVALID_DATE_RANGE');

    // Entity count unchanged
    const entityCountAfter = await getEntityCount(app.engineUrl);
    expect(entityCountAfter).toBe(entityCountBefore);
  }, 60_000);

  // --- 9. Call durationSeconds:0 -> accepted ---

  it('call with durationSeconds:0 is accepted (minimum:0 in schema)', async () => {
    const leadRes = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'Zero Duration Corp',
      contactName: 'ZD User',
      phone: '+61 2 9100 0009',
      email: 'zeroduration@test.com',
      source: 'WEBSITE',
    });
    expect([200, 201]).toContain(leadRes.status);
    const leadId = (leadRes.body as JsonObject)['id'] as string;

    const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
      leadId,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'NO_ANSWER',
      durationSeconds: 0,
    });
    expect([200, 201]).toContain(callRes.status);
    const callId = (callRes.body as JsonObject)['id'] as string;

    const callNode = await getGraphNode(app.engineUrl, callId);
    expect(callNode).not.toBeNull();
    expect(callNode!['durationSeconds']).toBe(0);
  }, 60_000);

  // --- 10. Lead companyName with 1 char -> accepted ---

  it('lead with 1-character companyName is accepted (minLength:1)', async () => {
    const res = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'X',
      contactName: 'Y',
      phone: '+61 2 9100 0010',
      email: 'onechar@test.com',
      source: 'COLD_LIST',
    });
    expect([200, 201]).toContain(res.status);
    const id = (res.body as JsonObject)['id'] as string;

    const node = await getGraphNode(app.engineUrl, id);
    expect(node).not.toBeNull();
    expect(node!['companyName']).toBe('X');
  }, 60_000);

  // --- 11. Opportunity with value:0 -> rejected ---

  it('converting a lead with value:0 is rejected by the opportunity positive-value guard', async () => {
    // Opportunities are created only via the LeadConversionSaga (no POST
    // /opportunities in the contract). The saga forwards command.payload.value
    // into createOpportunity, whose positive-value guard requires value > 0.
    // Converting a qualified lead with value:0 must therefore fail the saga step
    // so that no Opportunity is created for that lead.
    const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
      companyName: 'ZeroValue Corp',
      contactName: 'ZV User',
      phone: '+61 2 9100 0011',
      email: 'zerovalue@test.com',
      source: 'WEBSITE',
      assignedAgentId: AGENT_ID,
      assignedCampaignId: CAMPAIGN_ID,
    });
    expect([200, 201]).toContain(createRes.status);
    const leadId = (createRes.body as JsonObject)['id'] as string;

    // Drive the lead to QUALIFIED so it can be converted.
    await fwd(app.engineUrl, 'POST', '/calls', {
      leadId,
      agentId: AGENT_ID,
      campaignId: CAMPAIGN_ID,
      outcome: 'INTERESTED',
    });
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});

    // Count opportunities before the value:0 conversion attempt.
    const oppsBeforeRes = await fwd(app.engineUrl, 'GET', '/opportunities');
    expect(oppsBeforeRes.status).toBe(200);
    const oppsBefore = oppsBeforeRes.body as unknown as Array<Record<string, unknown>>;
    const oppCountBefore = oppsBefore.length;

    // Convert with value:0 — the saga's createOpportunity step hits the
    // positive-value guard (command.payload.value > 0) and fails.
    await fwd(app.engineUrl, 'POST', `/leads/${leadId}/convert`, { value: 0 });

    // The guard rejected the opportunity, so no Opportunity exists for this lead
    // and the total opportunity count is unchanged.
    const oppsAfterRes = await fwd(app.engineUrl, 'GET', '/opportunities');
    expect(oppsAfterRes.status).toBe(200);
    const oppsAfter = oppsAfterRes.body as unknown as Array<Record<string, unknown>>;
    expect(oppsAfter.some((o) => o['leadId'] === leadId)).toBe(false);
    expect(oppsAfter.length).toBe(oppCountBefore);
  }, 60_000);
});
