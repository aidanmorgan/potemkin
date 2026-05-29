/**
 * 34 — Query Edge Cases: pagination boundaries, operator filter corner cases,
 * full-text search edge cases, sort edge cases, and empty-collection scenarios
 * exercised through the full Specmatic+plugin+Node stack.
 *
 * Verifies that the query engine handles boundary conditions gracefully:
 * offsets beyond total, negative offsets, zero limits, missing fields,
 * combined filters, case-insensitive search, and nonexistent sort fields.
 *
 * DSL files under test:
 *   lead.yaml (5 seeded leads with score, status, source, companyName)
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import {
  fwd,
  getGraphNode,
  adminReset,
  javaAvailable,
} from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

// Seeded Lead IDs from lead.yaml initialization
const APEX_LEAD_ID    = '00000000-0000-7000-8000-000000000010'; // score=50, NEW, WEBSITE, "Apex Solutions Ltd"
const BLUESKY_LEAD_ID = '00000000-0000-7000-8000-000000000011'; // score=80, CONTACTED, REFERRAL, "BlueSky Tech"
const CORNER_LEAD_ID  = '00000000-0000-7000-8000-000000000012'; // score=20, QUALIFIED, COLD_LIST, "Cornerstone Corp"
const DELTA_LEAD_ID   = '00000000-0000-7000-8000-000000000013'; // score=70, DISQUALIFIED, PARTNER, "Delta Dynamics"
const ECHO_LEAD_ID    = '00000000-0000-7000-8000-000000000014'; // score=50, NEW, WEBSITE, "Echo Enterprises"

describeWithJava('34 — Query Edge Cases (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // Pagination edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Pagination edge cases', () => {

    it('offset beyond total returns empty array', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { offset: '100' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as JsonObject[]).length).toBe(0);
    }, 60_000);

    it('negative offset is clamped to 0', async () => {
      const baseline = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { offset: '0' });
      const negativeOffset = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { offset: '-5' });

      expect(baseline.status).toBe(200);
      expect(negativeOffset.status).toBe(200);
      expect(Array.isArray(baseline.body)).toBe(true);
      expect(Array.isArray(negativeOffset.body)).toBe(true);

      // Same number of results as offset=0
      expect((negativeOffset.body as JsonObject[]).length).toBe((baseline.body as JsonObject[]).length);
    }, 60_000);

    it('limit=0 returns empty envelope', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { limit: '0' });
      expect(res.status).toBe(200);
      // ?limit triggers the pagination envelope.
      const env = res.body as JsonObject;
      expect((env['items'] as JsonObject[]).length).toBe(0);
      expect(env['totalCount']).toBe(5);
    }, 60_000);

    it('very large limit returns all entities without error', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { limit: '99999' });
      expect(res.status).toBe(200);
      const env = res.body as JsonObject;
      expect((env['items'] as JsonObject[]).length).toBe(5);
    }, 60_000);

    it('offset + limit exceeding total returns only remaining items', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { offset: '3', limit: '10' });
      expect(res.status).toBe(200);
      const env = res.body as JsonObject;
      // 5 total - 3 offset = 2 remaining
      expect((env['items'] as JsonObject[]).length).toBe(2);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Filter edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Filter edge cases', () => {

    it('entities must have the filtered field present to match a comparison operator', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { 'nonExistentField:gt': '5' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // No entity has 'nonExistentField', so none satisfy the gt condition
      expect((res.body as JsonObject[]).length).toBe(0);
    }, 60_000);

    it('empty filter value is treated as a valid comparison target', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { 'score:gte': '' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // All entities have a score, and all satisfy gte compared to empty string
      expect((res.body as JsonObject[]).length).toBe(5);
    }, 60_000);

    it('multiple operator filters combine with AND semantics', async () => {
      // score >= 50 AND status in [NEW]
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'score:gte': '50',
        'status:in': 'NEW',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const leads = res.body as JsonObject[];
      // Apex (score=50, NEW) and Echo (score=50, NEW) match
      expect(leads.length).toBe(2);
      for (const lead of leads) {
        expect(lead['status']).toBe('NEW');
        expect((lead['score'] as number) >= 50).toBe(true);
      }
    }, 60_000);

    it('queryMapping filter + operator filter combine correctly', async () => {
      // status=NEW (queryMapping) + score:gt=40 (operator)
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        status: 'NEW',
        'score:gt': '40',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const leads = res.body as JsonObject[];
      // NEW leads: Apex (score=50) and Echo (score=50), both have score > 40
      expect(leads.length).toBe(2);
      for (const lead of leads) {
        expect(lead['status']).toBe('NEW');
        expect((lead['score'] as number) > 40).toBe(true);
      }
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Search edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Search edge cases', () => {

    it('full-text search with no results returns empty array', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { q: 'NonExistentXYZ123' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as JsonObject[]).length).toBe(0);
    }, 60_000);

    it('full-text search matches partial company name', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { q: 'Solutions Ltd' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const leads = res.body as JsonObject[];
      expect(leads.length).toBeGreaterThanOrEqual(1);
      expect(leads.some((l) => l['companyName'] === 'Apex Solutions Ltd')).toBe(true);
    }, 60_000);

    it('full-text search is case-insensitive', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { q: 'apex' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const leads = res.body as JsonObject[];
      expect(leads.length).toBeGreaterThanOrEqual(1);
      expect(leads.some((l) => l['companyName'] === 'Apex Solutions Ltd')).toBe(true);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Sort edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Sort edge cases', () => {

    it('sort by nonexistent field returns all entities in stable order', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { sort: 'nonExistentField' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // All 5 leads returned; null/undefined values sort to end per comparator
      expect((res.body as JsonObject[]).length).toBe(5);
    }, 60_000);

    it('sort with no order param defaults to ascending', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { sort: 'score' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const scores = (res.body as JsonObject[]).map((l) => l['score'] as number);
      // Verify ascending order: each score <= the next
      for (let i = 0; i < scores.length - 1; i++) {
        expect(scores[i] <= scores[i + 1]).toBe(true);
      }
    }, 60_000);

    it('sort + filter + pagination combined', async () => {
      // status in [NEW, CONTACTED], sort by score desc, limit 2
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'status:in': 'NEW,CONTACTED',
        sort: 'score',
        order: 'desc',
        limit: '2',
      });
      expect(res.status).toBe(200);
      // ?limit triggers the envelope shape.
      const env = res.body as JsonObject;
      const leads = env['items'] as JsonObject[];
      expect(leads.length).toBe(2);

      // NEW leads: Apex (50), Echo (50). CONTACTED: BlueSky (80).
      // Sorted desc by score: BlueSky (80) first, then one of Apex/Echo (50).
      expect(leads[0]['score']).toBe(80);
      expect(leads[0]['companyName']).toBe('BlueSky Tech');
      expect(leads[1]['score']).toBe(50);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Empty collection scenarios
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Empty collection scenarios', () => {

    it('query with filter matching no entities returns empty array', async () => {
      // No leads have status=CONVERTED in the seed data
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { status: 'CONVERTED' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as JsonObject[]).length).toBe(0);
    }, 60_000);
  });
});
