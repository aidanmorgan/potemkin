import { startE2eApp, type E2eApp } from "./_harness/e2e-test-app";
import { requestThroughSpecmatic, getEventsByAggregate } from "./_harness/crm-e2e-helpers.js";
import type { JsonObject } from "./_harness/crm-e2e-helpers.js";

describe("canonical behavior header matching", () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({ fixtureName: "header-match" });
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it("selects the first matching behavior and falls back by exact header value", async () => {
    const mobile = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      { productId: "SKU-1", quantity: 1 },
      { "x-channel": "mobile" },
    );
    expect(mobile.status).toBe(201);
    expect((mobile.body as JsonObject).channel).toBe("mobile");
    expect(
      (await getEventsByAggregate(app.engineUrl, String((mobile.body as JsonObject).id)))[0]?.type,
    ).toBe("MobileOrderPlaced");

    const defaulted = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      { productId: "SKU-2", quantity: 1 },
      { "x-channel": "MOBILE" },
    );
    expect(defaulted.status).toBe(201);
    expect((defaulted.body as JsonObject).channel).toBe("standard");
    expect(
      (await getEventsByAggregate(app.engineUrl, String((defaulted.body as JsonObject).id)))[0]
        ?.type,
    ).toBe("OrderPlaced");
  });
});
