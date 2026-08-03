import { parseYaml } from "../../../src/parser/yamlParser.js";
import { validateBoundaryConfig } from "../../../src/dsl/schema.js";
import { BootError } from "../../../src/errors.js";

const BASE = {
  boundary: "Opportunity",
  contract_path: "/opportunities",
  behaviors: [],
  reducers: [],
  event_catalog: [],
};

function bootError(fn: () => unknown): BootError {
  try {
    fn();
  } catch (error) {
    if (error instanceof BootError) return error;
    throw error;
  }
  throw new Error("expected BootError");
}

describe("explicit export DSL", () => {
  it("parses named operation drives and preserves JSON bodies and headers", () => {
    const config = validateBoundaryConfig({
      ...BASE,
      export: {
        states: [
          {
            name: "WON",
            steps: [
              {
                operationId: "createOpportunity",
                body: { value: 25_000, nested: { enabled: true }, tags: ["export"] },
                headers: { "x-export": "true" },
              },
            ],
          },
        ],
      },
    });

    expect(config.export).toEqual({
      states: [
        {
          name: "WON",
          steps: [
            {
              operationId: "createOpportunity",
              body: { value: 25_000, nested: { enabled: true }, tags: ["export"] },
              headers: { "x-export": "true" },
            },
          ],
        },
      ],
    });
  });

  it("parses a named global saga reference", () => {
    const config = validateBoundaryConfig({
      ...BASE,
      export: {
        states: [
          {
            name: "converted",
            saga: "LeadConversionSaga",
            steps: [{ operationId: "convertLead", body: { value: 1 } }],
          },
        ],
      },
    });

    expect(config.export?.states[0]?.saga).toBe("LeadConversionSaga");
  });

  it("rejects malformed plans with located DSL errors", () => {
    const err = bootError(() =>
      validateBoundaryConfig({
        ...BASE,
        export: { states: [{ name: "WON", steps: [{ operationId: "create", body: [] }] }] },
      }),
    );

    expect(err.code).toBe("BOOT_ERR_DSL_SYNTAX");
    expect(err.message).toMatch(/root\.export\.states\[0\]\.steps\[0\]\.body/);
  });

  it("rejects duplicate state names and unknown plan keys", () => {
    const duplicate = bootError(() =>
      validateBoundaryConfig({
        ...BASE,
        export: {
          states: [
            { name: "WON", steps: [{ operationId: "create" }] },
            { name: "WON", steps: [{ operationId: "create" }] },
          ],
        },
      }),
    );
    expect(duplicate.message).toMatch(/duplicate state name/);

    const unknown = bootError(() =>
      validateBoundaryConfig({
        ...BASE,
        export: { states: [{ name: "WON", steps: [{ operationId: "create", payload: {} }] }] },
      }),
    );
    expect(unknown.message).toMatch(/unknown key "payload"/);
  });

  it("accepts the checked-in CRM export plans through the YAML parser", () => {
    const config = parseYaml(`
boundary: Example
contract_path: /examples
export:
  states:
    - name: ready
      steps:
        - operationId: createExample
          body:
            nested:
              values: [true, 1, null]
`);

    expect(config.export?.states[0]?.steps[0]?.operationId).toBe("createExample");
  });
});
