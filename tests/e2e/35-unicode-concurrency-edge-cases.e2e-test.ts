/**
 * 35 — Unicode, Concurrency & Edge Cases via full Specmatic stack.
 *
 * Verifies the engine correctly handles:
 *   1. Unicode/i18n text in entity fields (CJK, emoji, diacritics, RTL, full-text search)
 *   2. Concurrent request safety (per-aggregate serialization, independent creates, parallel mutations)
 *   3. Payload size and abuse protection (long strings, moderate entity scale, extra fields)
 *
 * All behavior is defined in the CRM YAML files. This test only sends HTTP
 * requests and verifies responses + graph state via admin endpoints.
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { fwd, getGraphNode, getEventCount, getEventsByAggregate, adminReset, javaAvailable } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

const AGENT_ID = '00000000-0000-7000-8000-000000000003';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';

describeWithJava('35 — Unicode, Concurrency & Edge Cases (full Specmatic stack)', () => {
  let app: E2eApp;
  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Section 1: Unicode & i18n Handling
  // ──────────────────────────────────────────────────────────────────────────

  describe('Unicode & i18n handling', () => {
    let cjkLeadId: string;

    it('CJK characters in entity fields round-trip correctly', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: '日本語テスト株式会社',
        contactName: '田中太郎',
        phone: '+61 2 9000 0000',
        email: 'cjk@example.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(res.status);
      cjkLeadId = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, cjkLeadId);
      expect(node).not.toBeNull();
      expect(node!['companyName']).toBe('日本語テスト株式会社');
      expect(node!['contactName']).toBe('田中太郎');
    }, 60_000);

    it('emoji in entity fields round-trip correctly', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Rocket Corp 🚀',
        contactName: 'Star ⭐ User',
        phone: '+61 2 9000 0001',
        email: 'emoji@example.com',
        source: 'REFERRAL',
      });
      expect([200, 201]).toContain(res.status);
      const id = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, id);
      expect(node).not.toBeNull();
      expect(node!['companyName']).toBe('Rocket Corp 🚀');
      expect(node!['contactName']).toBe('Star ⭐ User');
    }, 60_000);

    it('mixed scripts with diacritics round-trip correctly', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Ölüm Şirketi GmbH',
        contactName: 'Müller Straße',
        phone: '+61 2 9000 0002',
        email: 'diacritics@example.com',
        source: 'PARTNER',
      });
      expect([200, 201]).toContain(res.status);
      const id = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, id);
      expect(node).not.toBeNull();
      expect(node!['companyName']).toBe('Ölüm Şirketi GmbH');
      expect(node!['contactName']).toBe('Müller Straße');
    }, 60_000);

    it('Arabic/RTL text round-trips correctly', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'شركة الاختبار',
        contactName: 'محمد علي',
        phone: '+61 2 9000 0003',
        email: 'arabic@example.com',
        source: 'COLD_LIST',
      });
      expect([200, 201]).toContain(res.status);
      const id = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, id);
      expect(node).not.toBeNull();
      expect(node!['companyName']).toBe('شركة الاختبار');
      expect(node!['contactName']).toBe('محمد علي');
    }, 60_000);

    it('full-text search finds Unicode entities via ?q= parameter', async () => {
      // The CJK lead was created earlier in this describe block
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { q: '日本語' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const matches = res.body as JsonObject[];
      expect(matches.length).toBeGreaterThanOrEqual(1);
      const found = matches.find(l => l['id'] === cjkLeadId);
      expect(found).toBeDefined();
      expect(found!['companyName']).toBe('日本語テスト株式会社');
    }, 60_000);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Section 2: Concurrent Request Safety
  // ──────────────────────────────────────────────────────────────────────────

  describe('Concurrent request safety', () => {
    it('concurrent mutations to same entity: only valid transitions succeed', async () => {
      // Create a fresh lead (status: NEW)
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Concurrency Test Corp',
        contactName: 'CT User',
        phone: '+61 2 9000 1000',
        email: 'concurrent-same@example.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(createRes.status);
      const leadId = (createRes.body as JsonObject)['id'] as string;

      const eventsBefore = await getEventCount(app.engineUrl);
      const leadEventsBefore = (await getEventsByAggregate(app.engineUrl, leadId))
        .filter(e => e.type === 'LeadContacted').length;

      // Fire 5 concurrent contact requests against the same lead.
      // lead.yaml's contactLead emit_when allows NEW -> CONTACTED and
      // CONTACTED -> CONTACTED (idempotent re-contact, per 23-temporal-data-quality).
      // Every call is therefore a valid transition that emits a LeadContacted event.
      const promises = Array.from({ length: 5 }, () =>
        fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {}),
      );
      const results = await Promise.all(promises);

      const successes = results.filter(r => r.status === 200);

      // All 5 are valid transitions per the DSL — every call must succeed.
      expect(successes.length).toBe(5);

      // No 500s, no contract violations, no corruption — all responses are 200.
      for (const r of results) {
        expect(r.status).toBe(200);
      }

      // The lead ends up in CONTACTED status (not corrupted).
      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node!['status']).toBe('CONTACTED');

      // Event log integrity: one LeadContacted event per successful call,
      // none lost or duplicated under concurrency.
      const eventsAfter = await getEventCount(app.engineUrl);
      const leadEventsAfter = (await getEventsByAggregate(app.engineUrl, leadId))
        .filter(e => e.type === 'LeadContacted').length;
      expect(leadEventsAfter - leadEventsBefore).toBe(5);
      expect(eventsAfter - eventsBefore).toBe(5);
    }, 60_000);

    it('concurrent creates are independent: all succeed with unique IDs', async () => {
      const promises = Array.from({ length: 5 }, (_, i) =>
        fwd(app.engineUrl, 'POST', '/leads', {
          companyName: `Parallel Create ${i}`,
          contactName: `PC${i}`,
          phone: `+61 2 9000 200${i}`,
          email: `parallel-create-${i}@example.com`,
          source: 'WEBSITE',
        }),
      );
      const results = await Promise.all(promises);

      // All 5 should succeed
      for (const r of results) {
        expect([200, 201]).toContain(r.status);
      }

      // All 5 should have unique IDs
      const ids = results.map(r => (r.body as JsonObject)['id'] as string);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(5);

      // All 5 entities should exist in the graph with correct names
      for (let i = 0; i < 5; i++) {
        const node = await getGraphNode(app.engineUrl, ids[i]);
        expect(node).not.toBeNull();
        expect(node!['companyName']).toBe(`Parallel Create ${i}`);
      }
    }, 60_000);

    it('concurrent requests to different entities succeed independently', async () => {
      // Create 3 separate leads
      const leadIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await fwd(app.engineUrl, 'POST', '/leads', {
          companyName: `Independent ${i}`,
          contactName: `Ind${i}`,
          phone: `+61 2 9000 300${i}`,
          email: `independent-${i}@example.com`,
          source: 'REFERRAL',
        });
        expect([200, 201]).toContain(res.status);
        leadIds.push((res.body as JsonObject)['id'] as string);
      }

      // Fire concurrent contact requests to all 3 simultaneously
      const promises = leadIds.map(id =>
        fwd(app.engineUrl, 'POST', `/leads/${id}/contact`, {}),
      );
      const results = await Promise.all(promises);

      // All 3 should succeed (different aggregates, no contention)
      for (const r of results) {
        expect(r.status).toBe(200);
      }

      // All 3 should be in CONTACTED status
      for (const id of leadIds) {
        const node = await getGraphNode(app.engineUrl, id);
        expect(node!['status']).toBe('CONTACTED');
      }
    }, 60_000);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Section 3: Payload Size & Abuse Protection
  // ──────────────────────────────────────────────────────────────────────────

  describe('Payload size & abuse protection', () => {
    it('very long string value (5000 chars) round-trips correctly', async () => {
      const longName = 'A'.repeat(5000);
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: longName,
        contactName: 'Long String User',
        phone: '+61 2 9000 4000',
        email: 'longstring@example.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(res.status);
      const id = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, id);
      expect(node).not.toBeNull();
      expect(node!['companyName']).toBe(longName);
      expect((node!['companyName'] as string).length).toBe(5000);
    }, 60_000);

    it('large number of entities created sequentially are all queryable', async () => {
      // Capture current lead count before creating more
      const beforeRes = await fwd(app.engineUrl, 'GET', '/leads');
      const countBefore = (beforeRes.body as JsonObject[]).length;

      // Create 20 leads sequentially
      const createdIds: string[] = [];
      for (let i = 0; i < 20; i++) {
        const res = await fwd(app.engineUrl, 'POST', '/leads', {
          companyName: `Scale Test ${i}`,
          contactName: `ST${i}`,
          phone: `+61 2 8000 ${String(i).padStart(4, '0')}`,
          email: `scale-test-${i}@example.com`,
          source: 'COLD_LIST',
        });
        expect([200, 201]).toContain(res.status);
        createdIds.push((res.body as JsonObject)['id'] as string);
      }

      // GET /leads should return all existing + the 20 new leads
      const afterRes = await fwd(app.engineUrl, 'GET', '/leads');
      expect(afterRes.status).toBe(200);
      const allLeads = afterRes.body as JsonObject[];
      expect(allLeads.length).toBe(countBefore + 20);

      // Every created ID should be present in the collection
      const allIds = allLeads.map(l => l['id'] as string);
      for (const id of createdIds) {
        expect(allIds).toContain(id);
      }
    }, 60_000);

    it('extra fields in POST /leads body are rejected (additionalProperties: false)', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Extra Fields Corp',
        contactName: 'EF User',
        phone: '+61 2 9000 5000',
        email: 'extra-fields@example.com',
        source: 'WEBSITE',
        nested: {
          level1: {
            level2: {
              level3: {
                level4: {
                  level5: {
                    level6: {
                      level7: {
                        level8: {
                          level9: {
                            level10: 'deep value',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        extraField: 'should not be accepted',
      });

      // Specmatic enforces additionalProperties: false at the contract level,
      // so this should be rejected with a 4xx status
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }, 60_000);
  });
});
