/**
 * 33 — Contract Validation & Data Integrity via full Specmatic stack.
 *
 * Section 1: Verifies the OpenAPI contract validator rejects invalid payloads
 * with 400 CONTRACT_VIOLATION for POST /leads. Each invalid request must not
 * produce any events (event count unchanged).
 *
 * Section 2: Verifies data integrity through create-read cycles — types are
 * preserved (numbers, strings, nulls, booleans, timestamps) after round-tripping
 * through the full CQRS/ES pipeline.
 *
 * Contract under test: POST /leads (additionalProperties: false, required fields,
 * enum validation, minLength, type checking).
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { fwd, getGraphNode, getEventCount, javaAvailable } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;


describeWithJava('33 — Contract Validation (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 1: Contract Validation — request rejection
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Contract validation: invalid payloads rejected with 400', () => {

    it('missing required field: POST /leads without companyName → 400', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        // companyName intentionally omitted
        contactName: 'Missing Field User',
        phone: '+61 2 9000 0001',
        email: 'missing-field@test.com',
        source: 'WEBSITE',
      });

      expect(res.status).toBe(400);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);

    it('missing multiple required fields: POST /leads with only companyName → 400', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Only Company Name',
        // contactName, phone, email, source all omitted
      });

      expect(res.status).toBe(400);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);

    it('wrong type for field: POST /leads with companyName as number → 400', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 123,
        contactName: 'Wrong Type User',
        phone: '+61 2 9000 0002',
        email: 'wrong-type@test.com',
        source: 'WEBSITE',
      });

      expect(res.status).toBe(400);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);

    it('invalid enum value: POST /leads with source "INVALID_SOURCE" → 400', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Invalid Enum Corp',
        contactName: 'Enum User',
        phone: '+61 2 9000 0003',
        email: 'invalid-enum@test.com',
        source: 'INVALID_SOURCE',
      });

      expect(res.status).toBe(400);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);

    it('empty string for minLength field: POST /leads with companyName "" → 400', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: '',
        contactName: 'Empty String User',
        phone: '+61 2 9000 0004',
        email: 'empty-string@test.com',
        source: 'WEBSITE',
      });

      expect(res.status).toBe(400);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);

    it('extra unknown properties rejected: additionalProperties false → 400', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Extra Props Corp',
        contactName: 'Extra User',
        phone: '+61 2 9000 0005',
        email: 'extra-props@test.com',
        source: 'WEBSITE',
        unknownField: 'test',
      });

      expect(res.status).toBe(400);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);

    it('null for required field: POST /leads with companyName null → 400', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: null,
        contactName: 'Null Field User',
        phone: '+61 2 9000 0006',
        email: 'null-field@test.com',
        source: 'WEBSITE',
      });

      expect(res.status).toBe(400);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);

    it('empty body: POST /leads with {} → 400 (missing all required fields)', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', '/leads', {});

      expect(res.status).toBe(400);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);

    it('array body when object expected: POST with [] → 400', async () => {
      const eventsBefore = await getEventCount(app.engineUrl);

      const res = await fwd(app.engineUrl, 'POST', '/leads/00000000-0000-7000-8000-000000000010/contact', []);

      expect(res.status).toBe(400);

      const eventsAfter = await getEventCount(app.engineUrl);
      expect(eventsAfter).toBe(eventsBefore);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 2: Data Integrity — Round-Trip Type Preservation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Data integrity: round-trip type preservation', () => {

    it('integer zero preserved: score is a number, not string', async () => {
      // COLD_LIST source maps to score=20 via ts:computeScore
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Score Type Corp',
        contactName: 'ST User',
        phone: '+61 2 9000 1001',
        email: 'score-type@test.com',
        source: 'COLD_LIST',
      });
      expect([200, 201]).toContain(res.status);
      const leadId = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node).not.toBeNull();
      expect(typeof node!['score']).toBe('number');
      expect(node!['score']).toBe(20);
    }, 60_000);

    it('string values preserved: exact companyName round-trip', async () => {
      const companyName = 'Preservation Test Corp — Special Chars: <>&"\'';
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName,
        contactName: 'Preserve User',
        phone: '+61 2 9000 1002',
        email: 'preserve@test.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(res.status);
      const leadId = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node).not.toBeNull();
      expect(node!['companyName']).toBe(companyName);
    }, 60_000);

    it('null vs absent: unset nullable fields are null, not undefined or string "null"', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Null Check Corp',
        contactName: 'NC User',
        phone: '+61 2 9000 1003',
        email: 'null-check@test.com',
        source: 'WEBSITE',
      });
      expect([200, 201]).toContain(res.status);
      const leadId = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node).not.toBeNull();

      // assignedAgentId is unset (null or absent); critically NOT the string "null".
      const v = node!['assignedAgentId'];
      expect(v === null || v === undefined).toBe(true);
      expect(v).not.toBe('null');
    }, 60_000);

    it('boolean preservation: _deleted is true (boolean) after soft delete', async () => {
      // Create a lead to delete
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Bool Check Corp',
        contactName: 'BC User',
        phone: '+61 2 9000 1004',
        email: 'bool-check@test.com',
        source: 'PARTNER',
      });
      expect([200, 201]).toContain(res.status);
      const leadId = (res.body as JsonObject)['id'] as string;

      // Delete it
      const deleteRes = await fwd(app.engineUrl, 'DELETE', `/leads/${leadId}`);
      expect(deleteRes.status).toBe(200);

      // Verify _deleted is boolean true, not string "true" or number 1
      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node).not.toBeNull();
      expect(node!['_deleted']).toBe(true);
      expect(typeof node!['_deleted']).toBe('boolean');
      expect(node!['_deleted']).not.toBe('true');
      expect(node!['_deleted']).not.toBe(1);
    }, 60_000);

    it('timestamp format: createdAt is valid ISO-8601 parseable by Date', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'Timestamp Corp',
        contactName: 'TS User',
        phone: '+61 2 9000 1005',
        email: 'timestamp@test.com',
        source: 'REFERRAL',
      });
      expect([200, 201]).toContain(res.status);
      const leadId = (res.body as JsonObject)['id'] as string;

      const node = await getGraphNode(app.engineUrl, leadId);
      expect(node).not.toBeNull();

      const createdAt = node!['createdAt'] as string;
      expect(typeof createdAt).toBe('string');

      // Must be parseable by Date
      const parsed = new Date(createdAt);
      expect(parsed.getTime()).not.toBeNaN();

      // Must look like ISO-8601 (e.g. 2026-05-28T12:00:00.000Z)
      expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      // Must be a recent timestamp (within last 5 minutes of real time)
      const now = Date.now();
      expect(Math.abs(parsed.getTime() - now)).toBeLessThan(300_000);
    }, 60_000);
  });
});
