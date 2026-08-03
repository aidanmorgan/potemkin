import {
  createRealApiEndpoint,
  createRealApiEquivalenceRunner,
  formatDivergenceReport,
  normalizeHeaders,
  normalizeHttpObservation,
  type EquivalenceEndpoint,
  type HttpFetchResponse,
} from "../../equivalence/realApi.js";
import type { EquivalenceObservation, EquivalenceRequest } from "../../equivalence/types.js";

function response(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): HttpFetchResponse {
  return { status, headers, text: async () => body };
}

function staticEndpoint(observations: readonly EquivalenceObservation[]): EquivalenceEndpoint {
  return {
    execute: async (_request, context) => observations[context.index],
  };
}

describe("real API equivalence endpoint", () => {
  it("builds deterministic HTTP requests and normalizes headers and JSON bodies", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const endpoint = createRealApiEndpoint({
      baseUrl: "https://service.test/api",
      headers: { Authorization: "Bearer test", "X-Default": "yes" },
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response(201, '{"id":"real-1"}', {
          "Content-Type": "application/json",
          ETag: "v1",
        });
      },
    });

    const result = await endpoint.execute(
      {
        method: "post",
        path: "/orders",
        body: { name: "Ada" },
        headers: { "X-Request": "one" },
      },
      { index: 0, operation: "create-order" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://service.test/api/orders");
    expect(calls[0].init).toMatchObject({
      method: "POST",
      body: '{"name":"Ada"}',
      headers: {
        Authorization: "Bearer test",
        "X-Default": "yes",
        "X-Request": "one",
        "content-type": "application/json",
      },
    });
    expect(result).toEqual({
      status: 201,
      headers: { "content-type": "application/json", etag: "v1" },
      body: { id: "real-1" },
    });
  });

  it("supports quiescence and event collection after each response", async () => {
    const order: string[] = [];
    const endpoint = createRealApiEndpoint({
      fetch: async () => {
        order.push("fetch");
        return response(200, "{}");
      },
      quiesce: async ({ operation }) => {
        order.push(`quiesce:${operation}`);
      },
      eventSource: async ({ operation }) => {
        order.push(`events:${operation}`);
        return [{ id: "real-event-1", type: "OrderCreated" }];
      },
    });

    const result = await endpoint.execute(
      { method: "GET", path: "/orders/real-1", operation: "read-order" },
      { index: 2, operation: "read-order" },
    );

    expect(order).toEqual(["fetch", "quiesce:read-order", "events:read-order"]);
    expect(result.events).toEqual([{ id: "real-event-1", type: "OrderCreated" }]);
  });

  it("uses an injected normalizer for non-JSON or service-specific observations", async () => {
    const endpoint = createRealApiEndpoint({
      fetch: async () => response(200, "accepted", { "X-Result": "ok" }),
      normalize: (raw) => ({
        status: raw.status,
        headers: raw.headers,
        body: { message: raw.text, normalized: true },
      }),
    });

    await expect(
      endpoint.execute({ method: "GET", path: "/health" }, { index: 0, operation: "health" }),
    ).resolves.toEqual({
      status: 200,
      headers: { "x-result": "ok" },
      body: { message: "accepted", normalized: true },
    });
  });
});

describe("real API equivalence runner", () => {
  const requests: readonly EquivalenceRequest[] = [
    { method: "POST", path: "/orders", operation: "create" },
    { method: "GET", path: "/orders/model-1", operation: "read" },
  ];

  it("executes both endpoints serially and preserves identifier equivalence across steps", async () => {
    const order: string[] = [];
    const model: EquivalenceEndpoint = {
      execute: async (_request, context): Promise<EquivalenceObservation> => {
        order.push(`model:${context.index}`);
        return context.index === 0
          ? { status: 201, body: { id: "model-1" } }
          : { status: 200, body: { id: "model-1", state: "ready" } };
      },
    };
    const real: EquivalenceEndpoint = {
      execute: async (_request, context): Promise<EquivalenceObservation> => {
        order.push(`real:${context.index}`);
        return context.index === 0
          ? { status: 201, body: { id: "real-9" } }
          : { status: 200, body: { id: "real-9", state: "ready" } };
      },
    };

    const result = await createRealApiEquivalenceRunner({ model, real }).run(requests);

    expect(order).toEqual(["model:0", "real:0", "model:1", "real:1"]);
    expect(result.conforms).toBe(true);
    expect(result.comparison.identifiers.modelToReal).toEqual({ "model-1": "real-9" });
    expect(result.report).toBe("No equivalence divergences.");
  });

  it("reports event mismatches with operation and path context", async () => {
    const result = await createRealApiEquivalenceRunner({
      model: staticEndpoint([
        { status: 200, body: { ok: true }, events: [{ id: "model-event", type: "Created" }] },
      ]),
      real: staticEndpoint([
        { status: 200, body: { ok: true }, events: [{ id: "real-event", type: "Renamed" }] },
      ]),
    }).run([{ method: "GET", path: "/orders/1", operation: "read" }]);

    expect(result.conforms).toBe(false);
    expect(result.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "EVENT_MISMATCH",
          operation: "read events",
          path: "$.events[0].type",
        }),
      ]),
    );
    expect(result.report).toContain("[EVENT_MISMATCH] read events $.events[0].type");
  });

  it("turns endpoint failures into actionable divergences without losing later steps", async () => {
    const result = await createRealApiEquivalenceRunner({
      model: {
        execute: async (_request, context) => {
          if (context.index === 0) throw new Error("model unavailable");
          return { status: 200, body: { ok: true } };
        },
      },
      real: staticEndpoint([
        { status: 200, body: { ok: true } },
        { status: 200, body: { ok: true } },
      ]),
    }).run([
      { method: "GET", path: "/first", operation: "first" },
      { method: "GET", path: "/second", operation: "second" },
    ]);

    expect(result.observations).toHaveLength(2);
    expect(result.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ENDPOINT_FAILURE", operation: "first", path: "$.model" }),
        expect.objectContaining({ code: "STATUS_MISMATCH", operation: "first" }),
      ]),
    );
    expect(result.report).toContain("model endpoint failed: model unavailable");
  });
});

describe("observation normalization helpers", () => {
  it("normalizes header casing and ordering", () => {
    expect(normalizeHeaders({ Zed: "  last ", accept: "json", ACCEPT: "override" })).toEqual({
      accept: "override",
      zed: "last",
    });
  });

  it("keeps plain text while parsing JSON-looking response bodies", async () => {
    await expect(
      normalizeHttpObservation({ status: 200, headers: {}, text: "plain text" }),
    ).resolves.toEqual({ status: 200, headers: {}, body: "plain text" });
    await expect(
      normalizeHttpObservation({ status: 200, headers: {}, text: ' {"ok":true} ' }),
    ).resolves.toEqual({ status: 200, headers: {}, body: { ok: true } });
  });

  it("formats empty and non-empty reports deterministically", () => {
    expect(formatDivergenceReport([])).toBe("No equivalence divergences.");
    expect(
      formatDivergenceReport([
        {
          code: "STATUS_MISMATCH",
          operation: "read",
          path: "$.status",
          expected: 200,
          actual: 500,
          message: "Expected status 200, received 500",
        },
      ]),
    ).toBe(
      "1. [STATUS_MISMATCH] read $.status: Expected status 200, received 500 expected=200 actual=500",
    );
  });
});
