import {
  NEGATIVE_LAYER_FILTER,
  parseArgs,
  specmaticOptionsForLayer,
} from "../../../src/conformance/cli-options";
import { resolveSpecmaticContract } from "../../../src/conformance/cli";

describe("conformance CLI options", () => {
  it("defaults to the negative layer and a bounded deterministic run", () => {
    expect(parseArgs([])).toEqual({
      layer: "negative",
      maxCombinations: 25,
      exampleName: "crm",
      specmaticContractPath: undefined,
    });
    expect(specmaticOptionsForLayer("negative")).toEqual({
      filter: NEGATIVE_LAYER_FILTER,
      testMode: "all",
    });
  });

  it("composes a caller filter with the mandatory negative status slice", () => {
    expect(specmaticOptionsForLayer("negative", "METHOD='POST'")).toEqual({
      filter: `(${NEGATIVE_LAYER_FILTER}) && (METHOD='POST')`,
      testMode: "all",
    });
  });

  it("sets both Specmatic layer switches explicitly for positive runs", () => {
    expect(parseArgs(["--layer", "positive", "--max-combinations", "7"])).toEqual({
      layer: "positive",
      maxCombinations: 7,
      exampleName: "crm",
      specmaticContractPath: undefined,
    });
    expect(specmaticOptionsForLayer("positive")).toEqual({
      filter: undefined,
      testMode: "positiveOnly",
    });
  });

  it("does not alter a positive caller filter", () => {
    expect(specmaticOptionsForLayer("positive", "PATH='/agents'")).toEqual({
      filter: "PATH='/agents'",
      testMode: "positiveOnly",
    });
  });

  it("preserves the filter expression exactly so Specmatic receives a deterministic selector", () => {
    const filter = "METHOD='GET' && PATH='/agents'";
    expect(parseArgs(["--filter", filter])).toMatchObject({ filter });
  });

  it("accepts an explicit Specmatic contract when the engine contract is too large for the pinned JVM", () => {
    expect(
      parseArgs(["--specmatic-contract", "tests/fixtures/exported-corpus/stripe-export.yaml"]),
    ).toMatchObject({
      specmaticContractPath: expect.stringMatching(
        /tests\/fixtures\/exported-corpus\/stripe-export\.yaml$/,
      ),
    });
  });

  it("selects the source-controlled Stripe Layer-A slice only for the default negative run", () => {
    const authoritative = "/workspace/examples/stripe/openapi/stripe-official.json";
    expect(resolveSpecmaticContract("stripe", "negative", authoritative)).toMatch(
      /examples\/stripe\/conformance\/layer-a\.yaml$/,
    );
    expect(resolveSpecmaticContract("stripe", "positive", authoritative)).toBe(authoritative);
    expect(resolveSpecmaticContract("crm", "negative", authoritative)).toBe(authoritative);
  });

  it.each(["0", "-1", "1.5", "not-a-number", "9007199254740992"])(
    "rejects an invalid combination cap: %s",
    (value) => {
      expect(() => parseArgs(["--max-combinations", value])).toThrow(/max-combinations/);
    },
  );

  it("rejects an empty filter instead of silently running the whole contract", () => {
    expect(() => parseArgs(["--filter", ""])).toThrow(
      "Conformance option '--filter' requires a non-empty expression",
    );
  });
});
