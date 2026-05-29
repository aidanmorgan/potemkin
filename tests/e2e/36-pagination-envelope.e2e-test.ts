/**
 * 36 — Pagination Envelope: verifies the engine's pagination envelope feature
 * end-to-end through the full Specmatic+plugin+Node stack.
 *
 * When `?limit` is present, the engine wraps query results in a metadata envelope:
 *   { items, totalCount, offset, limit, hasMore }
 *
 * When `?limit` is absent, the engine returns the raw array for backward
 * compatibility. Single-entity GETs never use the envelope.
 *
 * Perspectives covered:
 *   - Envelope shape & pagination metadata (totalCount, offset, limit, hasMore)
 *   - Interaction with filters (totalCount reflects filtered count)
 *   - Interaction with sort (items inside envelope are sorted correctly)
 *   - Single-entity GET (never enveloped)
 *   - Backward compatibility (no limit → raw array)
 *
 * DSL files under test:
 *   lead.yaml (5 seeded leads with score, status, source, companyName)
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { fwd, javaAvailable } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

// Seeded Lead IDs from lead.yaml initialization
const APEX_LEAD_ID    = '00000000-0000-7000-8000-000000000010'; // score=50, NEW, WEBSITE, "Apex Solutions Ltd"
const BLUESKY_LEAD_ID = '00000000-0000-7000-8000-000000000011'; // score=80, CONTACTED, REFERRAL, "BlueSky Tech"
const CORNER_LEAD_ID  = '00000000-0000-7000-8000-000000000012'; // score=20, QUALIFIED, COLD_LIST, "Cornerstone Corp"
const DELTA_LEAD_ID   = '00000000-0000-7000-8000-000000000013'; // score=70, DISQUALIFIED, PARTNER, "Delta Dynamics"
const ECHO_LEAD_ID    = '00000000-0000-7000-8000-000000000014'; // score=50, NEW, WEBSITE, "Echo Enterprises"

const ALL_SEEDED_LEAD_IDS = [
  APEX_LEAD_ID,
  BLUESKY_LEAD_ID,
  CORNER_LEAD_ID,
  DELTA_LEAD_ID,
  ECHO_LEAD_ID,
];

describeWithJava('36 — Pagination Envelope (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // Envelope shape & metadata
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Envelope shape & metadata', () => {

    it('GET /leads without limit returns a raw array (no envelope)', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {});
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const arr = res.body as JsonObject[];
      expect(arr.length).toBe(5);
      // Each element is a lead entity, not an envelope wrapper
      for (const lead of arr) {
        expect(typeof lead).toBe('object');
        expect(Array.isArray(lead)).toBe(false);
        expect(typeof (lead as JsonObject)['id']).toBe('string');
      }
    }, 60_000);

    it('GET /leads with limit=2&offset=0 returns envelope with first page metadata', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { limit: '2', offset: '0' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);
      expect(typeof res.body).toBe('object');

      const env = res.body as JsonObject;
      expect(Array.isArray(env['items'])).toBe(true);
      expect((env['items'] as JsonObject[]).length).toBe(2);
      expect(env['totalCount']).toBe(5);
      expect(env['offset']).toBe(0);
      expect(env['limit']).toBe(2);
      expect(env['hasMore']).toBe(true);
    }, 60_000);

    it('GET /leads with limit=2&offset=4 returns envelope with only 1 remaining item and hasMore false', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { limit: '2', offset: '4' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);

      const env = res.body as JsonObject;
      expect(Array.isArray(env['items'])).toBe(true);
      expect((env['items'] as JsonObject[]).length).toBe(1);
      expect(env['totalCount']).toBe(5);
      expect(env['offset']).toBe(4);
      expect(env['limit']).toBe(2);
      expect(env['hasMore']).toBe(false);
    }, 60_000);

    it('GET /leads with limit=5&offset=0 returns envelope with all items and hasMore false (exact match)', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { limit: '5', offset: '0' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);

      const env = res.body as JsonObject;
      expect(Array.isArray(env['items'])).toBe(true);
      expect((env['items'] as JsonObject[]).length).toBe(5);
      expect(env['totalCount']).toBe(5);
      expect(env['offset']).toBe(0);
      expect(env['limit']).toBe(5);
      expect(env['hasMore']).toBe(false);

      // All seeded leads must appear in items
      const returnedIds = (env['items'] as JsonObject[]).map((l) => l['id'] as string).sort();
      expect(returnedIds).toEqual([...ALL_SEEDED_LEAD_IDS].sort());
    }, 60_000);

    it('GET /leads with limit=10&offset=0 (limit > total) returns envelope with all items and hasMore false', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { limit: '10', offset: '0' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);

      const env = res.body as JsonObject;
      expect(Array.isArray(env['items'])).toBe(true);
      expect((env['items'] as JsonObject[]).length).toBe(5);
      expect(env['totalCount']).toBe(5);
      expect(env['offset']).toBe(0);
      expect(env['limit']).toBe(10);
      expect(env['hasMore']).toBe(false);
    }, 60_000);

    it('GET /leads with limit=2&offset=99 (offset beyond total) returns empty envelope with correct totalCount', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { limit: '2', offset: '99' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);

      const env = res.body as JsonObject;
      expect(Array.isArray(env['items'])).toBe(true);
      expect((env['items'] as JsonObject[]).length).toBe(0);
      expect(env['totalCount']).toBe(5);
      expect(env['offset']).toBe(99);
      expect(env['limit']).toBe(2);
      expect(env['hasMore']).toBe(false);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Interaction with filters
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Interaction with filters', () => {

    it('totalCount reflects the FILTERED count, not the total entity count (status:in=NEW)', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'status:in': 'NEW',
        limit: '10',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);

      const env = res.body as JsonObject;
      // 2 leads have status=NEW: Apex and Echo
      expect(env['totalCount']).toBe(2);
      expect(Array.isArray(env['items'])).toBe(true);
      expect((env['items'] as JsonObject[]).length).toBe(2);
      expect(env['offset']).toBe(0);
      expect(env['limit']).toBe(10);
      expect(env['hasMore']).toBe(false);

      for (const lead of env['items'] as JsonObject[]) {
        expect(lead['status']).toBe('NEW');
      }
    }, 60_000);

    it('totalCount reflects BOTH a queryMapping filter and an operator filter combined', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        status: 'NEW',
        'score:gte': '50',
        limit: '10',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);

      const env = res.body as JsonObject;
      // NEW leads: Apex (50) and Echo (50). Both satisfy score>=50.
      expect(env['totalCount']).toBe(2);
      expect((env['items'] as JsonObject[]).length).toBe(2);
      expect(env['hasMore']).toBe(false);

      for (const lead of env['items'] as JsonObject[]) {
        expect(lead['status']).toBe('NEW');
        expect((lead['score'] as number) >= 50).toBe(true);
      }
    }, 60_000);

    it('full-text search with no matches returns envelope with empty items and totalCount 0', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        q: 'NonExistentXYZ123',
        limit: '10',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);

      const env = res.body as JsonObject;
      expect(Array.isArray(env['items'])).toBe(true);
      expect((env['items'] as JsonObject[]).length).toBe(0);
      expect(env['totalCount']).toBe(0);
      expect(env['offset']).toBe(0);
      expect(env['limit']).toBe(10);
      expect(env['hasMore']).toBe(false);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Interaction with sort
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Interaction with sort', () => {

    it('sort=score&order=desc&limit=2 returns the top 2 items by score inside the envelope', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        sort: 'score',
        order: 'desc',
        limit: '2',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);

      const env = res.body as JsonObject;
      expect((env['items'] as JsonObject[]).length).toBe(2);
      expect(env['totalCount']).toBe(5);
      expect(env['offset']).toBe(0);
      expect(env['limit']).toBe(2);
      expect(env['hasMore']).toBe(true);

      // Top 2 by score desc: BlueSky (80), Delta (70)
      const items = env['items'] as JsonObject[];
      expect(items[0]['score']).toBe(80);
      expect(items[0]['companyName']).toBe('BlueSky Tech');
      expect(items[1]['score']).toBe(70);
      expect(items[1]['companyName']).toBe('Delta Dynamics');
    }, 60_000);

    it('items array inside the envelope is sorted correctly for sort=score asc', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        sort: 'score',
        order: 'asc',
        limit: '5',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);

      const env = res.body as JsonObject;
      const items = env['items'] as JsonObject[];
      expect(items.length).toBe(5);
      expect(env['totalCount']).toBe(5);
      expect(env['hasMore']).toBe(false);

      // Verify ascending order is preserved INSIDE the envelope
      const scores = items.map((l) => l['score'] as number);
      for (let i = 0; i < scores.length - 1; i++) {
        expect(scores[i] <= scores[i + 1]).toBe(true);
      }
      // First by score asc: Cornerstone (20)
      expect(items[0]['score']).toBe(20);
      expect(items[0]['companyName']).toBe('Cornerstone Corp');
      // Last by score asc: BlueSky (80)
      expect(items[4]['score']).toBe(80);
      expect(items[4]['companyName']).toBe('BlueSky Tech');
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Single-entity GET is NOT enveloped
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Single-entity GET is not enveloped', () => {

    it('GET /leads/{id} returns the raw entity object regardless of any limit param', async () => {
      const res = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`, null, {}, {});
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(Array.isArray(res.body)).toBe(false);

      const entity = res.body as JsonObject;
      // Raw entity must NOT carry envelope keys
      expect(entity['items']).toBeUndefined();
      expect(entity['totalCount']).toBeUndefined();
      expect(entity['hasMore']).toBeUndefined();

      // Raw entity carries the actual entity fields
      expect(entity['id']).toBe(APEX_LEAD_ID);
      expect(entity['status']).toBe('NEW');
      expect(entity['companyName']).toBe('Apex Solutions Ltd');
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Backward compatibility
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Backward compatibility', () => {

    it('GET /leads with no query params still returns a plain array', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {});
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as JsonObject[]).length).toBe(5);
    }, 60_000);

    it('GET /leads?offset=2 (offset without limit) returns a raw array (no envelope without limit)', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { offset: '2' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const arr = res.body as JsonObject[];
      // 5 total - 2 offset = 3 remaining
      expect(arr.length).toBe(3);
      // Each item is an entity, not an envelope
      for (const lead of arr) {
        expect(typeof lead).toBe('object');
        expect((lead as JsonObject)['items']).toBeUndefined();
        expect((lead as JsonObject)['totalCount']).toBeUndefined();
      }
    }, 60_000);
  });
});
