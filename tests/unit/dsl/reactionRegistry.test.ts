import {
  buildReactionRegistry,
  validateReactionCrossReferences,
} from "../../../src/dsl/reactionRegistry.js";
import type { BoundaryConfig, ReactionRule } from "../../../src/dsl/types.js";

function boundary(name: string, ...eventTypes: string[]): BoundaryConfig {
  return {
    boundary: name,
    contractPath: `/${name.toLowerCase()}`,
    behaviors: [],
    reducers: [],
    eventCatalog: eventTypes.map((type) => ({ type, payloadTemplate: {} })),
  };
}

function reaction(overrides: Partial<ReactionRule> = {}): ReactionRule {
  return {
    on: "SourceCreated",
    boundary: "Target",
    emit: "TargetCreated",
    ...overrides,
  };
}

const boundaries = {
  Source: boundary("Source", "SourceCreated"),
  Target: boundary("Target", "TargetCreated"),
};

describe("reaction registry", () => {
  it("groups reactions by trigger and validates qualified and bare subscriptions", () => {
    const reactions = [
      reaction({ name: "qualified", on: "Source:SourceCreated" }),
      reaction({ name: "bare" }),
      reaction({ name: "second-bare" }),
    ];

    const registry = buildReactionRegistry(reactions);

    expect(registry.get("Source:SourceCreated")).toEqual([reactions[0]]);
    expect(registry.get("SourceCreated")).toEqual([reactions[1], reactions[2]]);
    expect(() => validateReactionCrossReferences(reactions, boundaries)).not.toThrow();
  });

  it.each([
    ["unknown target boundary", reaction({ boundary: "Missing" }), "reacting boundary"],
    ["unknown emitted event", reaction({ emit: "MissingCreated" }), "emit"],
    [
      "unknown qualified trigger boundary",
      reaction({ on: "Missing:SourceCreated" }),
      'trigger "on" boundary',
    ],
    [
      "unknown qualified trigger event",
      reaction({ on: "Source:MissingCreated" }),
      "trigger event type",
    ],
    ["unknown bare trigger event", reaction({ on: "MissingCreated" }), "trigger event type"],
  ])("rejects %s", (_description, invalidReaction, message) => {
    expect(() => validateReactionCrossReferences([invalidReaction], boundaries)).toThrow(
      expect.objectContaining({ code: "BOOT_ERR_DSL_REFERENCE" }),
    );
    expect(() => validateReactionCrossReferences([invalidReaction], boundaries)).toThrow(message);
  });
});
