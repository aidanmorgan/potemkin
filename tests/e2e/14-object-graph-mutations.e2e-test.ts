/**
 * 14 — DSL Object Graph Mutations via full Specmatic stack.
 *
 * Verifies the CRM DSL YAML files correctly define how mutations transform
 * the internal object graph, by sending requests through the full
 * Specmatic+plugin+Node pipeline and inspecting state via /_admin/ endpoints.
 *
 * DSL files under test: lead.yaml, lead-contact.yaml, lead-qualify.yaml,
 * lead-convert.yaml, lead-disqualify.yaml, call.yaml
 */

import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { fwd, getGraphNode, getEventsByAggregate } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

function javaAvailable(): boolean {
  try { execSync('java -version', { stdio: 'pipe' }); return true; } catch { return false; }
}
const describeWithJava = javaAvailable() ? describe : describe.skip;

const AGENT_ID = '00000000-0000-7000-8000-000000000003';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';

describeWithJava('14 — DSL Object Graph Mutations (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  describe('Lead creation: DSL event_catalog + reducer builds graph node', () => {
    let leadId: string;

    it('POST /leads creates entity with fields from DSL reducer', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'E2E Graph Corp', contactName: 'Graph User',
        phone: '+61 2 9000 1234', email: 'graph@e2e.test', source: 'REFERRAL',
      });
      expect([200, 201]).toContain(res.status);
      leadId = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node).not.toBeNull();
      expect(node!['companyName']).toBe('E2E Graph Corp');
      expect(node!['status']).toBe('NEW');
      expect(node!['score']).toBe(80); // REFERRAL → 80 via ts:computeScore
      expect(node!['callIds']).toEqual([]);
    }, 60_000);

    it('LeadCreated event emitted per DSL event_catalog', async () => {
      const events = await getEventsByAggregate(app.engineUrl, leadId);
      expect(events.length).toBeGreaterThanOrEqual(1);
      const created = events.find(e => e.type === 'LeadCreated');
      expect(created).toBeDefined();
      expect(created!.payload['companyName']).toBe('E2E Graph Corp');
      expect(created!.payload['score']).toBe(80);
    }, 60_000);
  });

  describe('Lead lifecycle: DSL behaviors drive state transitions', () => {
    let leadId: string;

    it('create → contact → qualify → convert via DSL behaviors', async () => {
      // Create
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Lifecycle Corp', contactName: 'LC',
        phone: '+61 0', email: 'lc@e2e.test', source: 'REFERRAL',
      });
      leadId = (createRes.body as JsonObject)['id'] as string;

      // Log call (needed for qualify guard)
      await fwd(app.engineUrl, 'POST', '/calls', {
        leadId, agentId: AGENT_ID, campaignId: CAMPAIGN_ID, outcome: 'INTERESTED',
      });

      // Contact
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
      let node = await getGraphNode(app.engineUrl, leadId);
      expect(node!['status']).toBe('CONTACTED');

      // Qualify
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
      node = await getGraphNode(app.engineUrl, leadId);
      expect(node!['status']).toBe('QUALIFIED');

      // Convert
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/convert`, { value: 50000 });
      node = await getGraphNode(app.engineUrl, leadId);
      expect(node!['status']).toBe('CONVERTED');
    }, 60_000);

    it('event stream shows full lifecycle', async () => {
      const events = await getEventsByAggregate(app.engineUrl, leadId);
      const types = events.map(e => e.type);
      expect(types).toContain('LeadCreated');
      expect(types).toContain('CallIdAppended');
      expect(types).toContain('LeadContacted');
      expect(types).toContain('LeadQualified');
      expect(types).toContain('LeadConverted');

      // Sequence versions are monotonically increasing
      for (let i = 1; i < events.length; i++) {
        expect(events[i].sequenceVersion).toBeGreaterThan(events[i - 1].sequenceVersion);
      }
    }, 60_000);
  });

  describe('DSL script ts:computeScore maps sources to scores', () => {
    it('each source produces correct score in graph', async () => {
      const sources = [
        { source: 'REFERRAL', expected: 80 },
        { source: 'PARTNER', expected: 70 },
        { source: 'WEBSITE', expected: 50 },
        { source: 'COLD_LIST', expected: 20 },
      ];

      for (const { source, expected } of sources) {
        const res = await fwd(app.engineUrl, 'POST', '/leads', {
          companyName: `Score ${source}`, contactName: 'S',
          phone: '+61 0', email: `s-${source.toLowerCase()}@e2e.test`, source,
        });
        const id = (res.body as JsonObject)['id'] as string;
        const node = await getGraphNode(app.engineUrl, id);
        expect(node!['score']).toBe(expected);
      }
    }, 60_000);
  });
});
