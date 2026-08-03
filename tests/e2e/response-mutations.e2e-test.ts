/**
 * Response mutations reach the Specmatic-served response.
 *
 * Boots the `governance` fixture (Document boundary declares static hateoas:,
 * mask:, and deprecated: blocks; the OpenAPI permits _links and makes
 * internalNotes optional so the mutated body still validates against the
 * contract). Proves through the Specmatic stub URL that:
 *   - HATEOAS _links.self is injected into the served body;
 *   - the masked field (internalNotes) is REMOVED from the served body;
 *   - Deprecation + Sunset + successor-version Link headers are set on the
 *     deprecated getDocument response.
 */

import { startE2eApp } from "./_harness/e2e-test-app";
import type { E2eApp } from "./_harness/e2e-test-app";

interface DocLinks {
  self?: { href: string };
}
interface DocumentState {
  id: string;
  title: string;
  status?: string;
  internalNotes?: string;
  _links?: DocLinks;
}

// Served-response tests target the Specmatic stub UNCONDITIONALLY  this suite
// proves the mutations reach the Specmatic-served response, so beforeAll
// asserts stub→plugin→engine forwarding is healthy.
function target(app: E2eApp): string {
  return app.stubUrl;
}

async function createDocViaStub(base: string, title: string): Promise<string> {
  const res = await fetch(`${base}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, internalNotes: "classified" }),
  });
  expect([200, 201]).toContain(res.status);
  const body = (await res.json()) as DocumentState;
  expect(body.id).toBeTruthy();
  return body.id;
}

describe("response mutations via Specmatic", () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({ fixtureName: "governance" });
    // Fail fast: this suite proves stub→plugin→engine forwarding.
    expect(app.stubForwardingHealthy).toBe(true);
  }, 120_000);
  afterAll(async () => {
    if (app) await app.shutdown();
  }, 30_000);

  describe("Specmatic-served response carries the mutations", () => {
    it("POST /documents: _links.self is injected and internalNotes is masked away", async () => {
      const res = await fetch(`${target(app)}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Quarterly Report", internalNotes: "eyes only" }),
      });
      expect([200, 201]).toContain(res.status);
      const body = (await res.json()) as DocumentState;

      // HATEOAS self link present in the served body.
      expect(body._links?.self?.href).toBe("/documents");
      // The masked field has been REMOVED from the served body.
      expect(body.internalNotes).toBeUndefined();
      expect(body.title).toBe("Quarterly Report");
    }, 60_000);

    it("GET /documents/{id}: mask + HATEOAS apply and Deprecation/Sunset/Link headers are set", async () => {
      const id = await createDocViaStub(target(app), "Doc With Headers");

      const res = await fetch(`${target(app)}/documents/${id}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      expect(res.status).toBe(200);

      // Deprecation headers on the served response. The Sunset value is asserted
      // by instant, not exact string: through the Specmatic stub the value is
      // re-serialised to an RFC 8594 HTTP-date ("Fri, 01 Jan 2027 00:00:00 GMT"),
      // whereas the raw engine path emits the ISO config value  both denote the
      // same moment.
      expect(res.headers.get("deprecation")).toBe("true");
      const sunset = res.headers.get("sunset");
      expect(sunset).toBeTruthy();
      expect(new Date(sunset as string).toISOString()).toBe("2027-01-01T00:00:00.000Z");
      const link = res.headers.get("link");
      expect(link).toContain("/v2/documents");
      expect(link).toContain('rel="successor-version"');

      const body = (await res.json()) as DocumentState;
      expect(body._links?.self?.href).toBe("/documents");
      expect(body.internalNotes).toBeUndefined();
    }, 60_000);
  });
});
