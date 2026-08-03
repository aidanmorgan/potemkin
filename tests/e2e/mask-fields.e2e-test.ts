/**
 * Static boundary mask: field masking (Specmatic-backed).
 *
 * Demonstrates `mask: [internalNotes, authorEmail]` declared in a boundary
 * DSL file. Fields listed in `mask:` are persisted in aggregate state but
 * removed from the response body before it is served  callers never see them.
 *
 * The assertions below use the body returned by the running Specmatic stub,
 * proving that masking is applied on the public client-visible response.
 *
 * Fixture: tests/fixtures/mask-fields/
 *   Report boundary (/reports)           mask: [internalNotes, authorEmail]
 *   ReportById boundary (/reports/{id})  mask: [internalNotes, authorEmail]
 *
 * YAML shape:
 *   mask:
 *     - internalNotes
 *     - authorEmail
 */

import { startE2eApp, type E2eApp } from "./_harness/e2e-test-app";
import { requestThroughSpecmatic } from "./_harness/crm-e2e-helpers";
import type { JsonObject } from "./_harness/crm-e2e-helpers";

describe("Static boundary mask: field masking (Specmatic-backed)", () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({ fixtureName: "mask-fields" });
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  describe("Report boundary (mask: [internalNotes, authorEmail])", () => {
    it("POST /reports response omits masked fields internalNotes and authorEmail", async () => {
      const res = await requestThroughSpecmatic(app.stubUrl, "POST", "/reports", {
        title: "Q1 Review",
        summary: "Quarterly performance summary",
        internalNotes: "confidential  do not share",
        authorEmail: "analyst@internal.example.com",
      });

      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      expect(body).not.toHaveProperty("internalNotes");
      expect(body).not.toHaveProperty("authorEmail");
    }, 30_000);

    it("POST /reports response retains unmasked fields id, title, and summary", async () => {
      const res = await requestThroughSpecmatic(app.stubUrl, "POST", "/reports", {
        title: "Annual Summary",
        summary: "Full-year performance overview",
        internalNotes: "internal only",
        authorEmail: "editor@internal.example.com",
      });

      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      expect(typeof body["id"]).toBe("string");
      expect((body["id"] as string).length).toBeGreaterThan(0);
      expect(body["title"]).toBe("Annual Summary");
      expect(body["summary"]).toBe("Full-year performance overview");
    }, 30_000);
  });

  describe("ReportById boundary (mask: [internalNotes, authorEmail])", () => {
    it("GET /reports/{id} response omits masked fields internalNotes and authorEmail", async () => {
      const createRes = await requestThroughSpecmatic(app.stubUrl, "POST", "/reports", {
        title: "Audit Report",
        summary: "Annual audit findings",
        internalNotes: "draft  not for distribution",
        authorEmail: "auditor@internal.example.com",
      });
      expect(createRes.status).toBe(201);
      const reportId = (createRes.body as JsonObject)["id"] as string;

      const res = await requestThroughSpecmatic(app.stubUrl, "GET", `/reports/${reportId}`);

      expect(res.status).toBe(200);
      const body = res.body as JsonObject;
      expect(body).not.toHaveProperty("internalNotes");
      expect(body).not.toHaveProperty("authorEmail");
    }, 30_000);

    it("GET /reports/{id} response retains unmasked fields id, title, and summary with correct values", async () => {
      const createRes = await requestThroughSpecmatic(app.stubUrl, "POST", "/reports", {
        title: "Risk Assessment",
        summary: "Enterprise risk register",
        internalNotes: "restricted",
        authorEmail: "risk@internal.example.com",
      });
      expect(createRes.status).toBe(201);
      const reportId = (createRes.body as JsonObject)["id"] as string;

      const res = await requestThroughSpecmatic(app.stubUrl, "GET", `/reports/${reportId}`);

      expect(res.status).toBe(200);
      const body = res.body as JsonObject;
      expect(body["id"]).toBe(reportId);
      expect(body["title"]).toBe("Risk Assessment");
      expect(body["summary"]).toBe("Enterprise risk register");
    }, 30_000);
  });
});
