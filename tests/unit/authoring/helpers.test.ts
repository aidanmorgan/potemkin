import { createCelEvaluator } from "../../../src/cel/evaluator.js";
import { CelPhase } from "../../../src/cel/phases.js";
import { defineHelper } from "../../../src/authoring/helpers.js";
import { defineSimulation, simulation } from "../../../src/authoring/runtimeModel.js";
import { helperName } from "../../../src/authoring/references.js";

describe("TypeScript helper model", () => {
  it("keeps the helper callable for TypeScript and exposes a runtime definition", () => {
    const sourceLabel = defineHelper(
      helperName("sourceLabel"),
      (source: string) => `source:${source}`,
    );

    expect(sourceLabel("typescript")).toBe("source:typescript");
    expect(sourceLabel.definition.name).toBe("sourceLabel");
    expect(sourceLabel.definition.invoke(["yaml"])).toBe("source:yaml");
  });

  it("registers the same definition as a CEL function", () => {
    const add = defineHelper(
      helperName("addValues"),
      (left: number, right: number) => left + right,
    );
    const evaluator = createCelEvaluator({
      custom: new Map([
        [add.definition.name, (args) => add.definition.invoke(args as readonly [number, number])],
      ]),
    });

    expect(evaluator.evaluate("addValues(2, 3)", {}, CelPhase.EventHydration)).toBe(5);
  });

  it("stores helpers on the canonical simulation definition", () => {
    const sourceLabel = defineHelper(helperName("sourceLabel"), (source: string) => source);
    const definition = simulation().helper(sourceLabel).build();

    expect(definition.helpers).toEqual([sourceLabel.definition]);
  });

  it("does not expose the broad runtime helper shape to TypeScript definitions", () => {
    const invalid = defineSimulation({
      boundaries: [],
      helpers: [
        {
          // @ts-expect-error Simulation definitions require branded TypeScript helper definitions.
          name: "raw-helper",
          invoke: () => "value",
        },
      ],
    });
    expect(invalid.helpers).toHaveLength(1);
  });

  it("rejects names which cannot be called by CEL", () => {
    expect(() => helperName("not-a-cel-name")).toThrow(/CEL identifier/);
  });

  it("validates direct TypeScript results as JSON values", () => {
    const invalid = defineHelper(helperName("invalidResult"), () => undefined as never);

    expect(() => invalid()).toThrow(/must return a JSON value/);
  });
});
