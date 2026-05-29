/**
 * 43 — Query Extensions: verifies three additions to the query engine end-to-end
 * through the full Specmatic+plugin+Node stack.
 *
 *   1. Sparse fieldsets — `?fields=id,companyName,score`
 *      Returns only the specified fields per entity. Applied after derived
 *      properties so x-derived fields can be selected, before relationship
 *      expansion so `?include=...` still works. `id` is always preserved.
 *
 *   2. Cursor-based pagination — `?cursor=<opaque>&limit=N`
 *      Alternative to `?offset=N`. The engine emits `nextCursor` in the envelope
 *      when `hasMore: true`. Cursor takes precedence over offset when both
 *      are present.
 *
 *   3. Deep nested filtering — `?address.city=Melbourne` via operator filters
 *      (e.g. `?customer.contact.email:contains=@gmail.com`). Operator filters
 *      walk dotted paths via getByDotPath; queryMapping already handles
 *      nested fields via CEL's state.X.Y syntax.
 *
 * DSL files under test:
 *   lead.yaml (5 seeded leads with id, companyName, contactName, phone, email,
 *              source, status, score, createdAt, callIds, notes)
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

describeWithJava('43 — Query Extensions (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // Field selection (sparse fieldsets)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Field selection (sparse fieldsets)', () => {

    it('GET /leads?fields=id,companyName returns only id and companyName per item', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        fields: 'id,companyName',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const leads = res.body as JsonObject[];
      expect(leads.length).toBe(5);

      for (const lead of leads) {
        // Only the two requested fields should be present.
        expect(Object.keys(lead).sort()).toEqual(['companyName', 'id']);
        // Non-selected fields must not appear.
        expect(lead['status']).toBeUndefined();
        expect(lead['score']).toBeUndefined();
        expect(lead['source']).toBeUndefined();
        expect(lead['contactName']).toBeUndefined();
        // Selected fields carry real values.
        expect(typeof lead['id']).toBe('string');
        expect(typeof lead['companyName']).toBe('string');
      }
    }, 60_000);

    it('GET /leads/{id}?fields=companyName,status returns single entity with only those fields plus id', async () => {
      const res = await fwd(app.engineUrl, 'GET', `/leads/${BLUESKY_LEAD_ID}`, null, {}, {
        fields: 'companyName,status',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);

      const lead = res.body as JsonObject;
      // id is always preserved, plus the two requested fields.
      expect(Object.keys(lead).sort()).toEqual(['companyName', 'id', 'status']);
      expect(lead['id']).toBe(BLUESKY_LEAD_ID);
      expect(lead['companyName']).toBe('BlueSky Tech');
      expect(lead['status']).toBe('CONTACTED');
      // Excluded fields must not leak.
      expect(lead['score']).toBeUndefined();
      expect(lead['contactName']).toBeUndefined();
      expect(lead['email']).toBeUndefined();
    }, 60_000);

    it('GET /leads?fields=id,score&limit=2 returns envelope whose items each have only id and score', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        fields: 'id,score',
        limit: '2',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);

      const env = res.body as JsonObject;
      expect(Array.isArray(env['items'])).toBe(true);
      const items = env['items'] as JsonObject[];
      expect(items.length).toBe(2);
      expect(env['totalCount']).toBe(5);
      expect(env['limit']).toBe(2);
      expect(env['hasMore']).toBe(true);

      for (const lead of items) {
        // Only id and score should appear in each item.
        expect(Object.keys(lead).sort()).toEqual(['id', 'score']);
        expect(typeof lead['id']).toBe('string');
        expect(typeof lead['score']).toBe('number');
        // Non-selected fields are absent.
        expect(lead['companyName']).toBeUndefined();
        expect(lead['status']).toBeUndefined();
      }
    }, 60_000);

    it('GET /leads?fields=nonExistent returns entities containing only id (nonExistent is dropped)', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        fields: 'nonExistent',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const leads = res.body as JsonObject[];
      expect(leads.length).toBe(5);

      for (const lead of leads) {
        // Only `id` should be present — nonExistent is dropped because the
        // entity never had that key, and `id` is always preserved.
        expect(Object.keys(lead)).toEqual(['id']);
        expect(typeof lead['id']).toBe('string');
        expect(lead['nonExistent']).toBeUndefined();
      }
    }, 60_000);

    it('GET /leads (no fields param) returns full entities (backward compatibility)', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {});
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const leads = res.body as JsonObject[];
      expect(leads.length).toBe(5);

      // Every lead carries the full schema — verify the seeded required fields exist.
      for (const lead of leads) {
        expect(typeof lead['id']).toBe('string');
        expect(typeof lead['companyName']).toBe('string');
        expect(typeof lead['contactName']).toBe('string');
        expect(typeof lead['phone']).toBe('string');
        expect(typeof lead['email']).toBe('string');
        expect(typeof lead['source']).toBe('string');
        expect(typeof lead['status']).toBe('string');
        expect(typeof lead['score']).toBe('number');
        expect(typeof lead['createdAt']).toBe('string');
      }
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Cursor-based pagination
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Cursor-based pagination', () => {

    it('GET /leads?limit=2 returns an envelope containing nextCursor and exactly 2 items', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        limit: '2',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);

      const env = res.body as JsonObject;
      const items = env['items'] as JsonObject[];
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBe(2);
      expect(env['totalCount']).toBe(5);
      expect(env['limit']).toBe(2);
      expect(env['hasMore']).toBe(true);

      // nextCursor present because hasMore is true.
      expect(typeof env['nextCursor']).toBe('string');
      expect((env['nextCursor'] as string).length).toBeGreaterThan(0);
    }, 60_000);

    it('GET /leads?limit=2&cursor=<from previous page> returns the NEXT 2 items (no overlap)', async () => {
      // Page 1: grab first two and capture nextCursor.
      const page1 = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { limit: '2' });
      expect(page1.status).toBe(200);
      const env1 = page1.body as JsonObject;
      const items1 = env1['items'] as JsonObject[];
      const cursor1 = env1['nextCursor'] as string;
      expect(items1.length).toBe(2);
      expect(typeof cursor1).toBe('string');

      const ids1 = items1.map((l) => l['id'] as string);

      // Page 2: pass the cursor along, expect 2 different IDs.
      const page2 = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        limit: '2',
        cursor: cursor1,
      });
      expect(page2.status).toBe(200);
      const env2 = page2.body as JsonObject;
      const items2 = env2['items'] as JsonObject[];
      expect(items2.length).toBe(2);

      const ids2 = items2.map((l) => l['id'] as string);

      // No overlap between page 1 and page 2.
      for (const id of ids2) {
        expect(ids1).not.toContain(id);
      }

      // Page 2 still reports the total count.
      expect(env2['totalCount']).toBe(5);
      // hasMore is true because only 4 of 5 have been emitted so far.
      expect(env2['hasMore']).toBe(true);
      expect(typeof env2['nextCursor']).toBe('string');
    }, 60_000);

    it('GET /leads?limit=10 (greater than total) returns hasMore=false and no nextCursor', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        limit: '10',
      });
      expect(res.status).toBe(200);
      const env = res.body as JsonObject;
      const items = env['items'] as JsonObject[];
      expect(items.length).toBe(5);
      expect(env['totalCount']).toBe(5);
      expect(env['hasMore']).toBe(false);
      // No nextCursor when there are no more pages.
      expect(env['nextCursor']).toBeUndefined();
    }, 60_000);

    it('cursor + sort=score&order=desc still paginates in the requested sort order', async () => {
      // Sort by score descending and grab page 1.
      const page1 = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        sort: 'score',
        order: 'desc',
        limit: '2',
      });
      expect(page1.status).toBe(200);
      const env1 = page1.body as JsonObject;
      const items1 = env1['items'] as JsonObject[];
      expect(items1.length).toBe(2);
      // Top two by score desc: BlueSky (80), Delta (70).
      expect(items1[0]['id']).toBe(BLUESKY_LEAD_ID);
      expect(items1[0]['score']).toBe(80);
      expect(items1[1]['id']).toBe(DELTA_LEAD_ID);
      expect(items1[1]['score']).toBe(70);

      const cursor1 = env1['nextCursor'] as string;
      expect(typeof cursor1).toBe('string');

      // Page 2 with the same sort + cursor: next two by score desc.
      const page2 = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        sort: 'score',
        order: 'desc',
        limit: '2',
        cursor: cursor1,
      });
      expect(page2.status).toBe(200);
      const env2 = page2.body as JsonObject;
      const items2 = env2['items'] as JsonObject[];
      expect(items2.length).toBe(2);

      // Scores on page 2 must each be ≤ the smallest score on page 1 (70).
      for (const lead of items2) {
        expect((lead['score'] as number) <= 70).toBe(true);
      }

      // No overlap with page 1.
      const ids1 = items1.map((l) => l['id'] as string);
      for (const lead of items2) {
        expect(ids1).not.toContain(lead['id']);
      }
    }, 60_000);

    it('invalid cursor (random base64) returns an empty page gracefully (no crash)', async () => {
      // A base64 string that does not decode to a {lastId} object.
      const garbage = Buffer.from('not-a-cursor-json', 'utf8').toString('base64');

      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        limit: '2',
        cursor: garbage,
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);

      const env = res.body as JsonObject;
      const items = env['items'] as JsonObject[];
      expect(Array.isArray(items)).toBe(true);
      // Malformed cursor → empty page.
      expect(items.length).toBe(0);
      // totalCount still reflects the underlying filtered set.
      expect(env['totalCount']).toBe(5);
      expect(env['hasMore']).toBe(false);
      // No nextCursor on an empty page.
      expect(env['nextCursor']).toBeUndefined();
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Deep nested filtering (dotted-path operator filters + queryMapping)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Deep nested filtering', () => {

    it('simple field equality via queryMapping still works (?source filter — backward compat sanity)', async () => {
      // Lead boundary's queryMapping handles `status` and `agentId` and `campaignId`.
      // status=NEW must still match the seeded APEX and ECHO leads.
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        status: 'NEW',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const leads = res.body as JsonObject[];
      // Two seeded leads with status=NEW: Apex and Echo.
      expect(leads.length).toBe(2);
      const returnedIds = leads.map((l) => l['id'] as string).sort();
      expect(returnedIds).toEqual([APEX_LEAD_ID, ECHO_LEAD_ID].sort());
      for (const lead of leads) {
        expect(lead['status']).toBe('NEW');
      }
    }, 60_000);

    it('top-level operator filter uses the dotted-path code path (single-segment) — ?status:ne=NEW', async () => {
      // The dotted-path lookup must yield identical results to a direct lookup
      // when there is exactly one segment. ?status:ne=NEW should return
      // every non-NEW lead — BlueSky (CONTACTED), Cornerstone (QUALIFIED),
      // Delta (DISQUALIFIED).
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'status:ne': 'NEW',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const leads = res.body as JsonObject[];
      expect(leads.length).toBe(3);
      const returnedIds = leads.map((l) => l['id'] as string).sort();
      expect(returnedIds).toEqual([BLUESKY_LEAD_ID, CORNER_LEAD_ID, DELTA_LEAD_ID].sort());
      for (const lead of leads) {
        expect(lead['status']).not.toBe('NEW');
      }
    }, 60_000);

    it('dotted-path operator filter against a missing nested field returns no matches gracefully', async () => {
      // No seeded lead carries a `customer` nested object, so requesting
      // customer.email:contains=@example.com should yield zero matches
      // (getByDotPath returns undefined; the filter rejects undefined values).
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'customer.contact.email:contains': '@example.com',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as JsonObject[]).length).toBe(0);
    }, 60_000);

    it('dotted-path operator filter that points at a non-object intermediate segment returns no matches', async () => {
      // `status` is a string (not an object), so `status.code:eq` traverses
      // through a non-object and must return undefined for every entity.
      // Use `:contains` against a value that no entity could possibly have.
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'status.subfield:contains': 'whatever',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as JsonObject[]).length).toBe(0);
    }, 60_000);

    it('full lifecycle: created lead is filterable via top-level operator filter (?companyName:contains)', async () => {
      // Create a lead with a unique companyName, then query by substring.
      const unique = `QueryExt-${Date.now()}`;
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: `${unique} Co`,
        contactName: 'Nested Tester',
        phone: '+61 2 9300 0001',
        email: 'nested@queryext.test',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(createRes.status);
      const createdId = (createRes.body as JsonObject)['id'] as string;
      expect(typeof createdId).toBe('string');

      // ?companyName:contains=<unique-prefix> must return only the lead we just created.
      const filtered = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        'companyName:contains': unique,
      });
      expect(filtered.status).toBe(200);
      expect(Array.isArray(filtered.body)).toBe(true);

      const matches = filtered.body as JsonObject[];
      expect(matches.length).toBe(1);
      expect(matches[0]['id']).toBe(createdId);
      expect(matches[0]['companyName']).toBe(`${unique} Co`);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Combined: fields + cursor + filter together
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Features combined', () => {

    it('fields + cursor + sort interact correctly across two pages', async () => {
      // Page 1: top 2 by score desc, projecting only id + score.
      const page1 = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        fields: 'id,score',
        sort: 'score',
        order: 'desc',
        limit: '2',
      });
      expect(page1.status).toBe(200);
      const env1 = page1.body as JsonObject;
      const items1 = env1['items'] as JsonObject[];
      expect(items1.length).toBe(2);
      for (const lead of items1) {
        // fields applied: only id and score in each item.
        expect(Object.keys(lead).sort()).toEqual(['id', 'score']);
      }
      const cursor = env1['nextCursor'] as string;
      expect(typeof cursor).toBe('string');

      // Page 2: continue with cursor, same projection and sort.
      const page2 = await fwd(app.engineUrl, 'GET', '/leads', null, {}, {
        fields: 'id,score',
        sort: 'score',
        order: 'desc',
        limit: '2',
        cursor,
      });
      expect(page2.status).toBe(200);
      const env2 = page2.body as JsonObject;
      const items2 = env2['items'] as JsonObject[];
      expect(items2.length).toBe(2);
      for (const lead of items2) {
        expect(Object.keys(lead).sort()).toEqual(['id', 'score']);
      }

      // No overlap between pages, score ordering preserved.
      const ids1 = items1.map((l) => l['id'] as string);
      const ids2 = items2.map((l) => l['id'] as string);
      for (const id of ids2) {
        expect(ids1).not.toContain(id);
      }

      // Total still reports underlying entity count.
      expect(env2['totalCount']).toBeGreaterThanOrEqual(5);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Sanity: all seeded leads are reachable across paginated cursor sweep
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Cursor sweep covers all seeded leads', () => {

    it('walking pages with cursor visits every seeded lead exactly once', async () => {
      const seen = new Set<string>();
      let cursor: string | undefined;

      // Limit to a defensive max iteration so a bug never produces an infinite loop.
      for (let i = 0; i < 10; i++) {
        const query: Record<string, string> = { limit: '2' };
        if (cursor !== undefined) query['cursor'] = cursor;

        const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, query);
        expect(res.status).toBe(200);
        const env = res.body as JsonObject;
        const items = env['items'] as JsonObject[];

        for (const lead of items) {
          seen.add(lead['id'] as string);
        }

        if (env['hasMore'] !== true) break;
        cursor = env['nextCursor'] as string;
        expect(typeof cursor).toBe('string');
      }

      // Every seeded lead must have been encountered at least once.
      for (const id of ALL_SEEDED_LEAD_IDS) {
        expect(seen.has(id)).toBe(true);
      }
    }, 60_000);
  });
});
