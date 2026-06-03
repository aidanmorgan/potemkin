/**
 * 71 — Static boundary mask: field masking (engine-only).
 *
 * Demonstrates `mask: [internalNotes, authorEmail]` declared in a boundary
 * DSL file. Fields listed in `mask:` are persisted in aggregate state but
 * removed from the response body before it is served — callers never see them.
 *
 * How mask: is applied:
 *   BoundaryConfig.mask is compiled by compileResponseMask() into a list of
 *   RFC 6901 remove patches. The response-mutation pipeline (responseMutations.ts)
 *   records these as `source: "mask"` JournalEntries in the patch journal.
 *
 * Consumer contract:
 *   The engine returns the BASE body in `body` and carries the mutation ops in
 *   `_patches`. The Kotlin plugin (PotemkinResponseInterceptor) applies `_patches`
 *   to `body` AFTER Specmatic contract validation, so masking a contract-required
 *   field does not fail validation. In engine-only tests the harness helper
 *   applyForwardPatches() mirrors this step — assertions run on the patched result.
 *
 * Fixture: tests/fixtures/mask-fields/
 *   Report boundary (/reports)          — mask: [internalNotes, authorEmail]
 *   ReportById boundary (/reports/{id}) — mask: [internalNotes, authorEmail]
 *
 * YAML shape:
 *   mask:
 *     - internalNotes
 *     - authorEmail
 */

import { startEngineOnlyApp } from './_harness/engine-only-app';
import type { EngineOnlyApp } from './_harness/engine-only-app';
import { fwd, applyForwardPatches } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

describe('71 — Static boundary mask: field masking (engine-only)', () => {
  let app: EngineOnlyApp;

  beforeAll(async () => {
    app = await startEngineOnlyApp({ fixtureName: 'mask-fields' });
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  describe('Report boundary (mask: [internalNotes, authorEmail])', () => {
    it('POST /reports response omits masked fields internalNotes and authorEmail', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/reports', {
        title: 'Q1 Review',
        summary: 'Quarterly performance summary',
        internalNotes: 'confidential — do not share',
        authorEmail: 'analyst@internal.example.com',
      });

      expect(res.status).toBe(201);
      // Apply _patches to the base body (mirrors the plugin consumer contract).
      const body = applyForwardPatches(res) as JsonObject;
      expect(body).not.toHaveProperty('internalNotes');
      expect(body).not.toHaveProperty('authorEmail');
    }, 30_000);

    it('POST /reports response retains unmasked fields id, title, and summary', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/reports', {
        title: 'Annual Summary',
        summary: 'Full-year performance overview',
        internalNotes: 'internal only',
        authorEmail: 'editor@internal.example.com',
      });

      expect(res.status).toBe(201);
      // Apply _patches to the base body (mirrors the plugin consumer contract).
      const body = applyForwardPatches(res) as JsonObject;
      expect(typeof body['id']).toBe('string');
      expect((body['id'] as string).length).toBeGreaterThan(0);
      expect(body['title']).toBe('Annual Summary');
      expect(body['summary']).toBe('Full-year performance overview');
    }, 30_000);
  });

  describe('ReportById boundary (mask: [internalNotes, authorEmail])', () => {
    it('GET /reports/{id} response omits masked fields internalNotes and authorEmail', async () => {
      const createRes = await fwd(app.engineUrl, 'POST', '/reports', {
        title: 'Audit Report',
        summary: 'Annual audit findings',
        internalNotes: 'draft — not for distribution',
        authorEmail: 'auditor@internal.example.com',
      });
      expect(createRes.status).toBe(201);
      const reportId = (applyForwardPatches(createRes) as JsonObject)['id'] as string;

      const res = await fwd(app.engineUrl, 'GET', `/reports/${reportId}`);

      expect(res.status).toBe(200);
      // Apply _patches to the base body (mirrors the plugin consumer contract).
      const body = applyForwardPatches(res) as JsonObject;
      expect(body).not.toHaveProperty('internalNotes');
      expect(body).not.toHaveProperty('authorEmail');
    }, 30_000);

    it('GET /reports/{id} response retains unmasked fields id, title, and summary with correct values', async () => {
      const createRes = await fwd(app.engineUrl, 'POST', '/reports', {
        title: 'Risk Assessment',
        summary: 'Enterprise risk register',
        internalNotes: 'restricted',
        authorEmail: 'risk@internal.example.com',
      });
      expect(createRes.status).toBe(201);
      const reportId = (applyForwardPatches(createRes) as JsonObject)['id'] as string;

      const res = await fwd(app.engineUrl, 'GET', `/reports/${reportId}`);

      expect(res.status).toBe(200);
      // Apply _patches to the base body (mirrors the plugin consumer contract).
      const body = applyForwardPatches(res) as JsonObject;
      expect(body['id']).toBe(reportId);
      expect(body['title']).toBe('Risk Assessment');
      expect(body['summary']).toBe('Enterprise risk register');
    }, 30_000);
  });
});
