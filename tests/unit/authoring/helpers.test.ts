import { createCelEvaluator } from "../../../src/cel/evaluator.js";
import { CelPhase } from "../../../src/cel/phases.js";
import { defineHelper } from "../../../src/authoring/helpers.js";
import { simulation } from "../../../src/authoring/runtimeModel.js";

describe("TypeScript helper model", () => {
  it("keeps the helper callable for TypeScript and exposes a runtime definition", () => {
    const sourceLabel = defineHelper("sourceLabel", (source: string) => `source:${source}`);

    expect(sourceLabel("typescript")).toBe("source:typescript");
    expect(sourceLabel.definition.name).toBe("sourceLabel");
    expect(sourceLabel.definition.invoke(["yaml"])).toBe("source:yaml");
  });

  it("registers the same definition as a CEL function", () => {
    const add = defineHelper("addValues", (left: number, right: number) => left + right);
    const evaluator = createCelEvaluator({
      custom: new Map([
        [add.definition.name, (args) => add.definition.invoke(args as readonly [number, number])],
      ]),
    });

    expect(evaluator.evaluate("addValues(2, 3)", {}, CelPhase.EventHydration)).toBe(5);
  });

  it("stores helpers on the canonical simulation definition", () => {
    const sourceLabel = defineHelper("sourceLabel", (source: string) => source);
    const definition = simulation().helper(sourceLabel).build();

    expect(definition.helpers).toEqual([sourceLabel.definition]);
  });

  it("rejects names which cannot be called by CEL", () => {
    expect(() => defineHelper("not-a-cel-name", (value: string) => value)).toThrow(
      /CEL identifier/,
    );
  });

  it("validates direct TypeScript results as JSON values", () => {
    const invalid = defineHelper("invalidResult", () => undefined as never);

    expect(() => invalid()).toThrow(/must return a JSON value/);
  });
});
