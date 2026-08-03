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

describe("query policies", () => {
  it("normalizes query values and reads nested paths", () => {
    expect(queryValue(["first", "second"])).toBe("first");
    expect(readPath({ profile: { score: 7 }, tags: ["a", "b"] }, "profile.score")).toBe(7);
    expect(readPath({ profile: { score: 7 }, tags: ["a", "b"] }, "tags.1")).toBe("b");
    expect(readPath({ profile: { score: 7 } }, "profile.missing")).toBeUndefined();
  });

  it("dispatches comparison behavior through query operator strategies", () => {
    expect(queryOperator("Alpha", "contains", "pha")).toBe(true);
    expect(queryOperator(["alpha", "beta"], "arrayContains", "beta")).toBe(true);
    expect(queryOperator("alpha", "startsWith", "AL")).toBe(true);
    expect(queryOperator("alpha", "endsWith", "HA")).toBe(true);
    expect(queryOperator("beta", "in", "alpha, beta")).toBe(true);
    expect(queryOperator(10, "gte", "2")).toBe(true);
    expect(queryOperator(10, "ne", "10")).toBe(false);
    expect(queryOperator(undefined, "ne", "missing")).toBe(true);
  });

  it("keeps cursor and projection policies deterministic", () => {
    expect(decodeCursor(encodeCursor("order-1"))).toBe("order-1");
    expect(decodeCursor("not-a-cursor")).toBeUndefined();
    expect(compareQueryValues(2, 10)).toBe(-8);
    expect(selectFields({ id: "1", name: "Ada", secret: "hidden" }, ["name"])).toEqual({
      id: "1",
      name: "Ada",
    });
    expect(
      expandFields(
        { id: "1", related: ["2", "missing"] },
        ["related"],
        new Map([["2", { id: "2", name: "Grace" }]]),
      ),
    ).toEqual({ id: "1", related: ["2", "missing"], _related: [{ id: "2", name: "Grace" }] });
  });
});
