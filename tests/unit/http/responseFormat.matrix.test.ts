import { applyPaginationStyle, applyResponseFormat } from "../../../src/http/responseFormat.js";

const query = { tenant: ["acme", "backup"], offset: "2", limit: "1", cursor: "old" };

describe("HTTP response representation strategies", () => {
  it("handles non-collections, arrays, envelopes, cursors, and link pagination", () => {
    expect(applyPaginationStyle(null, "raw", query, "/orders")).toEqual({
      body: null,
      headers: {},
    });
    expect(applyPaginationStyle({ id: "one" }, "raw", query, "/orders")).toEqual({
      body: { id: "one" },
      headers: {},
    });
    expect(applyPaginationStyle(["one"], "envelope", { limit: "bad" }, "/orders")).toMatchObject({
      body: { items: ["one"], totalCount: 1, offset: 0, limit: 0, hasMore: false },
    });
    expect(
      applyPaginationStyle(["one"], "envelope", { limit: ["2", "3"] }, "/orders"),
    ).toMatchObject({
      body: { limit: 2 },
    });
    expect(applyPaginationStyle(["one"], "envelope", {}, "/orders")).toMatchObject({
      body: { limit: 1 },
    });
    expect(
      applyPaginationStyle(
        { items: [{ id: "one" }], totalCount: 3, offset: 1, limit: 1, hasMore: true },
        "link-header",
        query,
        "/orders?ignored=true",
      ),
    ).toMatchObject({
      body: [{ id: "one" }],
      headers: { "X-Total-Count": "3", Link: expect.stringContaining('rel="next"') },
    });
    expect(
      applyPaginationStyle(
        { items: [{ id: "one" }], totalCount: 1, offset: 0, limit: 0, hasMore: false },
        "link-header",
        query,
        "/orders",
      ).headers,
    ).toEqual({ "X-Total-Count": "1" });
  });

  it("formats nulls, scalars, arrays, entities, and paged resources", () => {
    expect(applyResponseFormat(null, "hal", "Order", "/orders")).toBeNull();
    expect(applyResponseFormat("value", "hal", "Order", "/orders")).toBe("value");
    expect(applyResponseFormat({ value: true }, "hal", "Order", "/orders?x=1")).toMatchObject({
      _links: { self: { href: "/orders" } },
    });
    expect(
      applyResponseFormat(
        { items: [{ id: "one" }], totalCount: 1, offset: 0, limit: 1, hasMore: false },
        "hal",
        "Order",
        "/orders",
      ),
    ).toMatchObject({ _embedded: { items: [{ id: "one" }] }, totalCount: 1 });
    expect(applyResponseFormat(1, "jsonapi", "Order", "/orders")).toEqual({
      data: { type: "Order", attributes: 1 },
    });
    expect(
      applyResponseFormat([{ id: 1 }, { value: "plain" }], "jsonapi", "Order", "/orders"),
    ).toEqual({
      data: [
        { type: "Order", id: "1", attributes: {} },
        { type: "Order", attributes: { value: "plain" } },
      ],
    });
    expect(
      applyResponseFormat(
        { items: [{ id: "one" }], totalCount: 1, offset: 0, limit: 1, hasMore: false },
        "jsonapi",
        "Order",
        "/orders",
      ),
    ).toMatchObject({ data: [{ id: "one" }], meta: { totalCount: 1 } });
  });
});
