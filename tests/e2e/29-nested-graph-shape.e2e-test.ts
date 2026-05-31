/**
 * 29 — Nested Object Graphs + Request/Response Shape Mismatches
 * via full Specmatic+plugin+Node stack.
 *
 * Demonstrates that the DSL can:
 *   1. Accept a SIMPLE flat request and produce a COMPLEX nested object in the graph
 *   2. Maintain deeply nested arrays of structured objects across sequential mutations
 *   3. Compute derived fields server-side that don't exist in the request
 *   4. Build up complex interrelated graph structures via sequential API calls
 *
 * Shape mismatches tested:
 *
 *   Lead Notes:
 *     Request:  POST { text: "...", author: "..." }     <- flat, 2 fields
 *     Graph:    notes[]: { id, text, author, createdAt } <- nested, 4 fields
 *
 *   Opportunity Line Items:
 *     Request:  POST { description, quantity, unitPrice } <- 3 fields, no total
 *     Graph:    lineItems[]: { id, description, quantity, unitPrice, total, addedAt } <- 6 fields
 *
 *   Call Transcript:
 *     Request:  POST { speaker, text }                  <- 2 fields
 *     Graph:    transcript[]: { speaker, text, timestamp, sequenceNum } <- enriched
 *
 * DSL files under test:
 *   tests/fixtures/crm/dsl/lead-add-note.yaml
 *   tests/fixtures/crm/dsl/opportunity-add-line-item.yaml
 *   tests/fixtures/crm/dsl/call-add-transcript.yaml
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd, getGraphNode, getEventsByAggregate, javaAvailable,
} from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

const AGENT_ID = '00000000-0000-7000-8000-000000000003';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';

describeWithJava('29 — Nested Graph Shape Mismatches (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // --- Lead Notes: flat request -> nested graph objects ---

  describe('Lead Notes: simple request -> complex nested graph node', () => {
    let leadId: string;

    beforeAll(async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Nested Notes Corp',
        contactName: 'NN User',
        phone: '+61 2 8000 0001',
        email: 'notes@nested.test',
        source: 'REFERRAL',
      });
      leadId = (res.body as JsonObject)['id'] as string;
    });

    it('graph node starts with empty notes array', async () => {
      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node!['notes']).toEqual([]);
    }, 60_000);

    it('POST { text, author } produces enriched note object in graph with id + createdAt', async () => {
      // Request shape: { text: string, author: string } -- FLAT, 2 fields
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/notes`, {
        text: 'Initial contact made via phone',
        author: 'Alice Thompson',
      });

      // Graph shape: notes[0] = { id, text, author, createdAt } -- NESTED, 4 fields
      const node = await getGraphNode(app.engineUrl, leadId);
      const notes = node!['notes'] as JsonObject[];
      expect(notes.length).toBe(1);
      expect(notes[0]['text']).toBe('Initial contact made via phone');
      expect(notes[0]['author']).toBe('Alice Thompson');
      // These fields don't exist in the request -- DSL added them:
      expect(typeof notes[0]['id']).toBe('string');
      expect(typeof notes[0]['createdAt']).toBe('string');
    }, 60_000);

    it('sequential notes accumulate as nested objects in the graph array', async () => {
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/notes`, {
        text: 'Follow-up email sent with pricing',
        author: 'Alice Thompson',
      });

      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/notes`, {
        text: 'Customer requested demo next week',
        author: 'Bob Martinez',
      });

      const node = await getGraphNode(app.engineUrl, leadId);
      const notes = node!['notes'] as JsonObject[];
      expect(notes.length).toBe(3);

      // Each note is a fully-structured nested object
      expect(notes[1]['text']).toBe('Follow-up email sent with pricing');
      expect(notes[1]['author']).toBe('Alice Thompson');
      expect(notes[2]['text']).toBe('Customer requested demo next week');
      expect(notes[2]['author']).toBe('Bob Martinez');

      // All notes have unique IDs (generated server-side)
      const ids = notes.map(n => n['id']);
      expect(new Set(ids).size).toBe(3);
    }, 60_000);

    it('note events in event store carry the enriched payload', async () => {
      const events = await getEventsByAggregate(app.engineUrl, leadId);
      const noteEvents = events.filter(e => e.type === 'NoteAppended');
      expect(noteEvents.length).toBe(3);

      // Event payload has the computed fields. The note id is carried as `id`
      // (the event payload is the fully-formed note object the reducer appends).
      expect(noteEvents[0].payload['id']).toBeDefined();
      expect(noteEvents[0].payload['createdAt']).toBeDefined();
      expect(noteEvents[0].payload['text']).toBe('Initial contact made via phone');
    }, 60_000);
  });

  // --- Opportunity Line Items: request missing fields that graph computes ---

  describe('Opportunity Line Items: request has no total, graph computes it', () => {
    let oppId: string;

    beforeAll(async () => {
      // Create opportunity via the lead lifecycle + saga
      const leadRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Line Item Corp',
        contactName: 'LI User',
        phone: '+61 2 8000 0010',
        email: 'lineitems@nested.test',
        source: 'REFERRAL',
      });
      const leadId = (leadRes.body as JsonObject)['id'] as string;
      await fwd(app.engineUrl, 'POST', '/calls', {
        leadId, agentId: AGENT_ID, campaignId: CAMPAIGN_ID, outcome: 'INTERESTED',
      });
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/convert`, { value: 100000, probability: 80 });

      const opps = await fwd(app.engineUrl, 'GET', '/opportunities');
      oppId = (opps.body as JsonObject[]).find(o => o['leadId'] === leadId)!['id'] as string;
    });

    it('graph node starts with empty lineItems array', async () => {
      const node = await getGraphNode(app.engineUrl, oppId);
      expect(node!['lineItems']).toEqual([]);
    }, 60_000);

    it('POST { description, quantity, unitPrice } produces line item with computed total + id', async () => {
      // Request shape: { description, quantity, unitPrice } -- NO total, NO id
      await fwd(app.engineUrl, 'POST', `/opportunities/${oppId}/line-items`, {
        description: 'Enterprise License (annual)',
        quantity: 5,
        unitPrice: 12000,
      });

      // Graph shape: lineItems[0] = { id, description, quantity, unitPrice, total, addedAt }
      const node = await getGraphNode(app.engineUrl, oppId);
      const items = node!['lineItems'] as JsonObject[];
      expect(items.length).toBe(1);
      expect(items[0]['description']).toBe('Enterprise License (annual)');
      expect(items[0]['quantity']).toBe(5);
      expect(items[0]['unitPrice']).toBe(12000);
      // COMPUTED by DSL script: total = quantity * unitPrice
      expect(items[0]['total']).toBe(60000);
      // Generated server-side:
      expect(typeof items[0]['id']).toBe('string');
      expect(typeof items[0]['addedAt']).toBe('string');
    }, 60_000);

    it('multiple line items build a complex nested array in the graph', async () => {
      await fwd(app.engineUrl, 'POST', `/opportunities/${oppId}/line-items`, {
        description: 'Implementation Services',
        quantity: 80,
        unitPrice: 250,
      });

      await fwd(app.engineUrl, 'POST', `/opportunities/${oppId}/line-items`, {
        description: 'Training Sessions',
        quantity: 3,
        unitPrice: 5000,
      });

      const node = await getGraphNode(app.engineUrl, oppId);
      const items = node!['lineItems'] as JsonObject[];
      expect(items.length).toBe(3);

      // Verify computed totals
      expect(items[0]['total']).toBe(60000);   // 5 * 12000
      expect(items[1]['total']).toBe(20000);   // 80 * 250
      expect(items[2]['total']).toBe(15000);   // 3 * 5000

      // All have unique IDs
      const ids = items.map(i => i['id']);
      expect(new Set(ids).size).toBe(3);
    }, 60_000);

    it('guards prevent adding line items to closed opportunities', async () => {
      // Create another opportunity and close it
      const leadRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Closed Opp Corp', contactName: 'CO',
        phone: '+61 2 8000 0011', email: 'closed@opp.test', source: 'REFERRAL',
      });
      const lid = (leadRes.body as JsonObject)['id'] as string;
      await fwd(app.engineUrl, 'POST', '/calls', { leadId: lid, agentId: AGENT_ID, campaignId: CAMPAIGN_ID, outcome: 'INTERESTED' });
      await fwd(app.engineUrl, 'POST', `/leads/${lid}/contact`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${lid}/qualify`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${lid}/convert`, { value: 50000, probability: 70 });
      const opps = await fwd(app.engineUrl, 'GET', '/opportunities');
      const closedOppId = (opps.body as JsonObject[]).find(o => o['leadId'] === lid)!['id'] as string;

      // Close the opportunity via PATCH
      await fwd(app.engineUrl, 'PATCH', `/opportunities/${closedOppId}/close`, { outcome: 'LOST', closureReason: 'No budget' });

      // Try to add a line item -- should fail
      const res = await fwd(app.engineUrl, 'POST', `/opportunities/${closedOppId}/line-items`, {
        description: 'Should fail', quantity: 1, unitPrice: 100,
      });
      expect(res.status).toBe(422);

      // Graph node unchanged
      const node = await getGraphNode(app.engineUrl, closedOppId);
      expect((node!['lineItems'] as JsonObject[]).length).toBe(0);
    }, 60_000);
  });

  // --- Call Transcript: batch request -> sequentially numbered graph entries ---

  describe('Call Transcript: batch request -> individually enriched graph entries', () => {
    let callId: string;

    beforeAll(async () => {
      const leadRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Transcript Corp', contactName: 'TC',
        phone: '+61 2 8000 0020', email: 'transcript@nested.test', source: 'WEBSITE',
      });
      const leadId = (leadRes.body as JsonObject)['id'] as string;

      const callRes = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED',
        durationSeconds: 300,
      });
      callId = (callRes.body as JsonObject)['id'] as string;
    });

    it('graph node starts with empty transcript array', async () => {
      const node = await getGraphNode(app.engineUrl, callId);
      expect(node!['transcript']).toEqual([]);
    }, 60_000);

    it('POST { speaker, text } produces enriched entry with timestamp + sequenceNum in graph', async () => {
      // Request shape: { speaker: string, text: string } -- flat, 2 fields
      await fwd(app.engineUrl, 'POST', `/calls/${callId}/transcript`, {
        speaker: 'Agent', text: 'Hello, thank you for taking my call.',
      });
      await fwd(app.engineUrl, 'POST', `/calls/${callId}/transcript`, {
        speaker: 'Lead', text: 'Sure, what is this about?',
      });
      await fwd(app.engineUrl, 'POST', `/calls/${callId}/transcript`, {
        speaker: 'Agent', text: 'I am calling about our enterprise solution.',
      });

      // Graph shape: transcript[] = [{ speaker, text, timestamp, sequenceNum }]
      const node = await getGraphNode(app.engineUrl, callId);
      const transcript = node!['transcript'] as JsonObject[];
      expect(transcript.length).toBe(3);

      expect(transcript[0]['speaker']).toBe('Agent');
      expect(transcript[0]['text']).toBe('Hello, thank you for taking my call.');
      expect(transcript[0]['sequenceNum']).toBe(1);
      expect(typeof transcript[0]['timestamp']).toBe('string');

      expect(transcript[1]['speaker']).toBe('Lead');
      expect(transcript[1]['sequenceNum']).toBe(2);

      expect(transcript[2]['speaker']).toBe('Agent');
      expect(transcript[2]['sequenceNum']).toBe(3);
    }, 60_000);

    it('subsequent transcript entries continue the sequence numbering', async () => {
      await fwd(app.engineUrl, 'POST', `/calls/${callId}/transcript`, {
        speaker: 'Lead', text: 'That sounds interesting, tell me more.',
      });
      await fwd(app.engineUrl, 'POST', `/calls/${callId}/transcript`, {
        speaker: 'Agent', text: 'We offer three tiers of service...',
      });

      const node = await getGraphNode(app.engineUrl, callId);
      const transcript = node!['transcript'] as JsonObject[];
      expect(transcript.length).toBe(5);

      // Sequence continues from where we left off
      expect(transcript[3]['sequenceNum']).toBe(4);
      expect(transcript[3]['speaker']).toBe('Lead');
      expect(transcript[4]['sequenceNum']).toBe(5);
      expect(transcript[4]['speaker']).toBe('Agent');
    }, 60_000);
  });

  // --- Cross-boundary nested graph: lead with notes + calls with transcripts ---

  describe('Complex interconnected graph: lead with notes references calls with transcripts', () => {
    let leadId: string;
    let call1Id: string;
    let call2Id: string;

    it('build a complex interrelated graph via sequential API calls', async () => {
      // Create lead
      const leadRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Complex Graph Inc',
        contactName: 'CG User',
        phone: '+61 2 8000 0030',
        email: 'complex@graph.test',
        source: 'PARTNER',
      });
      leadId = (leadRes.body as JsonObject)['id'] as string;

      // Log first call
      const c1Res = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId, agentId: AGENT_ID, campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED', durationSeconds: 180,
      });
      call1Id = (c1Res.body as JsonObject)['id'] as string;

      // Add transcript entries to first call
      await fwd(app.engineUrl, 'POST', `/calls/${call1Id}/transcript`, { speaker: 'Agent', text: 'Initial introduction' });
      await fwd(app.engineUrl, 'POST', `/calls/${call1Id}/transcript`, { speaker: 'Lead', text: 'Tell me about pricing' });

      // Add a note to the lead about the call
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/notes`, {
        text: 'First call went well, interested in pricing',
        author: 'Alice Thompson',
      });

      // Contact and continue
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});

      // Log second call
      const c2Res = await fwd(app.engineUrl, 'POST', '/calls', {
        leadId, agentId: AGENT_ID, campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED', durationSeconds: 420,
      });
      call2Id = (c2Res.body as JsonObject)['id'] as string;

      // Add transcript entries to second call
      await fwd(app.engineUrl, 'POST', `/calls/${call2Id}/transcript`, { speaker: 'Agent', text: 'Following up on pricing discussion' });
      await fwd(app.engineUrl, 'POST', `/calls/${call2Id}/transcript`, { speaker: 'Lead', text: 'We want to proceed with tier 2' });
      await fwd(app.engineUrl, 'POST', `/calls/${call2Id}/transcript`, { speaker: 'Agent', text: 'Excellent, I will prepare the proposal' });

      // Add another note
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/notes`, {
        text: 'Ready to move to proposal stage - wants tier 2',
        author: 'Alice Thompson',
      });
    }, 60_000);

    it('lead graph node has nested notes + callIds referencing call nodes', async () => {
      const lead = await getGraphNode(app.engineUrl, leadId);

      // Nested notes array with structured objects
      const notes = lead!['notes'] as JsonObject[];
      expect(notes.length).toBe(2);
      expect(notes[0]['text']).toBe('First call went well, interested in pricing');
      expect(notes[1]['text']).toBe('Ready to move to proposal stage - wants tier 2');

      // callIds reference the call graph nodes
      const callIds = lead!['callIds'] as string[];
      expect(callIds).toContain(call1Id);
      expect(callIds).toContain(call2Id);
    }, 60_000);

    it('call graph nodes have nested transcript arrays', async () => {
      const call1 = await getGraphNode(app.engineUrl, call1Id);
      const t1 = call1!['transcript'] as JsonObject[];
      expect(t1.length).toBe(2);
      expect(t1[0]['speaker']).toBe('Agent');
      expect(t1[0]['sequenceNum']).toBe(1);

      const call2 = await getGraphNode(app.engineUrl, call2Id);
      const t2 = call2!['transcript'] as JsonObject[];
      expect(t2.length).toBe(3);
      expect(t2[2]['text']).toBe('Excellent, I will prepare the proposal');
      expect(t2[2]['sequenceNum']).toBe(3);
    }, 60_000);

    it('graph forms a connected structure: lead -> callIds -> call.transcript', async () => {
      const lead = await getGraphNode(app.engineUrl, leadId);
      const callIds = lead!['callIds'] as string[];

      // Walk the graph: lead -> each call -> verify transcript exists
      for (const cid of callIds) {
        const call = await getGraphNode(app.engineUrl, cid);
        expect(call).not.toBeNull();
        expect(call!['leadId']).toBe(leadId);
        expect(Array.isArray(call!['transcript'])).toBe(true);
        expect((call!['transcript'] as JsonObject[]).length).toBeGreaterThan(0);
      }
    }, 60_000);

    it('total events show the full causal chain building the nested graph', async () => {
      const leadEvents = await getEventsByAggregate(app.engineUrl, leadId);
      const types = leadEvents.map(e => e.type);
      expect(types).toContain('LeadCreated');
      expect(types).toContain('CallIdAppended');
      expect(types).toContain('NoteAppended');
      expect(types).toContain('LeadContacted');

      const call1Events = await getEventsByAggregate(app.engineUrl, call1Id);
      expect(call1Events.some(e => e.type === 'TranscriptEntryAppended')).toBe(true);

      const call2Events = await getEventsByAggregate(app.engineUrl, call2Id);
      expect(call2Events.some(e => e.type === 'TranscriptEntryAppended')).toBe(true);
    }, 60_000);
  });
});
