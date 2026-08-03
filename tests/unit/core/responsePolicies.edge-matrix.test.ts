import {
  applyDebugEnvelope,
  applyPaginationControl,
  applyResponseFormat,
  compileMaskValuePatches,
  decorateStandaloneResponse,
  maskBody,
} from "../../../src/core/responsePolicies.js";
import type {
  RuntimeBoundary,
  RuntimeExecutionResult,
  RuntimeRequest,
} from "../../../src/model/runtime.js";

const request: RuntimeRequest = {
  command: {
    commandId: "command",
    boundary: "Order",
    intent: "query",
    targetId: null,
    payload: {},
    queryParams: { limit: "1", offset: "1", cursor: "old", tenant: ["one", "two"] },
    httpMethod: "GET",
    path: "/orders",
    origin: "inbound",
    depth: 0,
  },
  headers: {},
};

const boundary: RuntimeBoundary = {
  boundary: "Order",
  contractPath: "/orders",
  eventCatalog: [],
  behaviors: [],
  reducers: [],
  response: { mask: ["secret"] },
};

describe("response policy edge matrix", () => {
  it("handles pointer masks over arrays, absent values, and replacement values", () => {
    const body = {
      secret: "root",
      nested: [{ secret: "child", value: "keep" }],
      "slash/key": "encoded",
    };
    expect(maskBody(body, ["/nested/5/missing", "/missing/path"])).toEqual(body);
    expect(maskBody(body, ["secret", "/nested/0/secret", "/slash~1key"])).toEqual({
      nested: [{ value: "keep" }],
    });
    expect(
      compileMaskValuePatches({ nested: [{ secret: "child" }], already: "[MASKED]" }, [
        "secret",
        "/nested/not-an-index/secret",
        "/nested/0/secret",
      ]),
    ).toEqual([
      { op: "replace", path: "/nested/0/secret", value: "[MASKED]" },
      { op: "replace", path: "/nested/0/secret", value: "[MASKED]" },
    ]);
  });

  it("supports raw pagination, cursor links, and envelope cursors", () => {
    const page = {
      items: [{ id: "one" }],
      totalCount: 3,
      offset: 1,
      limit: 1,
      hasMore: true,
      nextCursor: "next",
    };
    expect(applyPaginationControl(page, "envelope", request)).toMatchObject({
      body: { nextCursor: "next" },
    });
    expect(applyPaginationControl(page, "link-header", request).headers.Link).toContain(
      "cursor=next",
    );
    expect(applyPaginationControl([{ id: "one" }], "raw", request)).toEqual({
      body: [{ id: "one" }],
      headers: {},
    });
  });

  it("creates independent event-only and debug-only envelopes", () => {
    const event = {
      eventId: "event-1",
      type: "OrderCreated",
      boundary: "Order",
      aggregateId: "order-1",
      payload: { secret: "hidden" },
      timestamp: "2030-01-01T00:00:00.000Z",
      sequenceVersion: 1,
      causedBy: null,
    };
    expect(
      applyDebugEnvelope("scalar", { ...request, controls: { includeEvents: true } }, boundary, [
        event,
      ]),
    ).toMatchObject({ value: "scalar", _events: [{ payload: {} }] });
    expect(
      applyDebugEnvelope({ ok: true }, { ...request, controls: { echo: true } }, boundary, []),
    ).toMatchObject({ ok: true, _debug: { boundary: "Order" } });
  });

  it("applies default security headers and leaves undecorated responses unchanged", () => {
    const response: RuntimeExecutionResult = {
      status: 200,
      body: { value: "ok" },
      headers: {},
      events: [],
      committed: true,
    };
    expect(
      decorateStandaloneResponse(response, request, {
        nosniff: true,
        frameDeny: true,
        hsts: true,
        referrerPolicy: "same-origin",
      }),
    ).toMatchObject({
      headers: {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
        "Referrer-Policy": "same-origin",
      },
      body: { value: "ok" },
    });
    expect(
      decorateStandaloneResponse(response, { ...request, controls: { maskFields: [] } }, undefined),
    ).toMatchObject({ body: { value: "ok" } });
  });

  it("covers the transport-neutral HAL and JSON:API format strategies", () => {
    const page = { items: [{ id: "one" }], totalCount: 1, offset: 0, limit: 1, hasMore: false };
    expect(applyResponseFormat(null, "hal", "Order", "/orders")).toBeNull();
    expect(applyResponseFormat(page, "hal", "Order", "/orders")).toMatchObject({
      _embedded: { items: [{ id: "one" }] },
      totalCount: 1,
    });
    expect(
      applyResponseFormat({ _links: { existing: {} } }, "hal", "Order", "/orders"),
    ).toMatchObject({
      _links: { self: { href: "/orders" }, existing: {} },
    });
    expect(applyResponseFormat(null, "jsonapi", "Order", "/orders")).toBeNull();
    expect(applyResponseFormat({ id: true, value: "x" }, "jsonapi", "Order", "/orders")).toEqual({
      data: { type: "Order", attributes: { value: "x" } },
    });
    expect(applyResponseFormat("scalar", "jsonapi", "Order", "/orders")).toEqual({
      data: { type: "Order", attributes: "scalar" },
    });
  });
});
