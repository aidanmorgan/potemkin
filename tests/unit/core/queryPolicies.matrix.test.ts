import {
  compareQueryValues,
  decodeCursor,
  encodeCursor,
  expandFields,
  queryOperator,
  queryValue,
  readPath,
  selectFields,
} from "../../../src/core/queryPolicies.js";
import type { JsonObject } from "../../../src/types.js";

describe("query policy strategies", () => {
  it("reads scalar, repeated, nested-object, and array values", () => {
    expect(queryValue("one")).toBe("one");
    expect(queryValue(["first", "second"])).toBe("first");
    expect(queryValue(undefined)).toBeUndefined();
    const value: JsonObject = { nested: { items: [{ id: "item-1" }] } };
    expect(readPath(value, "nested.items.0.id")).toBe("item-1");
    expect(readPath(value, "nested.missing")).toBeUndefined();
    expect(readPath({ value: 1 }, "value.deep")).toBeUndefined();
    expect(readPath({ items: ["one"] }, "items.2")).toBeUndefined();
  });

  it("compares nullable, numeric, and textual values", () => {
    expect(compareQueryValues(undefined, null)).toBe(0);
    expect(compareQueryValues(null, "value")).toBe(1);
    expect(compareQueryValues("value", undefined)).toBe(-1);
    expect(compareQueryValues(2, 1)).toBe(1);
    expect(compareQueryValues("a", "b")).toBeLessThan(0);
  });

  it("dispatches named operators and numeric fallback operators", () => {
    expect(queryOperator(["admin", "user"], "arrayContains", "user")).toBe(true);
    expect(queryOperator(["admin"], "contains", "admin")).toBe(true);
    expect(queryOperator("Administrator", "contains", "min")).toBe(true);
    expect(queryOperator("Administrator", "startsWith", "admin")).toBe(true);
    expect(queryOperator("Administrator", "endsWith", "ator")).toBe(true);
    expect(queryOperator("admin", "in", "user, admin")).toBe(true);
    expect(queryOperator(10, "gt", "9")).toBe(true);
    expect(queryOperator(10, "gte", "10")).toBe(true);
    expect(queryOperator(10, "lt", "11")).toBe(true);
    expect(queryOperator(10, "lte", "10")).toBe(true);
    expect(queryOperator(10, "ne", "11")).toBe(true);
    expect(queryOperator(10, "unknown", "11")).toBe(false);
    expect(queryOperator(undefined, "ne", "missing")).toBe(true);
    expect(queryOperator(undefined, "eq", "missing")).toBe(false);
    expect(queryOperator("not-a-number", "gt", "z")).toBe(false);
    expect(queryOperator("same", "ne", "same")).toBe(false);
  });

  it("encodes cursors and fails closed for malformed cursor values", () => {
    const cursor = encodeCursor("order-1");
    expect(decodeCursor(cursor)).toBe("order-1");
    expect(decodeCursor("not-base64-json")).toBeUndefined();
    expect(
      decodeCursor(Buffer.from(JSON.stringify({ id: 1 })).toString("base64url")),
    ).toBeUndefined();
  });

  it("selects and expands fields without mutating the source object", () => {
    const value = { id: "one", name: "Order", customerIds: ["customer-1", 7], status: "OPEN" };
    expect(selectFields(value, [])).toBe(value);
    expect(selectFields(value, ["status", "missing", "status"])).toEqual({
      id: "one",
      status: "OPEN",
    });
    const state = new Map([
      ["customer-1", { id: "customer-1", name: "Ada" }],
      ["customer-2", { id: "customer-2", name: "Grace" }],
    ]);
    expect(expandFields(value, [], state)).toBe(value);
    expect(expandFields(value, ["customerIds", "status", "missing"], state)).toEqual({
      ...value,
      _customerIds: [{ id: "customer-1", name: "Ada" }],
    });
  });
});
