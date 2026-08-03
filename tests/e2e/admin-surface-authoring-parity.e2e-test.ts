/**
 * The new runtime administrative surface through all three authoring modes.
 *
 * Business mutations go through Specmatic. The Potemkin URL is used only for
 * reset, diagnostics, and administrative lifecycle operations.
 */

import * as path from "node:path";

import { requestThroughSpecmatic } from "./_harness/crm-e2e-helpers";
import { startE2eApp, type E2eApp } from "./_harness/e2e-test-app";
import { startCliServer } from "./_harness/server-driver";
const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/authoring-parity");

const MODES = [
  { name: "YAML", config: "potemkin-yaml.yml" },
  { name: "TypeScript", config: "potemkin-typescript.yml" },
  { name: "mixed YAML and TypeScript", config: "potemkin-mixed.yml" },
] as const;

interface JsonResult {
  readonly status: number;
  readonly body: unknown;
}

async function readResult(response: Response): Promise<JsonResult> {
  const text = await response.text();
  if (text === "") return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, body: text };
  }
}

async function admin(app: E2eApp, requestPath: string, init?: RequestInit): Promise<JsonResult> {
  return readResult(await fetch(`${app.engineUrl}${requestPath}`, init));
}

describe.each(MODES)("new runtime admin surface — $name", (mode) => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: "authoring-parity",
      potemkinConfigPath: path.join(FIXTURE, mode.config),
      warmupPath: "/orders/not-created",
      warmupExpectedStatus: 404,
    });
  }, 180_000);

  afterAll(async () => {
    await app?.shutdown();
  }, 30_000);

  beforeEach(async () => {
    const reset = await admin(app, "/_admin/reset", { method: "POST" });
    expect(reset.status).toBe(204);
  });

  it("keeps health, state, event, projection, model, and reset views coherent", async () => {
    const baselineHealth = await admin(app, "/_admin/health");
    expect(baselineHealth).toEqual({
      status: 200,
      body: expect.objectContaining({ status: "ok", ready: true, entityCount: 0, eventCount: 0 }),
    });
    const baselineState = await admin(app, "/_admin/state");
    const baselineEvents = await admin(app, "/_admin/events");
    const baselineProjection = await admin(app, "/_admin/derived/OrderSummary");

    const id = `admin-surface-${mode.name.toLowerCase().replaceAll(" ", "-")}`;
    const created = await requestThroughSpecmatic(app.stubUrl, "POST", "/orders", {
      id,
      name: "Admin surface order",
      quantity: 2,
      internalNote: "raw-only",
    });
    expect(created.status).toBe(201);

    const health = await admin(app, "/_admin/health");
    expect(health).toEqual({
      status: 200,
      body: expect.objectContaining({ status: "ok", ready: true, entityCount: 4, eventCount: 7 }),
    });

    const state = await admin(app, "/_admin/state");
    expect(state).toEqual({
      status: 200,
      body: expect.objectContaining({
        entities: expect.objectContaining({
          [id]: expect.objectContaining({
            id,
            name: "Admin surface order",
            internalNote: "raw-only",
          }),
        }),
      }),
    });
    const scopedState = await admin(app, "/_admin/state?boundary=Order");
    expect(scopedState).toEqual({
      status: 200,
      body: { entities: { [id]: expect.objectContaining({ id }) } },
    });
    const unknownState = await admin(app, "/_admin/state?boundary=MissingBoundary");
    expect(unknownState).toEqual({
      status: 404,
      body: { code: "BOUNDARY_NOT_FOUND", message: "Unknown boundary 'MissingBoundary'" },
    });

    const allEvents = await admin(app, "/_admin/events");
    expect(allEvents).toEqual({
      status: 200,
      body: { events: expect.arrayContaining([expect.any(Object)]) },
    });
    const aggregateEvents = await admin(
      app,
      `/_admin/events?aggregateId=${encodeURIComponent(id)}`,
    );
    expect(aggregateEvents).toEqual({
      status: 200,
      body: { events: [expect.objectContaining({ aggregateId: id, type: "OrderCreated" })] },
    });
    const typedEvents = await admin(app, "/_admin/events?type=OrderCreated");
    expect(typedEvents).toEqual({
      status: 200,
      body: { events: [expect.objectContaining({ aggregateId: id, type: "OrderCreated" })] },
    });
    expect(await admin(app, "/_admin/events?count=true")).toEqual({
      status: 200,
      body: { count: 7 },
    });
    const firstPage = await admin(app, "/_admin/events?offset=0&limit=2");
    const secondPage = await admin(app, "/_admin/events?offset=2&limit=2");
    expect(firstPage.status).toBe(200);
    expect(secondPage.status).toBe(200);
    expect((firstPage.body as { events: unknown[] }).events).toHaveLength(2);
    expect((secondPage.body as { events: unknown[] }).events).toHaveLength(2);
    expect(await admin(app, "/_admin/events?offset=999&limit=2")).toEqual({
      status: 200,
      body: { events: [] },
    });

    const projection = await admin(app, "/_admin/derived/OrderSummary");
    expect(projection).toEqual({
      status: 200,
      body: { [id]: expect.objectContaining({ name: "Admin surface order", renameCount: 0 }) },
    });
    expect(await admin(app, "/_admin/derived/MissingProjection")).toEqual({
      status: 404,
      body: { error: "NOT_FOUND", message: 'No derived projection named "MissingProjection"' },
    });
    const model = await admin(app, "/_admin/model");
    expect(model).toEqual({
      status: 200,
      body: expect.objectContaining({ schemaVersion: 1, machines: expect.any(Array) }),
    });

    expect(await admin(app, "/_admin/reset", { method: "POST" })).toEqual({
      status: 204,
      body: null,
    });
    expect(await admin(app, "/_admin/health")).toEqual({
      status: 200,
      body: expect.objectContaining({ entityCount: 0, eventCount: 0 }),
    });
    expect(await admin(app, "/_admin/state")).toEqual(baselineState);
    expect(await admin(app, "/_admin/events")).toEqual(baselineEvents);
    expect(await admin(app, "/_admin/derived/OrderSummary")).toEqual(baselineProjection);
  }, 60_000);

  it("requires the configured bearer token for every administrative route", async () => {
    const server = await startCliServer({
      configPath: path.join(FIXTURE, mode.config),
      adminToken: "admin-surface-token",
    });
    const routes: readonly [string, RequestInit?][] = [
      ["/_admin/health"],
      ["/_admin/state"],
      ["/_admin/events"],
      ["/_admin/faults"],
      ["/_admin/derived/OrderSummary"],
      ["/_admin/model"],
      ["/_admin/reset", { method: "POST" }],
      ["/_admin/force-reload", { method: "POST" }],
      ["/_admin/clock/reset", { method: "POST" }],
      [
        "/_admin/clock/advance",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ms: 0 }),
        },
      ],
      [
        "/_admin/faults",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "admin-surface-fault",
            match: { operationId: "createOrder" },
            response: { status: 503, body: { code: "ADMIN_SURFACE_FAULT" } },
          }),
        },
      ],
    ];
    try {
      for (const [requestPath, init] of routes) {
        expect((await readResult(await fetch(`${server.url}${requestPath}`, init))).status).toBe(
          401,
        );
        expect(
          (
            await readResult(
              await fetch(`${server.url}${requestPath}`, {
                ...init,
                headers: { ...init?.headers, authorization: "Bearer wrong-token" },
              }),
            )
          ).status,
        ).toBe(401);
      }

      const authorized = { authorization: "Bearer admin-surface-token" };
      expect(
        (await readResult(await fetch(`${server.url}/_admin/health`, { headers: authorized })))
          .status,
      ).toBe(200);
      expect(
        (await readResult(await fetch(`${server.url}/_admin/state`, { headers: authorized })))
          .status,
      ).toBe(200);
      expect(
        (await readResult(await fetch(`${server.url}/_admin/events`, { headers: authorized })))
          .status,
      ).toBe(200);
      expect(
        (await readResult(await fetch(`${server.url}/_admin/faults`, { headers: authorized })))
          .status,
      ).toBe(200);
      expect(
        (
          await readResult(
            await fetch(`${server.url}/_admin/derived/OrderSummary`, { headers: authorized }),
          )
        ).status,
      ).toBe(200);
      expect(
        (await readResult(await fetch(`${server.url}/_admin/model`, { headers: authorized })))
          .status,
      ).toBe(200);
      expect(
        (
          await readResult(
            await fetch(`${server.url}/_admin/reset`, { method: "POST", headers: authorized }),
          )
        ).status,
      ).toBe(204);
      expect(
        (
          await readResult(
            await fetch(`${server.url}/_admin/force-reload`, {
              method: "POST",
              headers: authorized,
            }),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await readResult(
            await fetch(`${server.url}/_admin/clock/reset`, {
              method: "POST",
              headers: authorized,
            }),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await readResult(
            await fetch(`${server.url}/_admin/clock/advance`, {
              method: "POST",
              headers: { ...authorized, "content-type": "application/json" },
              body: JSON.stringify({ ms: 0 }),
            }),
          )
        ).status,
      ).toBe(200);
      const fault = await readResult(
        await fetch(`${server.url}/_admin/faults`, {
          method: "POST",
          headers: { ...authorized, "content-type": "application/json" },
          body: JSON.stringify({
            name: "admin-surface-fault",
            match: { operationId: "createOrder" },
            response: { status: 503, body: { code: "ADMIN_SURFACE_FAULT" } },
          }),
        }),
      );
      expect(fault.status).toBe(201);
      const faultId = (fault.body as { id: string }).id;
      expect(
        (
          await readResult(
            await fetch(`${server.url}/_admin/faults/${encodeURIComponent(faultId)}`, {
              method: "DELETE",
              headers: authorized,
            }),
          )
        ).status,
      ).toBe(204);
    } finally {
      await server.stop();
    }
  }, 60_000);
});
