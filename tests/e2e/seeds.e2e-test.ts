/**
 * use:-mapped boundaries through the real Specmatic stack.
 *
 * The lower-level seed compiler checks live in tests/runtime/seed-compilation.runtime.test.ts.
 * This suite proves the mapped Widget and Gadget boundaries through Specmatic, the Kotlin
 * plugin, and the Node engine, including child-route forwarding for PATCH.
 */

import { startE2eApp, type E2eApp } from "./_harness/e2e-test-app";
import { requestThroughSpecmatic, getAllEvents } from "./_harness/crm-e2e-helpers";
import type { JsonObject } from "./_harness/crm-e2e-helpers";

describe("use:-mapped boundaries are live through Specmatic", () => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({ fixtureName: "seeds-engine" });
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it("Widget boundary (/widgets) is reachable  POST creates a widget with kind WIDGET", async () => {
    const res = await requestThroughSpecmatic(app.stubUrl, "POST", "/widgets", {
      label: "alpha-widget",
    });

    expect([200, 201]).toContain(res.status);
    const body = res.body as JsonObject;
    expect(typeof body["id"]).toBe("string");
    expect((body["id"] as string).length).toBeGreaterThan(0);
    expect(body["kind"]).toBe("WIDGET");
    expect(body["label"]).toBe("alpha-widget");
  }, 30_000);

  it("Gadget boundary (/gadgets) is reachable  POST creates a gadget with kind GADGET", async () => {
    const res = await requestThroughSpecmatic(app.stubUrl, "POST", "/gadgets", {
      label: "beta-gadget",
    });

    expect([200, 201]).toContain(res.status);
    const body = res.body as JsonObject;
    expect(typeof body["id"]).toBe("string");
    expect((body["id"] as string).length).toBeGreaterThan(0);
    expect(body["kind"]).toBe("GADGET");
    expect(body["label"]).toBe("beta-gadget");
  }, 30_000);

  it("Widget and Gadget instances are independent  mutating one does not change the other", async () => {
    const wRes = await requestThroughSpecmatic(app.stubUrl, "POST", "/widgets", {
      label: "independence-widget",
    });
    expect([200, 201]).toContain(wRes.status);
    const widgetId = (wRes.body as JsonObject)["id"] as string;

    const gRes = await requestThroughSpecmatic(app.stubUrl, "POST", "/gadgets", {
      label: "independence-gadget",
    });
    expect([200, 201]).toContain(gRes.status);
    const gadgetId = (gRes.body as JsonObject)["id"] as string;

    const patchRes = await requestThroughSpecmatic(app.stubUrl, "PATCH", `/widgets/${widgetId}`, {
      label: "updated-widget",
    });
    expect(patchRes.status).toBe(200);

    const events = await getAllEvents(app.engineUrl);
    const widgetCreated = events.find(
      (e) => e.type === "ItemCreated" && e.aggregateId === widgetId,
    );
    const gadgetCreated = events.find(
      (e) => e.type === "ItemCreated" && e.aggregateId === gadgetId,
    );
    const widgetUpdated = events.find(
      (e) => e.type === "ItemUpdated" && e.aggregateId === widgetId,
    );
    const gadgetUpdated = events.find(
      (e) => e.type === "ItemUpdated" && e.aggregateId === gadgetId,
    );

    expect(widgetCreated).toBeDefined();
    expect(gadgetCreated).toBeDefined();
    expect(widgetUpdated).toBeDefined();
    expect(gadgetUpdated).toBeUndefined();
  }, 30_000);

  it("component definition (ItemEntity) does not appear as a live boundary  only mapped names do", async () => {
    const wRes = await requestThroughSpecmatic(app.stubUrl, "POST", "/widgets", {
      label: "boundary-check",
    });
    expect([200, 201]).toContain(wRes.status);
    const gRes = await requestThroughSpecmatic(app.stubUrl, "POST", "/gadgets", {
      label: "boundary-check",
    });
    expect([200, 201]).toContain(gRes.status);

    const events = await getAllEvents(app.engineUrl);
    const boundaries = new Set(events.map((e) => e.boundary));

    expect(boundaries.has("Widget")).toBe(true);
    expect(boundaries.has("Gadget")).toBe(true);
    expect(boundaries.has("ItemEntity")).toBe(false);
  }, 30_000);
});
