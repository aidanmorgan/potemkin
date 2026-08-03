import { REMOVED_KEY_MAP, validatePotemkinConfig } from "../../../src/dsl/configSchema";
import { BootError } from "../../../src/errors";

// Every removed snake_case key in REMOVED_KEY_MAP is rejected with
// BOOT_ERR_REMOVED_SYNTAX, and the error names the camelCase replacement. The
// rejection runs in rejectSnakeCaseKeys, shared by both top-level validators
// (potemkin.yml and boundary modules), so a key placed at the root of either
// document trips the same policy regardless of the other required fields.

const ENTRIES = Object.entries(REMOVED_KEY_MAP);

function catchBoot(fn: () => unknown): BootError {
  try {
    fn();
  } catch (e) {
    if (e instanceof BootError) return e;
    throw e;
  }
  throw new Error("expected a BootError to be thrown");
}

describe("REMOVED_KEY_MAP — removed snake_case rejection", () => {
  it("contains exactly the 10 documented removed keys", () => {
    expect(ENTRIES).toHaveLength(10);
    expect(Object.keys(REMOVED_KEY_MAP).sort()).toEqual(
      [
        "contract_path",
        "depends_on",
        "derived_projections",
        "dispatch_commands",
        "event_catalog",
        "out_of_contract",
        "payload_template",
        "seed_expectations",
        "spec_id",
        "state_schema",
      ].sort(),
    );
  });

  it.each(ENTRIES)(
    'potemkin.yml validator rejects removed "%s" and names replacement "%s"',
    (removed, replacement) => {
      const raw = {
        version: 1,
        specmatic: "specmatic.yaml",
        modules: ["dsl/*.yaml"],
        [removed]: "whatever",
      };
      const err = catchBoot(() => validatePotemkinConfig(raw, { source: "potemkin.yml" }));
      expect(err.code).toBe("BOOT_ERR_REMOVED_SYNTAX");
      expect(err.message).toContain(removed);
      expect(err.message).toContain(replacement);
      expect(err.details).toMatchObject({ removed, replacement });
    },
  );
});
