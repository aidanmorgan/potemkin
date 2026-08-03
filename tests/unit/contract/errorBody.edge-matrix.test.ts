import {
  buildContractErrorBody,
  validateContractErrorBody,
} from "../../../src/contract/errorBody.js";
import type { OpenApiDoc } from "../../../src/contract/loader.js";
import type { JsonObject } from "../../../src/types.js";

function document(schema: Record<string, unknown>): OpenApiDoc {
  return {
    raw: { components: { schemas: { Error: schema } } },
    paths: {
      "/errors": {
        get: { responseSchemas: { default: schema as JsonObject } },
      },
    },
  };
}

describe("contract error body edge matrix", () => {
  it("fills every format, pattern generator branch, and virtual-clock input", () => {
    const doc = document({
      type: "object",
      required: [
        "url",
        "digits",
        "word",
        "lower",
        "class",
        "group",
        "dot",
        "optional",
        "star",
        "uuidPattern",
        "invalidPattern",
        "code",
        "message",
      ],
      properties: {
        url: { type: "string", format: "url" },
        digits: { type: "string", pattern: "^\\d+$" },
        word: { type: "string", pattern: "^\\w+$" },
        lower: { type: "string", pattern: "^[a-z]+$" },
        class: { type: "string", pattern: "^[0-9]+$" },
        group: { type: "string", pattern: "^(?:foo|bar)$" },
        dot: { type: "string", pattern: "^.$" },
        optional: { type: "string", pattern: "^ab?$" },
        star: { type: "string", pattern: "^ab*$" },
        uuidPattern: { type: "string", pattern: "^[A-Z]+$" },
        invalidPattern: { type: "string", pattern: "[" },
        code: { type: "string", enum: ["api_error"], minLength: 3 },
        message: { type: "string", minLength: 2 },
      },
    });
    const body = buildContractErrorBody(
      doc,
      "GET",
      "/errors",
      500,
      { code: "ENGINE_FAILURE", message: "failed" },
      { now: () => "2030-01-02T03:04:05.000Z", clockOffsetMs: 3_600_000 },
    );
    expect(body).toMatchObject({
      url: "https://example.com/error",
      digits: "0",
      word: "0",
      lower: "a",
      class: "0",
      group: "foo",
      dot: "0",
      optional: "a",
      star: "a",
      invalidPattern: "",
      code: "api_error",
      message: "failed",
    });

    const invalidClock = buildContractErrorBody(
      document({ type: "string", format: "date-time" }),
      "GET",
      "/errors",
      500,
      {},
      { now: () => "not-a-date", clockOffsetMs: Number.NaN },
    );
    expect(invalidClock).toBe("1970-01-01T00:00:00.000Z");
  });

  it("preserves useful optional diagnostics for open and nested envelopes", () => {
    const open = document({ type: "object", additionalProperties: true });
    expect(
      buildContractErrorBody(open, "GET", "/errors", 500, {
        code: "OPEN",
        message: "open message",
        details: { field: "value" },
      }),
    ).toEqual({ code: "OPEN", message: "open message", details: { field: "value" } });

    const nested = document({
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["api_error"] },
            message: { type: "string" },
            code: { type: "string", enum: ["mapped"] },
            details: { type: "object" },
          },
        },
        message: { type: "string" },
        code: { type: "string" },
        details: { type: "object" },
      },
    });
    expect(
      buildContractErrorBody(
        nested,
        "GET",
        "/errors",
        400,
        { code: "ENGINE", message: "message", details: { reason: "test" } },
        { codeMap: { ENGINE: "mapped" } },
      ),
    ).toMatchObject({
      error: { type: "mapped" },
      message: "message",
      code: "mapped",
      details: { reason: "test" },
    });
  });

  it("handles external and cyclic references during fill and validation", () => {
    const doc: OpenApiDoc = {
      raw: {
        components: {
          schemas: {
            Cyclic: { $ref: "#/components/schemas/Cyclic" },
            Nested: {
              type: "object",
              required: ["value"],
              properties: { value: { type: "string" } },
            },
          },
        },
      },
      paths: {
        "/errors": {
          get: {
            responseSchemas: {
              default: {
                type: "object",
                required: ["cyclic", "external", "nested"],
                properties: {
                  cyclic: { $ref: "#/components/schemas/Cyclic" },
                  external: { $ref: "https://example.com/Error" },
                  nested: { $ref: "#/components/schemas/Nested" },
                },
              },
            },
          },
        },
      },
    };
    const body = buildContractErrorBody(doc, "GET", "/errors", 500, { code: "BROKEN" });
    expect(body).toEqual({ cyclic: "", external: "", nested: { value: "" } });
    expect(validateContractErrorBody(doc, "GET", "/errors", 500, body!)).toMatchObject({
      valid: true,
    });
  });
});
