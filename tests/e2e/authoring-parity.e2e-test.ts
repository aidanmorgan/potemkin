/**
 * Authoring parity through the real Specmatic -> plugin -> Potemkin path.
 *
 * Every business request in this file goes to Specmatic. The engine URL is
 * used only for the admin inspection surface and transport observations.
 */

import * as http from "node:http";
import * as path from "node:path";
import { createHmac } from "node:crypto";

import { requestThroughSpecmatic } from "./_harness/crm-e2e-helpers";
import { startE2eApp, type E2eApp } from "./_harness/e2e-test-app";
import type { JsonObject } from "./_harness/crm-e2e-helpers";
const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/authoring-parity");
const WEBHOOK_PORT = 19878;
const WEBHOOK_SECRET = "parity-webhook-secret";

const MODES = [
  { name: "YAML", config: "potemkin-yaml.yml" },
  { name: "TypeScript", config: "potemkin-typescript.yml" },
  { name: "mixed YAML and TypeScript", config: "potemkin-mixed.yml" },
] as const;

interface WebhookDelivery {
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

async function waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function jsonAt<T>(url: string): Promise<T> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

describe.each(MODES)("authoring parity through Specmatic — $name", (mode) => {
  let app: E2eApp;
  let webhookServer: http.Server;
  let deliveries: WebhookDelivery[];

  beforeAll(async () => {
    deliveries = [];
    webhookServer = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        deliveries.push({ body, headers: { ...request.headers } });
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      webhookServer.listen(WEBHOOK_PORT, "127.0.0.1", () => resolve());
      webhookServer.once("error", reject);
    });
    app = await startE2eApp({
      fixtureName: "authoring-parity",
      potemkinConfigPath: path.join(FIXTURE, mode.config),
      warmupPath: "/orders/not-created",
      warmupExpectedStatus: 404,
    });
    expect(app.stubForwardingHealthy).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await app?.shutdown();
    await new Promise<void>((resolve) => webhookServer?.close(() => resolve()));
  }, 30_000);

  beforeEach(async () => {
    const reset = await fetch(`${app.engineUrl}/_admin/reset`, { method: "POST" });
    expect(reset.status).toBe(204);
    deliveries.length = 0;
    app.transportObservations.length = 0;
  });

  it("captures the final shaped response after dispatch, reaction, projection, and webhook", async () => {
    const id = `specmatic-${mode.name.toLowerCase().replaceAll(" ", "-")}`;
    const traceId = `parity-create-${mode.name}`;
    const response = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      { id, name: "Parity order", quantity: 3, internalNote: "private" },
      { "x-potemkin-trace-id": traceId },
    );

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      id,
      name: "Parity order",
      quantity: 3,
      status: "CREATED",
      _links: expect.anything(),
    });
    expect(response.body).not.toHaveProperty("internalNote");
    expect(response.headers["x-parity-fixture"]).toBe("yaml-and-typescript");
    expect(response.headers["strict-transport-security"]).toContain("max-age=31536000");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");

    const observation = await waitFor(
      () =>
        app.transportObservations.find((candidate) => candidate.correlation.traceId === traceId),
      "the final parity transport observation",
    );
    const traceObservations = app.transportObservations.filter(
      (candidate) => candidate.correlation.traceId === traceId,
    );
    expect(traceObservations).toHaveLength(1);
    expect(observation.request).toMatchObject({
      method: "POST",
      path: "/orders",
      body: { value: { id, name: "Parity order", quantity: 3, internalNote: "private" } },
    });
    expect(observation.response.status).toBe(200);
    expect(observation.response.body.value).toMatchObject({
      status: 201,
      body: expect.objectContaining({ id, name: "Parity order", status: "CREATED" }),
    });
    const observedResponse = observation.response.body.value as JsonObject;
    expect(observedResponse.body).not.toHaveProperty("internalNote");
    expect(observedResponse.body).toEqual(
      expect.objectContaining({
        _links: expect.anything(),
      }),
    );
    expect(observedResponse.headers).toEqual(
      expect.objectContaining({
        "x-parity-fixture": "yaml-and-typescript",
        "strict-transport-security": expect.stringContaining("max-age=31536000"),
        "x-content-type-options": "nosniff",
      }),
    );

    const events = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    expect(events.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "OrderCreated", aggregateId: id }),
        expect.objectContaining({ type: "ReceiptCreated", aggregateId: `${id}-receipt` }),
        expect.objectContaining({ type: "ReceiptCreated", aggregateId: `${id}-saga-receipt` }),
        expect.objectContaining({ type: "SagaCompleted" }),
        expect.objectContaining({
          type: "AuditRecorded",
          payload: expect.objectContaining({ orderId: id }),
        }),
      ]),
    );
    const state = await jsonAt<{ entities: Record<string, JsonObject> }>(
      `${app.engineUrl}/_admin/state`,
    );
    expect(state.entities[id]).toMatchObject({
      id,
      name: "Parity order",
      quantity: 3,
      internalNote: "private",
      status: "CREATED",
    });
    const projection = await jsonAt<Record<string, JsonObject>>(
      `${app.engineUrl}/_admin/derived/OrderSummary`,
    );
    expect(projection[id]).toMatchObject({ name: "Parity order", renameCount: 0 });

    const delivery = await waitFor(() => deliveries[0], "the parity webhook delivery");
    expect(JSON.parse(delivery.body)).toEqual({
      orderId: id,
      event: "OrderCreated",
      name: "Parity order",
    });
    const signature = delivery.headers["x-potemkin-signature"];
    expect(typeof signature).toBe("string");
    expect(signature).toBe(
      `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(delivery.body).digest("hex")}`,
    );
  }, 60_000);

  it("honors first-match behavior ordering through Specmatic", async () => {
    const firstId = `ordered-${mode.name.toLowerCase().replaceAll(" ", "-")}-first`;
    const first = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      { id: firstId, name: "First branch", quantity: 1, internalNote: "private" },
      { "x-parity-behavior-order": "first" },
    );
    expect(first.status).toBe(202);
    expect(first.body).toEqual(
      expect.objectContaining({ id: firstId, name: "First branch", status: "FIRST" }),
    );

    const firstEvents = await jsonAt<{ events: Array<{ aggregateId: string; type: string }> }>(
      `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(firstId)}`,
    );
    expect(firstEvents.events.map((event) => event.type)).toEqual(["OrderCreatedFirst"]);

    const fallbackId = `ordered-${mode.name.toLowerCase().replaceAll(" ", "-")}-fallback`;
    const fallback = await requestThroughSpecmatic(app.stubUrl, "POST", "/orders", {
      id: fallbackId,
      name: "Fallback branch",
      quantity: 1,
      internalNote: "private",
    });
    expect(fallback.status).toBe(201);
    expect(fallback.body).toEqual(
      expect.objectContaining({ id: fallbackId, name: "Fallback branch", status: "CREATED" }),
    );

    const fallbackEvents = await jsonAt<{ events: Array<{ aggregateId: string; type: string }> }>(
      `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(fallbackId)}`,
    );
    expect(fallbackEvents.events.map((event) => event.type)).toEqual(["OrderCreated"]);
  }, 60_000);

  it("preserves actor, caused-by, and admin-gated override metadata", async () => {
    const id = `identity-${mode.name.toLowerCase().replaceAll(" ", "-")}`;
    const causedBy = `caused-by-${mode.name}`;
    const created = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      { id, name: "Identified order", quantity: 2, internalNote: "private" },
      {
        authorization: "Bearer original-user:agent",
        "x-potemkin-include-events": "true",
        "x-potemkin-caused-by": causedBy,
      },
    );
    expect(created.status).toBe(201);
    const createdEvents = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(id)}`,
    );
    const createdEvent = createdEvents.events.find((event) => event.type === "OrderCreated")!;
    expect(createdEvent).toEqual(
      expect.objectContaining({
        causedBy,
        request: expect.objectContaining({
          actorId: "original-user",
          originalActorId: "original-user",
        }),
      }),
    );

    const unauthorizedOverride = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      { id: `${id}-unauthorized`, name: "Unauthorized", quantity: 1, internalNote: "private" },
      {
        authorization: "Bearer ordinary-user:agent",
        "x-potemkin-actor": "effective-user:agent",
      },
    );
    expect(unauthorizedOverride.status).toBe(403);

    const authorizedOverride = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      { id: `${id}-override`, name: "Overridden", quantity: 1, internalNote: "private" },
      {
        authorization: "Bearer admin-user:admin",
        "x-potemkin-actor": "effective-user:agent",
        "x-potemkin-include-events": "true",
      },
    );
    expect(authorizedOverride.status).toBe(201);
    const overriddenEvents = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(`${id}-override`)}`,
    );
    const overriddenEvent = overriddenEvents.events.find((event) => event.type === "OrderCreated")!;
    expect(overriddenEvent).toEqual(
      expect.objectContaining({
        request: expect.objectContaining({
          actorId: "effective-user",
          originalActorId: "admin-user",
        }),
      }),
    );

    const unauthorizedImpersonation = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      {
        id: `${id}-impersonation-unauthorized`,
        name: "Unauthorized impersonation",
        quantity: 1,
        internalNote: "private",
      },
      {
        authorization: "Bearer ordinary-user:agent",
        "x-potemkin-impersonate": "effective-user:agent",
      },
    );
    expect(unauthorizedImpersonation.status).toBe(403);

    const impersonated = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      { id: `${id}-impersonated`, name: "Impersonated", quantity: 1, internalNote: "private" },
      {
        authorization: "Bearer admin-user:admin",
        "x-potemkin-impersonate": "effective-user:agent",
        "x-potemkin-include-events": "true",
      },
    );
    expect(impersonated.status).toBe(201);
    const impersonatedEvents = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(`${id}-impersonated`)}`,
    );
    const impersonatedEvent = impersonatedEvents.events.find(
      (event) => event.type === "OrderCreated",
    )!;
    expect(impersonatedEvent).toEqual(
      expect.objectContaining({
        request: expect.objectContaining({
          actorId: "effective-user",
          originalActorId: "admin-user",
        }),
      }),
    );
  }, 60_000);

  it("applies each side-effect control independently through Specmatic", async () => {
    const reset = async () => {
      const response = await fetch(`${app.engineUrl}/_admin/reset`, { method: "POST" });
      expect(response.status).toBe(204);
      deliveries.length = 0;
      app.transportObservations.length = 0;
    };
    const create = async (suffix: string, headers: Record<string, string>) => {
      await reset();
      const id = `controls-${mode.name.toLowerCase().replaceAll(" ", "-")}-${suffix}`;
      const response = await requestThroughSpecmatic(
        app.stubUrl,
        "POST",
        "/orders",
        { id, name: `Control ${suffix}`, quantity: 2, internalNote: "private" },
        headers,
      );
      expect(response.status).toBe(201);
      const events = await jsonAt<{ events: readonly JsonObject[] }>(
        `${app.engineUrl}/_admin/events`,
      );
      const projection = await jsonAt<Record<string, JsonObject>>(
        `${app.engineUrl}/_admin/derived/OrderSummary`,
      );
      return { id, events: events.events, projection: projection[id] };
    };

    const skipSagas = await create("skip-sagas", { "x-potemkin-skip-sagas": "true" });
    expect(skipSagas.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "OrderCreated", aggregateId: skipSagas.id }),
        expect.objectContaining({ type: "ReceiptCreated", aggregateId: `${skipSagas.id}-receipt` }),
      ]),
    );
    expect(skipSagas.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ aggregateId: `${skipSagas.id}-saga-receipt` }),
      ]),
    );
    expect(skipSagas.projection).toMatchObject({ name: `Control skip-sagas`, renameCount: 0 });
    expect(deliveries).toHaveLength(1);

    const skipWebhooks = await create("skip-webhooks", { "x-potemkin-skip-webhooks": "true" });
    expect(skipWebhooks.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "OrderCreated", aggregateId: skipWebhooks.id }),
        expect.objectContaining({ type: "SagaCompleted" }),
      ]),
    );
    expect(skipWebhooks.projection).toMatchObject({ name: `Control skip-webhooks` });
    expect(deliveries).toHaveLength(0);

    const skipProjections = await create("skip-projections", {
      "x-potemkin-skip-projections": "true",
    });
    expect(skipProjections.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "OrderCreated", aggregateId: skipProjections.id }),
        expect.objectContaining({ type: "SagaCompleted" }),
      ]),
    );
    expect(skipProjections.projection).toBeUndefined();
    expect(deliveries).toHaveLength(1);

    const skipDispatch = await create("skip-dispatch", { "x-potemkin-skip-dispatch": "true" });
    expect(skipDispatch.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "OrderCreated", aggregateId: skipDispatch.id }),
        expect.objectContaining({
          type: "ReceiptCreated",
          aggregateId: `${skipDispatch.id}-saga-receipt`,
        }),
      ]),
    );
    expect(skipDispatch.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ aggregateId: `${skipDispatch.id}-receipt` }),
      ]),
    );
    expect(skipDispatch.projection).toMatchObject({ name: `Control skip-dispatch` });
    expect(deliveries).toHaveLength(1);
  }, 60_000);

  it("composes side-effect suppression without leaking secondary work", async () => {
    const reset = async () => {
      const response = await fetch(`${app.engineUrl}/_admin/reset`, { method: "POST" });
      expect(response.status).toBe(204);
      deliveries.length = 0;
    };
    const create = async (suffix: string, headers: Record<string, string>) => {
      await reset();
      const id = `combined-${mode.name.toLowerCase().replaceAll(" ", "-")}-${suffix}`;
      const response = await requestThroughSpecmatic(
        app.stubUrl,
        "POST",
        "/orders",
        { id, name: `Combined ${suffix}`, quantity: 2, internalNote: "private" },
        headers,
      );
      expect(response.status).toBe(201);
      const events = await jsonAt<{ events: readonly JsonObject[] }>(
        `${app.engineUrl}/_admin/events`,
      );
      const projection = await jsonAt<Record<string, JsonObject>>(
        `${app.engineUrl}/_admin/derived/OrderSummary`,
      );
      return { id, events: events.events, projection: projection[id] };
    };

    const sagaAndWebhookSuppressed = await create("saga-webhook", {
      "x-potemkin-skip-sagas": "true",
      "x-potemkin-skip-webhooks": "true",
    });
    expect(sagaAndWebhookSuppressed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "OrderCreated", aggregateId: sagaAndWebhookSuppressed.id }),
        expect.objectContaining({
          type: "ReceiptCreated",
          aggregateId: `${sagaAndWebhookSuppressed.id}-receipt`,
        }),
        expect.objectContaining({ type: "AuditRecorded" }),
      ]),
    );
    expect(sagaAndWebhookSuppressed.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ aggregateId: `${sagaAndWebhookSuppressed.id}-saga-receipt` }),
      ]),
    );
    expect(sagaAndWebhookSuppressed.projection).toMatchObject({
      name: `Combined saga-webhook`,
    });
    expect(deliveries).toHaveLength(0);

    const reactionsAndProjectionSuppressed = await create("reaction-projection", {
      "x-potemkin-skip-reactions": "true",
      "x-potemkin-skip-projections": "true",
    });
    expect(reactionsAndProjectionSuppressed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "OrderCreated" }),
        expect.objectContaining({
          type: "ReceiptCreated",
          aggregateId: `${reactionsAndProjectionSuppressed.id}-receipt`,
        }),
        expect.objectContaining({
          type: "ReceiptCreated",
          aggregateId: `${reactionsAndProjectionSuppressed.id}-saga-receipt`,
        }),
      ]),
    );
    expect(reactionsAndProjectionSuppressed.events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "AuditRecorded" })]),
    );
    expect(reactionsAndProjectionSuppressed.projection).toBeUndefined();
    expect(deliveries).toHaveLength(1);

    const everythingSuppressed = await create("all", {
      "x-potemkin-skip-sagas": "true",
      "x-potemkin-skip-webhooks": "true",
      "x-potemkin-skip-projections": "true",
      "x-potemkin-skip-reactions": "true",
      "x-potemkin-skip-dispatch": "true",
    });
    expect(everythingSuppressed.events).toEqual([
      expect.objectContaining({ type: "OrderCreated", aggregateId: everythingSuppressed.id }),
    ]);
    expect(everythingSuppressed.projection).toBeUndefined();
    expect(deliveries).toHaveLength(0);
  }, 60_000);

  it("closes the forwarded connection before any secondary side effect commits", async () => {
    const id = `drop-${mode.name.toLowerCase().replaceAll(" ", "-")}-side-effects`;
    const traceId = `drop-side-effects-${mode.name}`;
    const dropped = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      { id, name: "Dropped side effects", quantity: 2, internalNote: "private" },
      {
        "x-potemkin-trace-id": traceId,
        "x-potemkin-drop-connection": "25",
      },
    );

    expect(dropped.status).toBe(504);
    expect(dropped.headers["x-potemkin-dropped"]).toBe("true");
    expect(deliveries).toHaveLength(0);

    const events = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    expect(events.events).toHaveLength(0);
    const state = await jsonAt<{ entities: Record<string, JsonObject> }>(
      `${app.engineUrl}/_admin/state`,
    );
    expect(state.entities[id]).toBeUndefined();
    const projection = await jsonAt<Record<string, JsonObject>>(
      `${app.engineUrl}/_admin/derived/OrderSummary`,
    );
    expect(projection[id]).toBeUndefined();

    const shapedDropId = `${id}-shaped-controls`;
    const shapedDrop = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      { id: shapedDropId, name: "Dropped shaped controls", quantity: 2, internalNote: "private" },
      {
        "x-potemkin-drop-connection": "25",
        "x-potemkin-response-format": "jsonapi",
        "x-potemkin-mask": "name",
        "x-potemkin-body-truncate": "1",
      },
    );
    expect(shapedDrop.status).toBe(504);
    expect(shapedDrop.headers["x-potemkin-dropped"]).toBe("true");
    // The runtime's null synthetic body is surfaced by Specmatic as an empty
    // JSON object; response-format, masking, and truncation must not add data.
    expect(shapedDrop.body).toEqual({});
    expect(deliveries).toHaveLength(0);

    const stateAfterShapedDrop = await jsonAt<{ entities: Record<string, JsonObject> }>(
      `${app.engineUrl}/_admin/state`,
    );
    expect(stateAfterShapedDrop.entities[shapedDropId]).toBeUndefined();

    const existingId = `${id}-existing-read`;
    const existing = await requestThroughSpecmatic(app.stubUrl, "POST", "/orders", {
      id: existingId,
      name: "Existing read state",
      quantity: 1,
      internalNote: "private",
    });
    expect(existing.status).toBe(201);
    await waitFor(() => deliveries[0], "the existing order seed webhook");
    deliveries.length = 0;
    const eventsBeforeReadDrop = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    const readDropTraceId = `${traceId}-read`;
    const droppedRead = await requestThroughSpecmatic(
      app.stubUrl,
      "GET",
      `/orders/${existingId}`,
      null,
      {
        "x-potemkin-trace-id": readDropTraceId,
        "x-potemkin-drop-connection": "0",
        "x-potemkin-response-format": "jsonapi",
        "x-potemkin-mask": "name",
        "x-potemkin-body-truncate": "1",
        "x-potemkin-jitter": "0:0",
      },
    );
    expect(droppedRead.status).toBe(504);
    expect(droppedRead.headers["x-potemkin-dropped"]).toBe("true");
    expect(droppedRead.body).toBeNull();

    const eventsAfterReadDrop = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    expect(eventsAfterReadDrop.events).toEqual(eventsBeforeReadDrop.events);
    const stateAfterReadDrop = await jsonAt<{ entities: Record<string, JsonObject> }>(
      `${app.engineUrl}/_admin/state`,
    );
    expect(stateAfterReadDrop.entities[existingId]).toMatchObject({
      id: existingId,
      name: "Existing read state",
    });
    const healthyRead = await requestThroughSpecmatic(app.stubUrl, "GET", `/orders/${existingId}`);
    expect(healthyRead.status).toBe(200);
    expect(healthyRead.body).toEqual(
      expect.objectContaining({ id: existingId, name: "Existing read state" }),
    );

    const observation = await waitFor(
      () =>
        app.transportObservations.find(
          (candidate) => candidate.correlation.traceId === readDropTraceId,
        ),
      "the forwarded dropped-connection observation",
    );
    expect(observation.response.body.value).toMatchObject({
      status: 504,
      headers: { "x-potemkin-dropped": "true" },
    });

    const healthyId = `${id}-healthy`;
    const healthy = await requestThroughSpecmatic(app.stubUrl, "POST", "/orders", {
      id: healthyId,
      name: "After dropped side effects",
      quantity: 1,
      internalNote: "private",
    });
    expect(healthy.status).toBe(201);
    await waitFor(() => deliveries[0], "the healthy webhook after a dropped request");
  }, 60_000);

  it("does not persist a fresh idempotency key when drop, latency, and jitter stack", async () => {
    const suffix = mode.name.toLowerCase().replaceAll(" ", "-");
    const id = `stacked-drop-${suffix}`;
    const key = `stacked-drop-key-${mode.name}`;
    const body = { id, name: "Stacked drop", quantity: 2, internalNote: "private" };
    const dropped = await requestThroughSpecmatic(app.stubUrl, "POST", "/orders", body, {
      "idempotency-key": key,
      "x-potemkin-drop-connection": "5",
      "x-potemkin-force-latency": "2",
      "x-potemkin-slow-response": "2",
      "x-potemkin-jitter": "5:5",
      "x-potemkin-response-format": "jsonapi",
      "x-potemkin-mask": "name",
      "x-potemkin-body-truncate": "1000",
    });

    expect(dropped.status).toBe(504);
    expect(dropped.headers["x-potemkin-dropped"]).toBe("true");
    // Specmatic normalizes the transport's null synthetic body to an empty
    // JSON object for this contract's 504 response.
    expect(dropped.body).toEqual({});
    const afterDrop = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    expect(afterDrop.events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ aggregateId: id })]),
    );
    const stateAfterDrop = await jsonAt<{ entities: Record<string, JsonObject> }>(
      `${app.engineUrl}/_admin/state`,
    );
    expect(stateAfterDrop.entities[id]).toBeUndefined();

    const committed = await requestThroughSpecmatic(app.stubUrl, "POST", "/orders", body, {
      "idempotency-key": key,
    });
    expect(committed.status).toBe(201);
    expect(committed.headers["x-idempotency-replay"]).toBeUndefined();
    expect(committed.body).toEqual(expect.objectContaining({ id, status: "CREATED" }));

    const replayed = await requestThroughSpecmatic(app.stubUrl, "POST", "/orders", body, {
      "idempotency-key": key,
    });
    expect(replayed.status).toBe(201);
    expect(replayed.headers["x-idempotency-replay"]).toBe("true");
    await waitFor(() => deliveries[0], "the committed webhook after a stacked drop");

    const finalEvents = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    expect(finalEvents.events.filter((event) => event.aggregateId === id)).toHaveLength(1);
  }, 60_000);

  it("combines dry-run, event/debug transparency, and cascade limits without mutation", async () => {
    const reset = await fetch(`${app.engineUrl}/_admin/reset`, { method: "POST" });
    expect(reset.status).toBe(204);
    deliveries.length = 0;
    const dryRunId = `controls-${mode.name.toLowerCase().replaceAll(" ", "-")}-dry-run`;
    const dryRun = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      { id: dryRunId, name: "Dry run", quantity: 2, internalNote: "private" },
      {
        "x-potemkin-dry-run": "true",
        "x-potemkin-include-events": "true",
        "x-potemkin-echo": "true",
        "x-potemkin-seed": `full-controls-${mode.name}`,
        "x-potemkin-clock-offset": "3600000",
      },
    );
    expect(dryRun.status).toBe(201);
    expect(dryRun.body).toEqual(
      expect.objectContaining({ _events: expect.any(Array), _debug: expect.any(Object) }),
    );
    expect((dryRun.body as JsonObject)._debug).toEqual(
      expect.objectContaining({ dryRun: true, intent: "creation" }),
    );
    const afterDryRun = await jsonAt<{ events: readonly JsonObject[]; entities?: unknown }>(
      `${app.engineUrl}/_admin/events`,
    );
    expect(afterDryRun.events).toHaveLength(0);
    const stateAfterDryRun = await jsonAt<{ entities: Record<string, JsonObject> }>(
      `${app.engineUrl}/_admin/state`,
    );
    expect(stateAfterDryRun.entities[dryRunId]).toBeUndefined();
    expect(deliveries).toHaveLength(0);

    const limitedId = `controls-${mode.name.toLowerCase().replaceAll(" ", "-")}-depth`;
    const limited = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      { id: limitedId, name: "Cascade limited", quantity: 2, internalNote: "private" },
      { "x-potemkin-max-cascade-depth": "0" },
    );
    expect(limited.status).toBe(508);
    expect(limited.body).toEqual(expect.objectContaining({ code: "INFINITE_LOOP" }));
    const afterLimit = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    expect(afterLimit.events).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  }, 60_000);

  it("keeps declarative faults ahead of typed chaos controls and never mutates on failure", async () => {
    const reset = async () => {
      const response = await fetch(`${app.engineUrl}/_admin/reset`, { method: "POST" });
      expect(response.status).toBe(204);
      deliveries.length = 0;
    };
    const requestOrder = async (suffix: string, headers: Record<string, string>, quantity = 2) => {
      const id = `chaos-${mode.name.toLowerCase().replaceAll(" ", "-")}-${suffix}`;
      return requestThroughSpecmatic(
        app.stubUrl,
        "POST",
        "/orders",
        { id, name: `Chaos ${suffix}`, quantity, internalNote: "private" },
        headers,
      );
    };
    const expectNoEvents = async () => {
      const events = await jsonAt<{ events: readonly JsonObject[] }>(
        `${app.engineUrl}/_admin/events`,
      );
      expect(events.events).toHaveLength(0);
      expect(deliveries).toHaveLength(0);
    };

    await reset();
    const rateLimited = await requestOrder("rate-limit", { "x-potemkin-rate-limit": "true" });
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.body).toEqual(expect.objectContaining({ error: "TOO_MANY_REQUESTS" }));
    await expectNoEvents();

    await reset();
    const falseLikeRateLimit = await requestOrder("rate-limit-off", {
      "x-potemkin-rate-limit": "off",
    });
    expect(falseLikeRateLimit.status).toBe(201);
    expect(falseLikeRateLimit.body).toEqual(expect.objectContaining({ status: "CREATED" }));

    await reset();
    const reversedJitterStart = Date.now();
    const reversedJitter = await requestOrder("reversed-jitter", {
      // A reversed range is invalid and must be ignored at the Specmatic
      // forwarding boundary instead of becoming a min-clamped fixed delay.
      "x-potemkin-jitter": "3000:0",
    });
    const reversedJitterElapsed = Date.now() - reversedJitterStart;
    expect(reversedJitter.status).toBe(201);
    expect(reversedJitter.body).toEqual(expect.objectContaining({ status: "CREATED" }));
    expect(reversedJitterElapsed).toBeLessThan(2_000);

    await reset();
    const forced = await requestOrder("forced-status", { "x-potemkin-force-status": "418" });
    expect(forced.status).toBe(418);
    expect(forced.body).toEqual(expect.objectContaining({ error: "FORCED_STATUS", status: 418 }));
    await expectNoEvents();

    await reset();
    const throttled = await requestOrder("error-class", {
      "x-potemkin-error-class": "throttle",
      "x-potemkin-retry-after": "7",
    });
    expect(throttled.status).toBe(429);
    expect(throttled.headers["retry-after"]).toBe("7");
    expect(throttled.body).toEqual(
      expect.objectContaining({ error: "TOO_MANY_REQUESTS", errorClass: "throttle" }),
    );
    await expectNoEvents();

    await reset();
    const authoredFault = await requestOrder("authored-fault", {
      "x-parity-fault": "on",
      "x-potemkin-force-status": "418",
      "x-potemkin-error-class": "throttle",
    });
    expect(authoredFault.status).toBe(503);
    expect(authoredFault.headers["retry-after"]).toBe("5");
    expect(authoredFault.body).toEqual(expect.objectContaining({ error: "PARITY_FAULT" }));
    await expectNoEvents();

    await reset();
    const jitteredFaultStart = Date.now();
    const jitteredFault = await requestOrder("jittered-authored-fault", {
      "x-parity-fault": "on",
      "x-potemkin-force-status": "418",
      "x-potemkin-error-class": "throttle",
      "x-potemkin-jitter": "25:25",
    });
    expect(jitteredFault.status).toBe(503);
    expect(jitteredFault.headers["retry-after"]).toBe("5");
    expect(jitteredFault.body).toEqual(expect.objectContaining({ error: "PARITY_FAULT" }));
    // The authored fault owns the response while the fixed jitter still applies
    // to that winning response through the Specmatic forwarding path.
    expect(Date.now() - jitteredFaultStart).toBeGreaterThanOrEqual(20);
    await expectNoEvents();

    await reset();
    const singleJitterStart = Date.now();
    const singleJitterFault = await requestOrder("single-jitter-authored-fault", {
      "x-parity-fault": "on",
      "x-potemkin-force-status": "418",
      "x-potemkin-error-class": "throttle",
      "x-potemkin-force-latency": "7",
      "x-potemkin-slow-response": "5",
      "x-potemkin-jitter": "20",
    });
    expect(singleJitterFault.status).toBe(503);
    expect(singleJitterFault.headers["retry-after"]).toBe("5");
    expect(singleJitterFault.body).toEqual(expect.objectContaining({ error: "PARITY_FAULT" }));
    // A single jitter value is the supported [0,max] form and stacks with
    // the fixed transport controls on the winning authored fault.
    expect(Date.now() - singleJitterStart).toBeLessThan(2_000);
    await expectNoEvents();

    await reset();
    const namedFault = await requestOrder("named-fault", {
      "x-potemkin-use-fault": "parity-fault",
      "x-potemkin-force-status": "418",
    });
    expect(namedFault.status).toBe(503);
    expect(namedFault.headers["retry-after"]).toBe("5");
    expect(namedFault.body).toEqual(expect.objectContaining({ error: "PARITY_FAULT" }));
    await expectNoEvents();

    await reset();
    const namedPrecedenceId = `named-precedence-${mode.name.toLowerCase().replaceAll(" ", "-")}`;
    const namedPrecedenceKey = `named-precedence-${mode.name}`;
    const namedPrecedenceBody = {
      id: namedPrecedenceId,
      name: "Named precedence",
      quantity: 2,
      internalNote: "private",
    };
    const namedPrecedence = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      namedPrecedenceBody,
      {
        "idempotency-key": namedPrecedenceKey,
        "x-potemkin-use-fault": "parity-fault",
        "x-potemkin-force-status": "418",
        "x-potemkin-error-class": "throttle",
        "x-potemkin-rate-limit": "true",
        "x-potemkin-success-rate": "0",
        "x-potemkin-response-format": "jsonapi",
        "x-potemkin-mask": "field-that-is-not-present",
        "x-potemkin-body-truncate": "1000",
        "x-potemkin-force-latency": "1",
        "x-potemkin-slow-response": "1",
        "x-potemkin-jitter": "0:0",
      },
    );
    expect(namedPrecedence.status).toBe(503);
    expect(namedPrecedence.headers["retry-after"]).toBe("5");
    expect(namedPrecedence.body).toEqual(
      expect.objectContaining({
        error: "PARITY_FAULT",
        message: "deliberate parity fixture fault",
      }),
    );
    expect(namedPrecedence.body).not.toHaveProperty("data");
    expect(namedPrecedence.body).not.toHaveProperty("_links");
    await expectNoEvents();

    const committedAfterNamedFault = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      namedPrecedenceBody,
      { "idempotency-key": namedPrecedenceKey },
    );
    expect(committedAfterNamedFault.status).toBe(201);
    expect(committedAfterNamedFault.headers["x-idempotency-replay"]).toBeUndefined();
    expect(committedAfterNamedFault.body).toEqual(
      expect.objectContaining({ id: namedPrecedenceId, status: "CREATED" }),
    );

    const replayedAfterNamedFault = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      namedPrecedenceBody,
      { "idempotency-key": namedPrecedenceKey },
    );
    expect(replayedAfterNamedFault.status).toBe(201);
    expect(replayedAfterNamedFault.headers["x-idempotency-replay"]).toBe("true");

    await reset();
    const replayId = `chaos-${mode.name.toLowerCase().replaceAll(" ", "-")}-fault-replay`;
    const replayKey = `fault-replay-${mode.name}`;
    const createdBeforeFault = await requestOrder("fault-replay", {
      "idempotency-key": replayKey,
    });
    expect(createdBeforeFault.status).toBe(201);
    const eventsBeforeFault = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    expect(eventsBeforeFault.events.length).toBeGreaterThan(0);

    const faultedReplay = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      { id: replayId, name: "Chaos fault-replay", quantity: 2, internalNote: "private" },
      {
        "idempotency-key": replayKey,
        "x-parity-fault": "on",
        "x-potemkin-force-latency": "1",
        "x-potemkin-slow-response": "1",
        "x-potemkin-jitter": "0:0",
      },
    );
    expect(faultedReplay.status).toBe(503);
    expect(faultedReplay.body).toEqual(expect.objectContaining({ error: "PARITY_FAULT" }));

    const replayAfterFault = await requestOrder("fault-replay", {
      "idempotency-key": replayKey,
    });
    expect(replayAfterFault.status).toBe(201);
    expect(replayAfterFault.headers["x-idempotency-replay"]).toBe("true");
    const eventsAfterFaultReplay = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    expect(eventsAfterFaultReplay.events).toEqual(eventsBeforeFault.events);

    await reset();
    const dropReplayKey = `drop-replay-${mode.name}`;
    const createdBeforeDrop = await requestOrder("drop-replay", {
      "idempotency-key": dropReplayKey,
    });
    expect(createdBeforeDrop.status).toBe(201);
    const eventsBeforeDrop = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    const droppedReplay = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      {
        id: `chaos-${mode.name.toLowerCase().replaceAll(" ", "-")}-drop-replay`,
        name: "Chaos drop-replay",
        quantity: 2,
        internalNote: "private",
      },
      {
        "idempotency-key": dropReplayKey,
        "x-potemkin-drop-connection": "0",
      },
    );
    expect(droppedReplay.status).toBe(504);
    expect(droppedReplay.headers["x-potemkin-dropped"]).toBe("true");
    const replayAfterDrop = await requestOrder("drop-replay", {
      "idempotency-key": dropReplayKey,
    });
    expect(replayAfterDrop.status).toBe(201);
    expect(replayAfterDrop.headers["x-idempotency-replay"]).toBe("true");
    const eventsAfterDropReplay = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    expect(eventsAfterDropReplay.events).toEqual(eventsBeforeDrop.events);

    await reset();
    const ignoredDropStart = Date.now();
    const ignoredDrop = await requestOrder("over-limit-drop", {
      "x-potemkin-drop-connection": "30001",
    });
    expect(ignoredDrop.status).toBe(201);
    expect(ignoredDrop.body).toEqual(expect.objectContaining({ status: "CREATED" }));
    // The transport parser and source-neutral control policy reject values
    // beyond the documented 30-second bound instead of creating a drop.
    expect(Date.now() - ignoredDropStart).toBeLessThan(2_000);

    const negativeDrop = await requestOrder("negative-drop", {
      "x-potemkin-drop-connection": "-1",
    });
    expect(negativeDrop.status).toBe(201);
    expect(negativeDrop.body).toEqual(expect.objectContaining({ status: "CREATED" }));

    await reset();
    const signalRateLimited = await requestOrder("signal-rate-limit", {
      "x-potemkin-signal": "rate_limit",
    });
    expect(signalRateLimited.status).toBe(429);
    expect(signalRateLimited.body).toEqual(expect.objectContaining({ error: "TOO_MANY_REQUESTS" }));
    await expectNoEvents();

    await reset();
    const failedSuccessRate = await requestOrder("success-rate-failed", {
      "x-potemkin-success-rate": "0",
    });
    expect(failedSuccessRate.status).toBe(503);
    expect(failedSuccessRate.body).toEqual(expect.objectContaining({ error: "SUCCESS_RATE_GATE" }));
    await expectNoEvents();

    await reset();
    const passingSuccessRate = await requestOrder("success-rate-passed", {
      "x-potemkin-success-rate": "1",
    });
    expect(passingSuccessRate.status).toBe(201);
    expect(passingSuccessRate.body).toEqual(expect.objectContaining({ status: "CREATED" }));

    await reset();
    const probability = await requestOrder("probability", {
      "x-parity-probability": "on",
    });
    expect(probability.status).toBe(503);
    expect(probability.body).toEqual(expect.objectContaining({ error: "PROBABILITY_RESPONSE" }));
    await expectNoEvents();

    await reset();
    const probabilityOff = await requestOrder("probability-off", {
      "x-parity-probability": "off",
    });
    expect(probabilityOff.status).toBe(201);
    expect(probabilityOff.body).toEqual(expect.objectContaining({ status: "CREATED" }));

    await reset();
    const intermediateFired = await requestOrder("probability-intermediate-fired", {
      "x-parity-probability-half": "on",
      "x-potemkin-seed": "intermediate-fire",
    });
    expect(intermediateFired.status).toBe(503);
    expect(intermediateFired.body).toEqual(
      expect.objectContaining({ error: "INTERMEDIATE_PROBABILITY_RESPONSE" }),
    );
    await expectNoEvents();

    await reset();
    const intermediateSkipped = await requestOrder("probability-intermediate-skipped", {
      "x-parity-probability-half": "on",
      "x-potemkin-seed": "intermediate-skip",
    });
    expect(intermediateSkipped.status).toBe(201);
    expect(intermediateSkipped.body).toEqual(expect.objectContaining({ status: "CREATED" }));

    await reset();
    const operationMatch = await requestOrder("operation-method-match", {
      "x-parity-operation": "on",
    });
    expect(operationMatch.status).toBe(503);
    expect(operationMatch.body).toEqual(
      expect.objectContaining({ error: "OPERATION_METHOD_RESPONSE" }),
    );
    await expectNoEvents();

    const operationMismatch = await requestThroughSpecmatic(
      app.stubUrl,
      "GET",
      `/orders/operation-method-mismatch-${mode.name.toLowerCase().replaceAll(" ", "-")}`,
      null,
      { "x-parity-operation": "on" },
    );
    expect(operationMismatch.status).toBe(404);
    expect(operationMismatch.body).not.toEqual(
      expect.objectContaining({ error: "OPERATION_METHOD_RESPONSE" }),
    );

    await reset();
    const missingScope = await requestOrder("guarded-missing-scope", {
      "x-parity-guarded": "on",
      "x-parity-required": "on",
    });
    expect(missingScope.status).toBe(201);
    expect(missingScope.body).toEqual(expect.objectContaining({ status: "CREATED" }));

    await reset();
    const missingGuard = await requestOrder("guarded-missing-header", {
      authorization: "Bearer parity-user:writer",
      "x-parity-guarded": "on",
    });
    expect(missingGuard.status).toBe(201);
    expect(missingGuard.body).toEqual(expect.objectContaining({ status: "CREATED" }));

    await reset();
    const guardedScoped = await requestOrder("guarded-scoped-match", {
      authorization: "Bearer parity-user:writer",
      "x-parity-guarded": "on",
      "x-parity-required": "on",
    });
    expect(guardedScoped.status).toBe(503);
    expect(guardedScoped.body).toEqual(
      expect.objectContaining({ error: "GUARDED_SCOPED_RESPONSE" }),
    );
    await expectNoEvents();

    await reset();
    const boundaryIntentMatch = await requestOrder(
      "boundary-intent-condition-match",
      { "x-parity-boundary": "on" },
      3,
    );
    expect(boundaryIntentMatch.status).toBe(503);
    expect(boundaryIntentMatch.body).toEqual(
      expect.objectContaining({ error: "BOUNDARY_INTENT_RESPONSE" }),
    );
    await expectNoEvents();

    await reset();
    const conditionFalse = await requestOrder(
      "boundary-intent-condition-false",
      { "x-parity-boundary": "on" },
      1,
    );
    expect(conditionFalse.status).toBe(201);
    expect(conditionFalse.body).toEqual(expect.objectContaining({ status: "CREATED" }));

    await reset();
    const boundaryMismatch = await requestThroughSpecmatic(
      app.stubUrl,
      "GET",
      `/orders/boundary-intent-mismatch-${mode.name.toLowerCase().replaceAll(" ", "-")}`,
      null,
      { "x-parity-boundary": "on" },
    );
    expect(boundaryMismatch.status).toBe(404);
    expect(boundaryMismatch.body).not.toEqual(
      expect.objectContaining({ error: "BOUNDARY_INTENT_RESPONSE" }),
    );
  }, 60_000);

  it("matches YAML headers and typed selector faults before generic chaos", async () => {
    const selected = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      {
        id: `selector-${mode.name.toLowerCase().replaceAll(" ", "-")}`,
        name: "Selected maintenance",
        quantity: 2,
        internalNote: "private",
      },
      {
        "x-potemkin-force-response": "maintenance",
        "x-potemkin-force-status": "418",
        "x-potemkin-error-class": "throttle",
      },
    );
    expect(selected.status).toBe(502);
    expect(selected.body).toEqual(expect.objectContaining({ error: "MAINTENANCE_RESPONSE" }));
    await expect(
      jsonAt<{ events: readonly JsonObject[] }>(`${app.engineUrl}/_admin/events`),
    ).resolves.toEqual({ events: [] });
  }, 60_000);

  it("preserves ordered first-match and wildcard header fault semantics", async () => {
    const ordered = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      {
        id: `ordered-${mode.name.toLowerCase().replaceAll(" ", "-")}`,
        name: "Ordered fault",
        quantity: 2,
        internalNote: "private",
      },
      {
        "x-parity-order": "same",
        "x-potemkin-force-status": "418",
      },
    );
    expect(ordered.status).toBe(503);
    expect(ordered.body).toEqual(expect.objectContaining({ error: "ORDERED_FIRST" }));

    const wildcard = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      {
        id: `wildcard-${mode.name.toLowerCase().replaceAll(" ", "-")}`,
        name: "Wildcard fault",
        quantity: 2,
        internalNote: "private",
      },
      {
        "x-parity-wildcard": "arbitrary-value",
        "x-potemkin-force-status": "418",
      },
    );
    expect(wildcard.status).toBe(502);
    expect(wildcard.body).toEqual(expect.objectContaining({ error: "WILDCARD_SELECTOR" }));

    await expect(
      jsonAt<{ events: readonly JsonObject[] }>(`${app.engineUrl}/_admin/events`),
    ).resolves.toEqual({ events: [] });
  }, 60_000);

  it("keeps scenario and feature-flag selectors equivalent across authoring modes", async () => {
    const scenario = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      {
        id: `scenario-${mode.name.toLowerCase().replaceAll(" ", "-")}`,
        name: "Selected scenario",
        quantity: 2,
        internalNote: "private",
      },
      { "x-potemkin-scenario": "slow_db" },
    );
    expect(scenario.status).toBe(504);
    expect(scenario.body).toEqual(
      expect.objectContaining({
        error: "SCENARIO_RESPONSE",
        message: "selected scenario response",
      }),
    );

    const feature = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      {
        id: `feature-${mode.name.toLowerCase().replaceAll(" ", "-")}`,
        name: "Selected feature",
        quantity: 2,
        internalNote: "private",
      },
      { "x-potemkin-feature-flag": "parity-beta" },
    );
    expect(feature.status).toBe(418);
    expect(feature.body).toEqual(
      expect.objectContaining({ error: "FEATURE_RESPONSE", message: "selected feature response" }),
    );

    await expect(
      jsonAt<{ events: readonly JsonObject[] }>(`${app.engineUrl}/_admin/events`),
    ).resolves.toEqual({ events: [] });
  }, 60_000);

  it("composes scenario and feature selectors with transport controls without poisoning idempotency", async () => {
    const reset = async () => {
      const response = await fetch(`${app.engineUrl}/_admin/reset`, { method: "POST" });
      expect(response.status).toBe(204);
    };
    const order = (suffix: string) => ({
      id: `selector-combination-${mode.name.toLowerCase().replaceAll(" ", "-")}-${suffix}`,
      name: `Selector combination ${suffix}`,
      quantity: 2,
      internalNote: "private",
    });
    const noEvents = async () => {
      await expect(
        jsonAt<{ events: readonly JsonObject[] }>(`${app.engineUrl}/_admin/events`),
      ).resolves.toEqual({ events: [] });
    };

    const scenarioKey = `selector-combination-scenario-${mode.name}`;
    const scenarioFault = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      order("scenario"),
      {
        "idempotency-key": scenarioKey,
        "x-potemkin-scenario": "slow_db",
        "x-potemkin-force-status": "418",
        "x-potemkin-error-class": "throttle",
        "x-potemkin-response-format": "jsonapi",
        "x-potemkin-mask": "field-that-is-not-present",
        "x-potemkin-body-truncate": "1000",
        "x-potemkin-force-latency": "0",
        "x-potemkin-jitter": "0:0",
      },
    );
    expect(scenarioFault.status).toBe(504);
    expect(scenarioFault.body).toEqual(
      expect.objectContaining({
        error: "SCENARIO_RESPONSE",
        message: "selected scenario response",
      }),
    );
    expect(scenarioFault.body).not.toHaveProperty("data");
    expect(scenarioFault.headers["x-potemkin-response-format"]).toBeUndefined();
    await noEvents();

    const scenarioHealthy = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      order("scenario"),
      { "idempotency-key": scenarioKey },
    );
    expect(scenarioHealthy.status).toBe(201);
    expect(scenarioHealthy.body).toEqual(expect.objectContaining({ status: "CREATED" }));
    const scenarioEvents = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    expect(scenarioEvents.events.length).toBeGreaterThan(0);

    await reset();

    const featureKey = `selector-combination-feature-${mode.name}`;
    const featureFault = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      order("feature"),
      {
        "idempotency-key": featureKey,
        "x-potemkin-feature-flag": "parity-beta",
        "x-potemkin-force-status": "429",
        "x-potemkin-error-class": "conflict",
        "x-potemkin-response-format": "hal",
        "x-potemkin-mask": "field-that-is-not-present",
        "x-potemkin-body-truncate": "1000",
        "x-potemkin-force-latency": "0",
        "x-potemkin-jitter": "0:0",
      },
    );
    expect(featureFault.status).toBe(418);
    expect(featureFault.body).toEqual(
      expect.objectContaining({
        error: "FEATURE_RESPONSE",
        message: "selected feature response",
      }),
    );
    expect(featureFault.body).not.toHaveProperty("_links");
    expect(featureFault.headers["x-potemkin-response-format"]).toBeUndefined();
    await noEvents();

    const featureHealthy = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      order("feature"),
      { "idempotency-key": featureKey },
    );
    expect(featureHealthy.status).toBe(201);
    expect(featureHealthy.body).toEqual(expect.objectContaining({ status: "CREATED" }));
    const featureEvents = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    expect(featureEvents.events.length).toBeGreaterThan(0);
  }, 60_000);

  it("preserves response shaping and projection semantics on a Specmatic rename", async () => {
    const id = `rename-${mode.name.toLowerCase().replaceAll(" ", "-")}`;
    const created = await requestThroughSpecmatic(app.stubUrl, "POST", "/orders", {
      id,
      name: "Before rename",
      quantity: 2,
      internalNote: "private",
    });
    expect(created.status).toBe(201);

    const renamed = await requestThroughSpecmatic(
      app.stubUrl,
      "PATCH",
      `/orders/${id}`,
      { name: "After rename" },
      { "if-match": created.headers.etag ?? "" },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      id,
      name: "After rename",
      quantity: 2,
      status: "CREATED",
      _links: expect.anything(),
    });
    expect(renamed.body).not.toHaveProperty("internalNote");
    expect(renamed.headers.deprecation).toBe(new Date("2026-01-01T00:00:00Z").toUTCString());
    expect(renamed.headers.sunset).toBe(new Date("2027-01-01T00:00:00Z").toUTCString());
    expect(renamed.headers.link).toContain('rel="successor-version"');

    const projection = await jsonAt<Record<string, JsonObject>>(
      `${app.engineUrl}/_admin/derived/OrderSummary`,
    );
    expect(projection[id]).toMatchObject({ name: "After rename", renameCount: 1 });
    const state = await jsonAt<{ entities: Record<string, JsonObject> }>(
      `${app.engineUrl}/_admin/state`,
    );
    expect(state.entities[id]).toMatchObject({ name: "After rename", internalNote: "private" });
  }, 60_000);

  it("supports a dispatch-only behavior without mutating the primary boundary", async () => {
    const id = `dispatch-only-${mode.name.toLowerCase().replaceAll(" ", "-")}`;
    const created = await requestThroughSpecmatic(app.stubUrl, "POST", "/orders", {
      id,
      name: "Dispatch-only source",
      quantity: 2,
      internalNote: "private",
    });
    expect(created.status).toBe(201);
    const beforeEvents = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );

    const dispatched = await requestThroughSpecmatic(
      app.stubUrl,
      "PATCH",
      `/orders/${id}`,
      { name: "Must not rename" },
      {
        "if-match": created.headers.etag ?? "",
        "x-parity-dispatch-only": "on",
      },
    );
    expect(dispatched.status).toBe(200);
    expect(dispatched.body).toMatchObject({
      id,
      name: "Dispatch-only source",
      status: "CREATED",
    });

    const events = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    expect(events.events.filter((event) => event.type === "ReceiptCreated").length).toBeGreaterThan(
      beforeEvents.events.filter((event) => event.type === "ReceiptCreated").length,
    );
    expect(events.events.some((event) => event.type === "OrderRenamed")).toBe(false);

    const state = await jsonAt<{ entities: Record<string, JsonObject> }>(
      `${app.engineUrl}/_admin/state`,
    );
    expect(state.entities[id]).toMatchObject({ name: "Dispatch-only source" });
    expect(state.entities[`${id}-dispatch-only-receipt`]).toMatchObject({
      orderId: id,
      amount: 1,
    });
  }, 60_000);

  it("keeps alternate response formats and masks valid through Specmatic", async () => {
    const requestOrder = async (suffix: string, headers: Record<string, string> = {}) =>
      requestThroughSpecmatic(
        app.stubUrl,
        "POST",
        "/orders",
        {
          id: `format-${mode.name.toLowerCase().replaceAll(" ", "-")}-${suffix}`,
          name: `Format ${suffix}`,
          quantity: 2,
          internalNote: "private",
        },
        headers,
      );

    const plain = await requestOrder("plain");
    expect(plain.status).toBe(201);
    expect(plain.body).toEqual(
      expect.objectContaining({ name: "Format plain", quantity: 2, status: "CREATED" }),
    );

    const patchJournalTraceId = `patch-journal-${mode.name}`;
    const plainMasked = await requestOrder("plain-mask", {
      "x-potemkin-mask": "id,name,quantity",
      "x-potemkin-trace-id": patchJournalTraceId,
    });
    expect(plainMasked.status).toBe(201);
    expect(plainMasked.body).toEqual(
      expect.objectContaining({
        id: "[MASKED]",
        name: "[MASKED]",
        quantity: "[MASKED]",
        status: "CREATED",
        _links: expect.objectContaining({ self: { href: "/orders" } }),
      }),
    );
    expect(plainMasked.body).not.toHaveProperty("internalNote");

    const patchJournalObservation = await waitFor(
      () =>
        app.transportObservations.find(
          (candidate) => candidate.correlation.traceId === patchJournalTraceId,
        ),
      "the patched forwarded response observation",
    );
    const forwardedPatchEnvelope = patchJournalObservation.response.body.value as JsonObject;
    expect(forwardedPatchEnvelope.body).toEqual(
      expect.objectContaining({
        id: "[MASKED]",
        name: "[MASKED]",
        quantity: "[MASKED]",
        status: "CREATED",
        _links: expect.objectContaining({ self: { href: "/orders" } }),
      }),
    );
    expect(forwardedPatchEnvelope._patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: "remove", path: "/internalNote", source: "mask" }),
        expect.objectContaining({ op: "add", path: "/_links", source: "hateoas" }),
        expect.objectContaining({ op: "replace", path: "/name", source: "mask" }),
      ]),
    );
    expect(plainMasked.body).not.toHaveProperty("_patches");

    const staticMaskOverlap = await requestOrder("static-mask-overlap", {
      "x-potemkin-mask": "internalNote",
    });
    expect(staticMaskOverlap.status).toBe(201);
    expect(staticMaskOverlap.body).not.toHaveProperty("internalNote");

    const hateoasFieldMasked = await requestOrder("hateoas-field-mask", {
      "x-potemkin-mask": "href",
    });
    expect(hateoasFieldMasked.status).toBe(201);
    expect(hateoasFieldMasked.body).toEqual(
      expect.objectContaining({
        _links: { self: { href: "[MASKED]" } },
      }),
    );

    const hal = await requestOrder("hal", { "x-potemkin-response-format": "hal" });
    expect(hal.status).toBe(201);
    expect(hal.headers["x-potemkin-response-format"]).toBe("hal");
    expect(hal.body).toEqual(
      expect.objectContaining({
        name: "Format hal",
        _links: expect.objectContaining({ self: { href: "/orders" } }),
      }),
    );

    const halMasked = await requestOrder("hal-mask", {
      "x-potemkin-response-format": "hal",
      "x-potemkin-mask": "name,quantity",
    });
    expect(halMasked.status).toBe(201);
    expect(halMasked.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: "[MASKED]",
        quantity: "[MASKED]",
        _links: expect.objectContaining({ self: { href: "/orders" } }),
      }),
    );
    expect(halMasked.body).not.toHaveProperty("internalNote");

    const jsonApi = await requestOrder("jsonapi", {
      "x-potemkin-response-format": "jsonapi",
      "x-potemkin-mask": "name",
    });
    expect(jsonApi.status).toBe(201);
    expect(jsonApi.headers["x-potemkin-response-format"]).toBe("jsonapi");
    expect(jsonApi.body).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "Order",
          attributes: expect.objectContaining({
            name: "[MASKED]",
          }),
        }),
      }),
    );
    expect(
      (jsonApi.body as JsonObject).data &&
        ((jsonApi.body as JsonObject).data as JsonObject).attributes,
    ).not.toHaveProperty("internalNote");

    const state = await jsonAt<{ entities: Record<string, JsonObject> }>(
      `${app.engineUrl}/_admin/state`,
    );
    expect(
      state.entities[`format-${mode.name.toLowerCase().replaceAll(" ", "-")}-plain-mask`],
    ).toEqual(
      expect.objectContaining({
        name: "Format plain-mask",
        quantity: 2,
        internalNote: "private",
      }),
    );
  }, 60_000);

  it("preserves canonical error documents when alternate formats are requested", async () => {
    const missingHal = await requestThroughSpecmatic(
      app.stubUrl,
      "GET",
      `/orders/missing-format-${mode.name.toLowerCase().replaceAll(" ", "-")}`,
      null,
      { "x-potemkin-response-format": "hal" },
    );
    expect(missingHal.status).toBe(404);
    expect(missingHal.body).toEqual(expect.objectContaining({ code: expect.any(String) }));
    expect(missingHal.body).not.toHaveProperty("data");
    expect(missingHal.body).not.toHaveProperty("_links");
    expect(missingHal.headers["x-potemkin-response-format"]).toBeUndefined();

    const forcedJsonApi = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      {
        id: `error-format-${mode.name.toLowerCase().replaceAll(" ", "-")}`,
        name: "Error format",
        quantity: 2,
        internalNote: "private",
      },
      {
        "x-potemkin-response-format": "jsonapi",
        "x-potemkin-force-status": "418",
      },
    );
    expect(forcedJsonApi.status).toBe(418);
    expect(forcedJsonApi.body).toEqual(
      expect.objectContaining({ error: "FORCED_STATUS", status: 418 }),
    );
    expect(forcedJsonApi.body).not.toHaveProperty("data");
    expect(forcedJsonApi.body).not.toHaveProperty("_links");
    expect(forcedJsonApi.headers["x-potemkin-response-format"]).toBeUndefined();
    await expect(
      jsonAt<{ events: readonly JsonObject[] }>(`${app.engineUrl}/_admin/events`),
    ).resolves.toEqual({ events: [] });
  }, 60_000);

  it("replays the same forwarded patch journal across create, read, and update", async () => {
    const id = `patch-journal-${mode.name.toLowerCase().replaceAll(" ", "-")}-graph`;
    const patchPaths = ["/internalNote", "/_links", "/name"];
    const assertForwardedJournal = async (traceId: string, status: number) => {
      const observation = await waitFor(
        () =>
          app.transportObservations.find((candidate) => candidate.correlation.traceId === traceId),
        `the forwarded patch journal for ${traceId}`,
      );
      const envelope = observation.response.body.value as JsonObject;
      expect(envelope.status).toBe(status);
      expect(envelope._patches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ op: "remove", path: "/internalNote", source: "mask" }),
          expect.objectContaining({ op: "add", path: "/_links", source: "hateoas" }),
          expect.objectContaining({ op: "replace", path: "/name", source: "mask" }),
        ]),
      );
      expect((envelope._patches as readonly { path: string }[]).map((entry) => entry.path)).toEqual(
        expect.arrayContaining(patchPaths),
      );
      expect(envelope.body).toEqual(
        expect.objectContaining({
          id,
          name: "[MASKED]",
          _links: expect.anything(),
        }),
      );
    };

    const created = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      {
        id,
        name: "Patch journal",
        quantity: 2,
        internalNote: "private",
      },
      {
        "x-potemkin-mask": "name",
        "x-potemkin-trace-id": `${id}-create`,
      },
    );
    expect(created.status).toBe(201);
    expect(created.body).toEqual(expect.objectContaining({ id, name: "[MASKED]" }));
    await assertForwardedJournal(`${id}-create`, 201);

    const read = await requestThroughSpecmatic(app.stubUrl, "GET", `/orders/${id}`, null, {
      "x-potemkin-mask": "name",
      "x-potemkin-trace-id": `${id}-read`,
    });
    expect(read.status).toBe(200);
    expect(read.body).toEqual(expect.objectContaining({ id, name: "[MASKED]" }));
    await assertForwardedJournal(`${id}-read`, 200);

    const updated = await requestThroughSpecmatic(
      app.stubUrl,
      "PATCH",
      `/orders/${id}`,
      { name: "Updated patch journal" },
      {
        "if-match": created.headers.etag ?? "",
        "x-potemkin-mask": "name",
        "x-potemkin-trace-id": `${id}-update`,
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual(expect.objectContaining({ id, name: "[MASKED]" }));
    await assertForwardedJournal(`${id}-update`, 200);
  }, 60_000);

  it("truncates shaped, multibyte, and selected-error responses at UTF-8 boundaries", async () => {
    const id = `truncate-${mode.name.toLowerCase().replaceAll(" ", "-")}`;
    const unicodeBody = {
      id,
      name: "Format 🌊 café",
      quantity: 2,
      internalNote: "private",
    };

    // Obtain the complete JSON:API representation so the truncation limit can
    // deliberately fall in the middle of the multibyte wave character. The
    // reset makes the second request independent of this measurement request.
    const complete = await requestThroughSpecmatic(app.stubUrl, "POST", "/orders", unicodeBody, {
      "x-potemkin-response-format": "jsonapi",
    });
    expect(complete.status).toBe(201);
    const completeSerialised = JSON.stringify(complete.body);
    const waveOffset = completeSerialised.indexOf("🌊");
    expect(waveOffset).toBeGreaterThan(0);
    const waveByteOffset = Buffer.byteLength(completeSerialised.slice(0, waveOffset), "utf8");
    const truncationLimit = waveByteOffset + 1;

    const reset = await fetch(`${app.engineUrl}/_admin/reset`, { method: "POST" });
    expect(reset.status).toBe(204);
    const shaped = await requestThroughSpecmatic(app.stubUrl, "POST", "/orders", unicodeBody, {
      "x-potemkin-response-format": "jsonapi",
      "x-potemkin-body-truncate": String(truncationLimit),
    });
    expect(shaped.status).toBe(201);
    const shapedWire =
      typeof shaped.body === "string" ? shaped.body : JSON.stringify(shaped.body ?? null);
    expect(Buffer.byteLength(shapedWire, "utf8")).toBeLessThanOrEqual(truncationLimit);
    expect(shapedWire).not.toContain("\uFFFD");
    expect(shapedWire).not.toContain("🌊");

    const errorReset = await fetch(`${app.engineUrl}/_admin/reset`, { method: "POST" });
    expect(errorReset.status).toBe(204);
    const error = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      {
        ...unicodeBody,
        id: `${id}-error`,
      },
      {
        "x-potemkin-force-status": "418",
        "x-potemkin-retry-after": "9",
        "x-potemkin-body-truncate": "17",
      },
    );
    expect(error.status).toBe(418);
    expect(error.headers["retry-after"]).toBe("9");
    const errorWire =
      typeof error.body === "string" ? error.body : JSON.stringify(error.body ?? null);
    expect(Buffer.byteLength(errorWire, "utf8")).toBeLessThanOrEqual(17);
    expect(errorWire).not.toContain("\uFFFD");

    const events = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    expect(events.events).toHaveLength(0);
  }, 60_000);

  it("isolates historical reads and deterministic event replay through Specmatic", async () => {
    const id = `history-${mode.name.toLowerCase().replaceAll(" ", "-")}`;
    const created = await requestThroughSpecmatic(app.stubUrl, "POST", "/orders", {
      id,
      name: "Before history",
      quantity: 2,
      internalNote: "private",
    });
    expect(created.status).toBe(201);

    const renamed = await requestThroughSpecmatic(
      app.stubUrl,
      "PATCH",
      `/orders/${id}`,
      { name: "After history" },
      { "if-match": created.headers.etag ?? "" },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual(expect.objectContaining({ name: "After history" }));

    const historical = await requestThroughSpecmatic(app.stubUrl, "GET", `/orders/${id}`, null, {
      "x-potemkin-read-at-version": "1",
    });
    expect(historical.status).toBe(200);
    expect(historical.headers["x-potemkin-read-at-version"]).toBe("1");
    expect(historical.headers.etag).toBe('"1"');
    expect(historical.body).toEqual(
      expect.objectContaining({ id, name: "Before history", quantity: 2, status: "CREATED" }),
    );

    const eventLog = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(id)}`,
    );
    const createdEvent = eventLog.events.find((event) => event.type === "OrderCreated");
    expect(createdEvent).toEqual(expect.objectContaining({ aggregateId: id, sequenceVersion: 1 }));
    const replayed = await requestThroughSpecmatic(app.stubUrl, "GET", `/orders/${id}`, null, {
      "x-potemkin-replay-event": String(createdEvent!.eventId),
    });
    expect(replayed.status).toBe(200);
    expect(replayed.headers["x-potemkin-replayed-event"]).toBe(createdEvent!.eventId);
    expect(replayed.body).toEqual(
      expect.objectContaining({ id, name: "Before history", quantity: 2, status: "CREATED" }),
    );

    const afterReplay = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(id)}`,
    );
    expect(afterReplay.events).toHaveLength(eventLog.events.length + 1);
    expect(afterReplay.events.at(-1)).toEqual(
      expect.objectContaining({ aggregateId: id, type: "OrderCreated", sequenceVersion: 3 }),
    );

    const dryRunHistorical = await requestThroughSpecmatic(
      app.stubUrl,
      "GET",
      `/orders/${id}`,
      null,
      { "x-potemkin-read-at-version": "1", "x-potemkin-dry-run": "true" },
    );
    expect(dryRunHistorical.status).toBe(200);
    expect(dryRunHistorical.body).toEqual(
      expect.objectContaining({ id, name: "Before history", status: "CREATED" }),
    );
    expect(dryRunHistorical.headers["x-potemkin-read-at-version"]).toBe("1");

    const dryRunReplay = await requestThroughSpecmatic(app.stubUrl, "GET", `/orders/${id}`, null, {
      "x-potemkin-replay-event": String(createdEvent!.eventId),
      "x-potemkin-dry-run": "true",
    });
    expect(dryRunReplay.status).toBe(200);
    expect(dryRunReplay.headers["x-potemkin-replayed-event"]).toBe(createdEvent!.eventId);
    const afterDryRunReplay = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(id)}`,
    );
    expect(afterDryRunReplay.events).toHaveLength(afterReplay.events.length);

    const unknownReplay = await requestThroughSpecmatic(app.stubUrl, "GET", `/orders/${id}`, null, {
      "x-potemkin-replay-event": "missing-event",
    });
    expect(unknownReplay.status).toBe(404);
    expect(unknownReplay.body).toEqual(expect.objectContaining({ code: "EVENT_NOT_FOUND" }));
    const afterUnknownReplay = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(id)}`,
    );
    expect(afterUnknownReplay.events).toHaveLength(afterReplay.events.length);
  }, 60_000);

  it("isolates concurrent historical reads and replay across aggregates", async () => {
    const suffix = mode.name.toLowerCase().replaceAll(" ", "-");
    const ids = [`concurrent-history-${suffix}-one`, `concurrent-history-${suffix}-two`];
    const created = await Promise.all(
      ids.map((id, index) =>
        requestThroughSpecmatic(app.stubUrl, "POST", "/orders", {
          id,
          name: `Original ${index + 1}`,
          quantity: index + 1,
          internalNote: "private",
        }),
      ),
    );
    expect(created.map((response) => response.status)).toEqual([201, 201]);

    const renamed = await Promise.all(
      ids.map((id, index) =>
        requestThroughSpecmatic(
          app.stubUrl,
          "PATCH",
          `/orders/${id}`,
          { name: `Renamed ${index + 1}` },
          { "if-match": created[index]!.headers.etag ?? "" },
        ),
      ),
    );
    expect(renamed.map((response) => response.status)).toEqual([200, 200]);

    const eventIds = await Promise.all(
      ids.map(async (id) => {
        const response = await jsonAt<{ events: readonly JsonObject[] }>(
          `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(id)}`,
        );
        return response.events.find((event) => event.type === "OrderCreated")!.eventId as string;
      }),
    );
    const beforeReplayCounts = await Promise.all(
      ids.map(async (id) => {
        const response = await jsonAt<{ events: readonly JsonObject[] }>(
          `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(id)}`,
        );
        return response.events.length;
      }),
    );

    const historical = await Promise.all(
      ids.map((id) =>
        requestThroughSpecmatic(app.stubUrl, "GET", `/orders/${id}`, null, {
          "x-potemkin-read-at-version": "1",
        }),
      ),
    );
    expect(historical.map((response) => response.status)).toEqual([200, 200]);
    expect(historical.map((response) => (response.body as JsonObject).name)).toEqual([
      "Original 1",
      "Original 2",
    ]);
    expect(historical.map((response) => response.headers["x-potemkin-read-at-version"])).toEqual([
      "1",
      "1",
    ]);

    const afterHistoricalCounts = await Promise.all(
      ids.map(async (id) => {
        const response = await jsonAt<{ events: readonly JsonObject[] }>(
          `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(id)}`,
        );
        return response.events.length;
      }),
    );
    expect(afterHistoricalCounts).toEqual(beforeReplayCounts);

    const replayed = await Promise.all(
      ids.map((id, index) =>
        requestThroughSpecmatic(app.stubUrl, "GET", `/orders/${id}`, null, {
          "x-potemkin-replay-event": eventIds[index]!,
        }),
      ),
    );
    expect(replayed.map((response) => response.status)).toEqual([200, 200]);
    expect(replayed.map((response) => response.headers["x-potemkin-replayed-event"])).toEqual(
      eventIds,
    );
    expect(replayed.map((response) => (response.body as JsonObject).name)).toEqual([
      "Original 1",
      "Original 2",
    ]);

    const afterReplay = await Promise.all(
      ids.map(async (id) => {
        const response = await jsonAt<{ events: readonly JsonObject[] }>(
          `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(id)}`,
        );
        return response.events;
      }),
    );
    expect(afterReplay.map((events) => events.length)).toEqual(
      beforeReplayCounts.map((count) => count + 1),
    );
    expect(afterReplay.flat().filter((event) => event.type === "OrderCreated")).toHaveLength(4);
  }, 60_000);

  it("returns the declared fault through Specmatic without committing events", async () => {
    const traceId = `parity-fault-${mode.name}`;
    const response = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      {
        id: `fault-${mode.name.toLowerCase().replaceAll(" ", "-")}`,
        name: "Faulted",
        quantity: 1,
        internalNote: "private",
      },
      { "x-potemkin-trace-id": traceId, "x-parity-fault": "on" },
    );

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: "PARITY_FAULT" });
    const observation = await waitFor(
      () =>
        app.transportObservations.find((candidate) => candidate.correlation.traceId === traceId),
      "the parity fault observation",
    );
    expect(observation.response.body.value).toMatchObject({
      status: 503,
      body: { error: "PARITY_FAULT" },
    });
    const events = await jsonAt<{ events: readonly JsonObject[] }>(
      `${app.engineUrl}/_admin/events`,
    );
    expect(events.events).toHaveLength(0);
  }, 60_000);

  it("replays idempotent requests and rejects a changed body consistently", async () => {
    const id = `idempotent-${mode.name.toLowerCase().replaceAll(" ", "-")}`;
    const key = `idempotency-${mode.name}`;
    const body = { id, name: "Stable", quantity: 4, internalNote: "private" };
    const first = await requestThroughSpecmatic(app.stubUrl, "POST", "/orders", body, {
      "idempotency-key": key,
    });
    const replay = await requestThroughSpecmatic(app.stubUrl, "POST", "/orders", body, {
      "idempotency-key": key,
    });
    const conflict = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      { ...body, name: "Changed" },
      { "idempotency-key": key },
    );

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers["x-idempotency-replay"]).toBe("true");
    expect(conflict.status).toBe(409);
  }, 60_000);

  it("expires idempotency entries from the virtual clock through Specmatic", async () => {
    const key = `expiring-idempotency-${mode.name}`;
    const first = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      {
        id: `expiring-${mode.name.toLowerCase().replaceAll(" ", "-")}-one`,
        name: "Before expiry",
        quantity: 1,
        internalNote: "private",
      },
      { "idempotency-key": key },
    );
    const replay = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      {
        id: `expiring-${mode.name.toLowerCase().replaceAll(" ", "-")}-one`,
        name: "Before expiry",
        quantity: 1,
        internalNote: "private",
      },
      { "idempotency-key": key },
    );

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers["x-idempotency-replay"]).toBe("true");

    const clock = await fetch(`${app.engineUrl}/_admin/clock/advance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ms: 60_001 }),
    });
    expect(clock.status).toBe(200);

    const fresh = await requestThroughSpecmatic(
      app.stubUrl,
      "POST",
      "/orders",
      {
        id: `expiring-${mode.name.toLowerCase().replaceAll(" ", "-")}-two`,
        name: "After expiry",
        quantity: 1,
        internalNote: "private",
      },
      { "idempotency-key": key },
    );
    expect(fresh.status).toBe(201);
    expect(fresh.headers["x-idempotency-replay"]).toBeUndefined();
    expect(fresh.body).toEqual(expect.objectContaining({ name: "After expiry" }));

    const clockReset = await fetch(`${app.engineUrl}/_admin/clock/reset`, { method: "POST" });
    expect(clockReset.status).toBe(200);
    await expect(clockReset.json()).resolves.toEqual({ offsetMs: 0 });
  }, 60_000);

  it("keeps concurrent request-local TTL decisions isolated through Specmatic", async () => {
    const suffix = mode.name.toLowerCase().replaceAll(" ", "-");
    const requests = [
      {
        id: `ttl-isolation-${suffix}-ahead`,
        key: `ttl-isolation-${suffix}-ahead-key`,
        offset: "61000",
      },
      {
        id: `ttl-isolation-${suffix}-behind`,
        key: `ttl-isolation-${suffix}-behind-key`,
        offset: "-61000",
      },
    ];
    const created = await Promise.all(
      requests.map(({ id, key }) =>
        requestThroughSpecmatic(
          app.stubUrl,
          "POST",
          "/orders",
          { id, name: "TTL isolation", quantity: 1, internalNote: "private" },
          { "idempotency-key": key },
        ),
      ),
    );
    expect(created.map((response) => response.status)).toEqual([201, 201]);

    const concurrentReads = await Promise.all(
      requests.map(({ id, key, offset }) =>
        requestThroughSpecmatic(
          app.stubUrl,
          "POST",
          "/orders",
          { id, name: "TTL isolation", quantity: 1, internalNote: "private" },
          {
            "idempotency-key": key,
            "x-potemkin-clock-offset": offset,
          },
        ),
      ),
    );
    expect(concurrentReads[0]!.status).toBe(409);
    expect(concurrentReads[1]!.status).toBe(201);
    expect(concurrentReads[1]!.headers["x-idempotency-replay"]).toBe("true");

    const eventCounts = await Promise.all(
      requests.map(async ({ id }) => {
        const events = await jsonAt<{ events: readonly JsonObject[] }>(
          `${app.engineUrl}/_admin/events?aggregateId=${encodeURIComponent(id)}`,
        );
        return events.events.length;
      }),
    );
    expect(eventCounts).toEqual([1, 1]);
  }, 60_000);
});
