import {
  applyPatches,
  diffJsonJournal,
  joinPointer,
  parsePointer,
  JsonPointerError,
  PatchApplyError,
  type Patch,
} from "../../../src/model/patches.js";
import type { JsonValue } from "../../../src/types.js";

describe("source-neutral patch operations with reducer auto-vivification", () => {
  it("creates a replayable journal for nested arrays and object keys", () => {
    const before: JsonValue = {
      root: {
        items: [{ secret: "one", keep: true }, { secret: "two" }],
        "a/b": true,
      },
    };
    const after: JsonValue = {
      root: {
        items: [{ secret: "[MASKED]", keep: true }, { secret: "updated" }, { secret: "three" }],
        "a/b": true,
        added: null,
      },
    };

    const journal = diffJsonJournal(before, after, "mask");
    expect(journal).toEqual([
      expect.objectContaining({ source: "mask", op: "replace", path: "/root/items/0/secret" }),
      expect.objectContaining({ source: "mask", op: "replace", path: "/root/items/1/secret" }),
      expect.objectContaining({ source: "mask", op: "add", path: "/root/items/2" }),
      expect.objectContaining({ source: "mask", op: "add", path: "/root/added" }),
    ]);
    const patches = journal!.map(({ source: _source, ...patch }) => patch as Patch);
    expect(applyPatches(before, patches).newState).toEqual(after);
  });

  it("declines a journal when the root representation changes kind", () => {
    expect(diffJsonJournal([{ value: 1 }], { data: [{ value: 1 }] }, "overlay")).toBeUndefined();
  });

  it("creates arbitrarily nested objects and arrays from an empty object", () => {
    const result = applyPatches(
      {},
      [
        { op: "replace", path: "/order/customer/name", value: "Ada" },
        { op: "append", path: "/order/lines", value: { sku: "A", quantity: 2 } },
        { op: "prepend", path: "/order/lines", value: { sku: "B", quantity: 1 } },
        { op: "increment", path: "/order/attempts", by: 1 },
        { op: "merge", path: "/order/metadata", value: { source: "test" } },
        { op: "upsert", path: "/order/lines", key: "sku", value: { sku: "A", quantity: 3 } },
      ],
      "reducer",
      { autoVivify: true },
    );

    expect(result.newState).toEqual({
      order: {
        customer: { name: "Ada" },
        lines: [
          { sku: "B", quantity: 1 },
          { sku: "A", quantity: 3 },
        ],
        attempts: 1,
        metadata: { source: "test" },
      },
    });
    expect(result.touchedPaths).toEqual(
      new Set(["/order/customer/name", "/order/lines", "/order/attempts", "/order/metadata"]),
    );
  });

  it("coerces wrong-typed reducer targets while preserving primitive values", () => {
    const result = applyPatches(
      { list: "not-an-array", count: "not-a-number", metadata: 7, entries: "not-an-array" },
      [
        { op: "append", path: "/list", value: null },
        { op: "increment", path: "/count", by: 4 },
        { op: "merge", path: "/metadata", value: { nested: [true, null] }, deep: true },
        { op: "upsert", path: "/entries", key: "id", value: { id: "one", value: false } },
        { op: "remove", path: "/missing" },
      ],
      "reducer",
      { autoVivify: true },
    );

    expect(result.newState).toEqual({
      list: [null],
      count: 4,
      metadata: { nested: [true, null] },
      entries: [{ id: "one", value: false }],
    });
  });

  it("deep-merges objects without merging arrays or primitive values", () => {
    const result = applyPatches(
      { value: { nested: { keep: true, replace: { old: 1 } }, items: [1], scalar: 1 } },
      [
        {
          op: "merge",
          path: "/value",
          deep: true,
          value: {
            nested: { replace: { next: 2 }, added: "yes" },
            items: [2],
            scalar: null,
          },
        },
      ],
    );

    expect(result.newState).toEqual({
      value: {
        nested: { keep: true, replace: { old: 1, next: 2 }, added: "yes" },
        items: [2],
        scalar: null,
      },
    });
  });

  it("supports array move/copy and records both touched pointers", () => {
    const result = applyPatches({ items: [{ id: "a" }, { id: "b" }] }, [
      { op: "copy", from: "/items/0", path: "/items/2" },
      { op: "move", from: "/items/1", path: "/items/0" },
    ]);

    expect(result.newState).toEqual({ items: [{ id: "b" }, { id: "a" }, { id: "a" }] });
    expect(result.touchedPaths).toEqual(new Set(["/items/0", "/items/1", "/items/2"]));
  });

  const strictWrongTypedPatches: readonly Patch[] = [
    { op: "append" as const, path: "/value", value: 1 },
    { op: "increment" as const, path: "/value", by: 1 },
    { op: "merge" as const, path: "/value", value: { ok: true } },
    { op: "upsert" as const, path: "/value", key: "id", value: { id: "one" } },
  ];

  it.each(strictWrongTypedPatches)(
    "rejects strict operations against a wrong-typed target: $op",
    (patch) => {
      expect(() => applyPatches({ value: "wrong" }, [patch])).toThrow(PatchApplyError);
    },
  );

  it("rejects missing move/copy sources and root targets", () => {
    expect(() =>
      applyPatches({ items: [] }, [{ op: "copy", from: "/missing", path: "/items/0" }]),
    ).toThrow(PatchApplyError);
    expect(() =>
      applyPatches({ items: [] }, [{ op: "move", from: "/missing", path: "/items/0" }]),
    ).toThrow(PatchApplyError);
    expect(() => applyPatches({}, [{ op: "add", path: "", value: true }])).toThrow(PatchApplyError);
  });

  it("covers strict missing targets, pointer escaping, and array insertion semantics", () => {
    expect(parsePointer("")).toEqual([]);
    expect(parsePointer("/a~1b/~0key")).toEqual(["a/b", "~key"]);
    expect(joinPointer(["a/b", "~key"])).toBe("/a~1b/~0key");
    expect(() => parsePointer("not-a-pointer")).toThrow(JsonPointerError);

    const strictMissingPatches: readonly Patch[] = [
      { op: "replace", path: "/missing", value: true },
      { op: "remove", path: "/missing" },
      { op: "append", path: "/missing", value: true },
      { op: "increment", path: "/missing", by: 1 },
      { op: "merge", path: "/missing", value: { value: true } },
      { op: "upsert", path: "/missing", key: "id", value: { id: "new" } },
    ];
    for (const patch of strictMissingPatches) {
      expect(() => applyPatches({}, [patch])).toThrow(PatchApplyError);
    }

    expect(
      applyPatches({ values: ["first"] }, [
        { op: "add", path: "/values/0", value: "inserted" },
        { op: "add", path: "/values/-", value: "last" },
      ]).newState,
    ).toEqual({ values: ["inserted", "first", "last"] });
    expect(
      applyPatches({ items: [{ id: "one" }, "primitive"] }, [
        { op: "upsert", path: "/items", key: "id", value: { id: "one", value: 2 } },
        { op: "upsert", path: "/items", key: "id", value: { id: "two", value: 3 } },
      ]).newState,
    ).toEqual({ items: [{ id: "one", value: 2 }, "primitive", { id: "two", value: 3 }] });
  });

  it("reports strict traversal failures for primitives and invalid array indexes", () => {
    expect(() =>
      applyPatches({ value: 1 }, [{ op: "replace", path: "/value/nested", value: true }]),
    ).toThrow(PatchApplyError);
    expect(() =>
      applyPatches({ values: [] }, [{ op: "replace", path: "/values/nope", value: true }]),
    ).toThrow(PatchApplyError);
    expect(() =>
      applyPatches({ values: [] }, [{ op: "replace", path: "/values/-1", value: true }]),
    ).toThrow(PatchApplyError);
  });
});
