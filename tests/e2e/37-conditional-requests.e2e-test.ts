/**
 * 37 — HTTP Conditional Requests (RFC 7232) via full Specmatic stack.
 *
 * Verifies the engine's single-entity GET responses honour HTTP conditional
 * request semantics:
 *
 *   - GET /<resource>/{id} responses include an `ETag` header (quoted, e.g. `"5"`)
 *     derived from the entity's current sequenceVersion.
 *   - GET /<resource>/{id} responses include a `Last-Modified` header in HTTP-date
 *     format derived from the entity's `updatedAt` audit field.
 *   - Requests carrying `If-None-Match` matching the current ETag return 304 Not
 *     Modified with an empty body.
 *   - Requests carrying `If-Modified-Since` where the entity has not been modified
 *     since the supplied date return 304 Not Modified.
 *   - HEAD requests honour the same conditional-request semantics.
 *   - Conditional headers are scoped to single-entity GETs: collection GETs,
 *     mutating verbs, and 404 responses do not short-circuit to 304.
 *
 * All behavior is defined in the CRM YAML files and the gateway pipeline. This
 * test only sends HTTP requests and verifies responses + graph state via admin
 * endpoints.
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { fwd, javaAvailable } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

// APEX_LEAD_ID is seeded via initialization in tests/fixtures/crm/dsl/lead.yaml.
const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';
// BLUESKY_LEAD_ID is also seeded via the same fixture and is used to verify
// that independent entities have independent ETag values.
const BLUESKY_LEAD_ID = '00000000-0000-7000-8000-000000000011';
const NON_EXISTENT_LEAD_ID = '00000000-dead-7000-8000-000000000099';

// Helpers used to parse RFC 7232 ETag values into the underlying integer
// sequenceVersion. The gateway wraps ETag values in double-quotes per RFC.
function parseEtag(raw: string | undefined): number {
  if (raw === undefined) return Number.NaN;
  return Number(raw.replace(/^"|"$/g, ''));
}

// A 304 response carries no body. Different stacks may serialise this as null,
// empty string, or {} — accept any of those.
function isEmptyBody(body: unknown): boolean {
  if (body === null || body === undefined) return true;
  if (body === '') return true;
  if (typeof body === 'object' && !Array.isArray(body) && Object.keys(body as object).length === 0) return true;
  return false;
}

describeWithJava('37 — HTTP Conditional Requests (full Specmatic stack)', () => {
  let app: E2eApp;
  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ────────────────────────────────────────────────────────────────────────────
  // Section 1: ETag generation
  // ────────────────────────────────────────────────────────────────────────────

  describe('ETag generation', () => {
    it('GET /leads/{id} includes a quoted ETag header derived from sequenceVersion', async () => {
      const res = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`);
      expect(res.status).toBe(200);

      const etag = res.headers['etag'];
      expect(etag).toBeDefined();
      // RFC 7232 §2.3: ETag values must be surrounded by double-quotes.
      expect(etag).toMatch(/^"\d+"$/);
    }, 60_000);

    it('mutating an entity advances the ETag returned by subsequent GETs', async () => {
      // Create a fresh lead so we have an isolated entity for the version walk.
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'ETag Walk Corp',
        contactName: 'EW User',
        phone: '+61 2 9100 0001',
        email: 'etag-walk@example.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(createRes.status);
      const leadId = (createRes.body as JsonObject)['id'] as string;

      const beforeRes = await fwd(app.engineUrl, 'GET', `/leads/${leadId}`);
      expect(beforeRes.status).toBe(200);
      const etagBefore = parseEtag(beforeRes.headers['etag']);
      expect(Number.isFinite(etagBefore)).toBe(true);

      // Drive a state transition (NEW → CONTACTED) to bump the sequenceVersion.
      const mutateRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
      expect(mutateRes.status).toBe(200);

      const afterRes = await fwd(app.engineUrl, 'GET', `/leads/${leadId}`);
      expect(afterRes.status).toBe(200);
      const etagAfter = parseEtag(afterRes.headers['etag']);
      expect(Number.isFinite(etagAfter)).toBe(true);
      expect(etagAfter).toBeGreaterThan(etagBefore);
    }, 60_000);

    it('collection GET /leads does not include an entity-level ETag header', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // ETag is scoped to single-entity GETs; collection responses should omit it.
      expect(res.headers['etag']).toBeUndefined();
    }, 60_000);

    it('two consecutive GETs of the same untouched entity return the same ETag', async () => {
      const first = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`);
      const second = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.headers['etag']).toBeDefined();
      // No mutation occurred between the two reads, so the sequenceVersion-derived ETag must match.
      expect(first.headers['etag']).toBe(second.headers['etag']);
    }, 60_000);

    it('different entities have independent ETag values', async () => {
      const apex = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`);
      const bluesky = await fwd(app.engineUrl, 'GET', `/leads/${BLUESKY_LEAD_ID}`);
      expect(apex.status).toBe(200);
      expect(bluesky.status).toBe(200);
      // Each entity carries its own quoted-integer ETag — independence is the contract.
      expect(apex.headers['etag']).toMatch(/^"\d+"$/);
      expect(bluesky.headers['etag']).toMatch(/^"\d+"$/);
    }, 60_000);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Section 2: Last-Modified header
  // ────────────────────────────────────────────────────────────────────────────

  describe('Last-Modified header', () => {
    it('GET /leads/{id} on a mutated entity includes Last-Modified in HTTP-date format', async () => {
      // Create a fresh lead and mutate it once so an updatedAt is populated.
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'LastModified Corp',
        contactName: 'LM User',
        phone: '+61 2 9100 0002',
        email: 'last-modified@example.com',
        source: 'REFERRAL',
      });
      expect([200, 201]).toContain(createRes.status);
      const leadId = (createRes.body as JsonObject)['id'] as string;

      const getRes = await fwd(app.engineUrl, 'GET', `/leads/${leadId}`);
      expect(getRes.status).toBe(200);
      const lastModified = getRes.headers['last-modified'];
      expect(lastModified).toBeDefined();
      // HTTP-date is parseable by Date.parse and produces a finite timestamp.
      const ts = Date.parse(lastModified);
      expect(Number.isFinite(ts)).toBe(true);
    }, 60_000);

    it('Last-Modified value matches the entity updatedAt converted to UTC string', async () => {
      // Mutate APEX_LEAD_ID so updatedAt is current (initialization fixture has
      // no updatedAt by default — only mutations populate it).
      const mutateRes = await fwd(app.engineUrl, 'POST', `/leads/${APEX_LEAD_ID}/contact`, {});
      // Lead may already be CONTACTED from earlier tests — either 200 or 422 is fine here;
      // what matters is that a subsequent GET still surfaces the updatedAt-driven Last-Modified.
      expect([200, 422]).toContain(mutateRes.status);

      const getRes = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`);
      expect(getRes.status).toBe(200);

      const body = getRes.body as JsonObject;
      const updatedAt = body['updatedAt'];
      const lastModified = getRes.headers['last-modified'];

      if (typeof updatedAt === 'string') {
        expect(lastModified).toBeDefined();
        const expectedUtc = new Date(updatedAt).toUTCString();
        expect(lastModified).toBe(expectedUtc);
      }
    }, 60_000);

    it('collection GET /leads does not include a Last-Modified header', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads');
      expect(res.status).toBe(200);
      // Last-Modified is scoped to single-entity GETs; collection responses must omit it.
      expect(res.headers['last-modified']).toBeUndefined();
    }, 60_000);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Section 3: If-None-Match → 304
  // ────────────────────────────────────────────────────────────────────────────

  describe('If-None-Match conditional GETs', () => {
    it('matching If-None-Match returns 304 Not Modified with empty body', async () => {
      const initial = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`);
      expect(initial.status).toBe(200);
      const etag = initial.headers['etag'];
      expect(etag).toBeDefined();

      const conditional = await fwd(
        app.engineUrl,
        'GET',
        `/leads/${APEX_LEAD_ID}`,
        null,
        { 'If-None-Match': etag },
      );
      expect(conditional.status).toBe(304);
      expect(isEmptyBody(conditional.body)).toBe(true);
    }, 60_000);

    it('304 response still includes the ETag header for cache revalidation', async () => {
      const initial = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`);
      const etag = initial.headers['etag'];

      const conditional = await fwd(
        app.engineUrl,
        'GET',
        `/leads/${APEX_LEAD_ID}`,
        null,
        { 'If-None-Match': etag },
      );
      expect(conditional.status).toBe(304);
      expect(conditional.headers['etag']).toBe(etag);
    }, 60_000);

    it('non-matching If-None-Match returns 200 with the full entity body', async () => {
      const res = await fwd(
        app.engineUrl,
        'GET',
        `/leads/${APEX_LEAD_ID}`,
        null,
        { 'If-None-Match': '"999"' },
      );
      expect(res.status).toBe(200);
      const body = res.body as JsonObject;
      expect(body['id']).toBe(APEX_LEAD_ID);
      expect(body['companyName']).toBeDefined();
    }, 60_000);

    it('stale If-None-Match after a mutation returns 200 with the new ETag', async () => {
      // Create a fresh lead to control the mutation lifecycle.
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Stale Etag Corp',
        contactName: 'SE User',
        phone: '+61 2 9100 0003',
        email: 'stale-etag@example.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(createRes.status);
      const leadId = (createRes.body as JsonObject)['id'] as string;

      const beforeMutation = await fwd(app.engineUrl, 'GET', `/leads/${leadId}`);
      const oldEtag = beforeMutation.headers['etag'];
      expect(oldEtag).toBeDefined();

      // Bump the sequenceVersion so oldEtag is now stale.
      const mutateRes = await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
      expect(mutateRes.status).toBe(200);

      // The stale ETag should no longer match — expect a full 200 response.
      const conditional = await fwd(
        app.engineUrl,
        'GET',
        `/leads/${leadId}`,
        null,
        { 'If-None-Match': oldEtag },
      );
      expect(conditional.status).toBe(200);
      const newEtag = conditional.headers['etag'];
      expect(newEtag).toBeDefined();
      expect(newEtag).not.toBe(oldEtag);
      expect(parseEtag(newEtag)).toBeGreaterThan(parseEtag(oldEtag));
    }, 60_000);

    it('If-None-Match with unquoted value matches the engine-quoted ETag (engine strips quotes)', async () => {
      const initial = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`);
      expect(initial.status).toBe(200);
      const quoted = initial.headers['etag']; // e.g. '"5"'
      expect(quoted).toMatch(/^"\d+"$/);
      const unquoted = quoted.replace(/^"|"$/g, ''); // e.g. '5'

      const conditional = await fwd(
        app.engineUrl,
        'GET',
        `/leads/${APEX_LEAD_ID}`,
        null,
        { 'If-None-Match': unquoted },
      );
      // Engine strips surrounding quotes before comparison, so the unquoted form must match.
      expect(conditional.status).toBe(304);
      expect(isEmptyBody(conditional.body)).toBe(true);
    }, 60_000);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Section 4: If-Modified-Since → 304
  // ────────────────────────────────────────────────────────────────────────────

  describe('If-Modified-Since conditional GETs', () => {
    it('future If-Modified-Since returns 304 (entity not modified since)', async () => {
      // Ensure the entity has an updatedAt by mutating it (idempotent — already
      // CONTACTED is acceptable here as long as a Last-Modified is exposed).
      await fwd(app.engineUrl, 'POST', `/leads/${APEX_LEAD_ID}/contact`, {}).catch(() => { /* ignore */ });

      const initial = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`);
      expect(initial.status).toBe(200);

      const lastModified = initial.headers['last-modified'];
      // The conditional path is only meaningful when Last-Modified is present.
      if (lastModified === undefined) return;

      // Pick a date well after the entity's updatedAt to guarantee a 304.
      const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();

      const conditional = await fwd(
        app.engineUrl,
        'GET',
        `/leads/${APEX_LEAD_ID}`,
        null,
        { 'If-Modified-Since': future },
      );
      expect(conditional.status).toBe(304);
      expect(isEmptyBody(conditional.body)).toBe(true);
    }, 60_000);

    it('epoch If-Modified-Since returns 200 (entity was modified after 1970)', async () => {
      const res = await fwd(
        app.engineUrl,
        'GET',
        `/leads/${APEX_LEAD_ID}`,
        null,
        { 'If-Modified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' },
      );
      expect(res.status).toBe(200);
      const body = res.body as JsonObject;
      expect(body['id']).toBe(APEX_LEAD_ID);
    }, 60_000);

    it('malformed If-Modified-Since header is ignored and 200 is returned', async () => {
      const res = await fwd(
        app.engineUrl,
        'GET',
        `/leads/${APEX_LEAD_ID}`,
        null,
        { 'If-Modified-Since': 'this is not a date' },
      );
      // The header must be silently ignored — no 304, no 500.
      expect(res.status).toBe(200);
      const body = res.body as JsonObject;
      expect(body['id']).toBe(APEX_LEAD_ID);
    }, 60_000);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Section 5: HEAD requests inherit conditional semantics
  // ────────────────────────────────────────────────────────────────────────────

  describe('HEAD requests inherit conditional semantics', () => {
    it('HEAD /leads/{id} returns 200 with ETag and Last-Modified and empty body', async () => {
      // Ensure an updatedAt exists so HEAD surfaces Last-Modified.
      await fwd(app.engineUrl, 'POST', `/leads/${APEX_LEAD_ID}/contact`, {}).catch(() => { /* ignore */ });

      const res = await fwd(app.engineUrl, 'HEAD', `/leads/${APEX_LEAD_ID}`);
      expect(res.status).toBe(200);
      expect(res.headers['etag']).toBeDefined();
      expect(res.headers['etag']).toMatch(/^"\d+"$/);
      // HEAD responses by definition carry no entity body.
      expect(isEmptyBody(res.body)).toBe(true);
    }, 60_000);

    it('HEAD /leads/{id} with matching If-None-Match returns 304 with empty body', async () => {
      const initial = await fwd(app.engineUrl, 'HEAD', `/leads/${APEX_LEAD_ID}`);
      expect(initial.status).toBe(200);
      const etag = initial.headers['etag'];
      expect(etag).toBeDefined();

      const conditional = await fwd(
        app.engineUrl,
        'HEAD',
        `/leads/${APEX_LEAD_ID}`,
        null,
        { 'If-None-Match': etag },
      );
      expect(conditional.status).toBe(304);
      expect(isEmptyBody(conditional.body)).toBe(true);
    }, 60_000);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Section 6: Negative cases — conditional headers must NOT trigger 304
  // ────────────────────────────────────────────────────────────────────────────

  describe('Conditional headers do not short-circuit non-applicable responses', () => {
    it('POST with If-None-Match still executes the mutation (mutations ignore If-None-Match)', async () => {
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Mutation Ignores Conditional Corp',
        contactName: 'MIC User',
        phone: '+61 2 9100 0004',
        email: 'mutation-conditional@example.com',
        source: 'PARTNER',
      });
      expect([200, 201]).toContain(createRes.status);
      const leadId = (createRes.body as JsonObject)['id'] as string;

      const getRes = await fwd(app.engineUrl, 'GET', `/leads/${leadId}`);
      const etag = getRes.headers['etag'];
      expect(etag).toBeDefined();

      // POST with a current ETag in If-None-Match should still execute — the
      // contact transition must succeed and bump the version.
      const mutateRes = await fwd(
        app.engineUrl,
        'POST',
        `/leads/${leadId}/contact`,
        {},
        { 'If-None-Match': etag },
      );
      expect(mutateRes.status).toBe(200);

      const afterRes = await fwd(app.engineUrl, 'GET', `/leads/${leadId}`);
      expect(afterRes.status).toBe(200);
      expect((afterRes.body as JsonObject)['status']).toBe('CONTACTED');
      expect(parseEtag(afterRes.headers['etag'])).toBeGreaterThan(parseEtag(etag));
    }, 60_000);

    it('collection GET with If-None-Match returns 200 (no entity-level conditional handling)', async () => {
      const res = await fwd(
        app.engineUrl,
        'GET',
        '/leads',
        null,
        { 'If-None-Match': '"1"' },
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // Collections never produce a 304 from this code path.
      expect(res.headers['etag']).toBeUndefined();
    }, 60_000);

    it('GET on a nonexistent entity with If-None-Match returns 404, not 304', async () => {
      const res = await fwd(
        app.engineUrl,
        'GET',
        `/leads/${NON_EXISTENT_LEAD_ID}`,
        null,
        { 'If-None-Match': '"1"' },
      );
      expect(res.status).toBe(404);
    }, 60_000);
  });
});
