import { startE2eApp, type E2eApp } from "./_harness/e2e-test-app";

describe("canonical runtime security headers", () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({ fixtureName: "crm-versioned" });
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it.each(["/leads", "/_admin/health"])(
    "%s applies the configured headers to success responses",
    async (path) => {
      const base = path.startsWith("/_admin/") ? app.engineUrl : app.stubUrl;
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(response.headers.get("x-custom-sim-header")).toBe("potemkin-sim");
    },
  );

  it("applies the same headers to a contract and runtime error", async () => {
    const response = await fetch(`${app.stubUrl}/leads/00000000-dead-7000-8000-000000000000`);
    expect(response.status).toBe(404);
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-custom-sim-header")).toBe("potemkin-sim");
  });
});
