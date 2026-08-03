import type { Logger } from "../../../src/observability/logger.js";
import type { Span, Tracer } from "../../../src/observability/tracing.js";
import { createCelEvaluator } from "../../../src/cel/evaluator.js";
import { CelPhase } from "../../../src/cel/phases.js";
import { compileYaml } from "../../../src/parser/yamlParser.js";
import { loadOpenApi } from "../../../src/contract/loader.js";

function logger(): Logger & { readonly debug: jest.Mock; readonly info: jest.Mock } {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as Logger & { readonly debug: jest.Mock; readonly info: jest.Mock };
}

function tracer(names: string[]): Tracer {
  const span = {
    setAttribute: jest.fn(),
    setAttributes: jest.fn(),
    setStatus: jest.fn(),
    recordException: jest.fn(),
    end: jest.fn(),
  } as unknown as Span;
  return {
    startActiveSpan: jest.fn((name: string, fn: (current: Span) => unknown) => {
      names.push(name);
      return fn(span);
    }),
  } as unknown as Tracer;
}

const yaml = `
boundary: Widget
contract_path: /widgets
behaviors: []
reducers: []
event_catalog: []
`;

const openapi = {
  openapi: "3.0.3",
  info: { title: "dependency ports", version: "1.0.0" },
  paths: {
    "/widgets": {
      get: {
        operationId: "listWidgets",
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

describe("authoring and contract diagnostic ports", () => {
  it("keeps CEL diagnostic state isolated per evaluator", () => {
    const first = logger();
    const second = logger();
    const firstEvaluator = createCelEvaluator({ logger: first });
    const secondEvaluator = createCelEvaluator({ logger: second });

    expect(() => firstEvaluator.compile("(")).toThrow();
    expect(first.debug).toHaveBeenCalled();
    expect(second.debug).not.toHaveBeenCalled();

    expect(() => secondEvaluator.compile("(")).toThrow();
    expect(second.debug).toHaveBeenCalled();
  });

  it("uses the runtime-supplied random port for unseeded CEL fake data", () => {
    const random = jest.fn(() => 0);
    const evaluator = createCelEvaluator({ random });

    expect(evaluator.evaluate("$fake('person.firstName')", {}, CelPhase.EventHydration)).toBe(
      "Alex",
    );
    expect(random).toHaveBeenCalled();
  });

  it("uses host-supplied logger and tracer ports for YAML linking", async () => {
    const diagnosticLogger = logger();
    const names: string[] = [];

    await compileYaml([{ name: "widget.yaml", yaml }], undefined, undefined, undefined, {
      logger: diagnosticLogger,
      tracer: tracer(names),
    });

    expect(diagnosticLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ moduleCount: 1 }),
      expect.any(String),
    );
    expect(names).toContain("dsl.compile");
  });

  it("uses host-supplied logger and tracer ports for OpenAPI loading", async () => {
    const diagnosticLogger = logger();
    const names: string[] = [];

    await loadOpenApi(openapi, { logger: diagnosticLogger, tracer: tracer(names) });

    expect(diagnosticLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ pathCount: 1, operationCount: 1 }),
      expect.any(String),
    );
    expect(names).toContain("contract.load");
  });
});
