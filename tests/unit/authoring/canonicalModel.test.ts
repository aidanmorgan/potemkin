import {
  boundary,
  behavior,
  compileProgram,
  event,
  expression,
  simulation,
} from "../../../src/authoring/runtimeModel.js";
import { reducerRule } from "../../../src/authoring/nativeReducer.js";
import { createRuntimeDataGenerator } from "../../../src/model/data.js";
import type { EventContext } from "../../../src/model/runtime.js";
import { TypeScriptAuthoringError } from "../../../src/authoring/errors.js";
import {
  boundaryName,
  contractPath,
  eventType,
  operationId,
  pathSegment,
} from "../../../src/authoring/references.js";

const dependencies = {
  contract: { operationIdFor: () => undefined },
  clock: {
    nowMs: () => 1_735_689_600_000,
    offsetMs: () => 0,
    advance: () => 0,
    reset: () => undefined,
  },
  helpers: {
    now: () => "2026-01-01T00:00:00.000Z",
    uuid: () => "00000000-0000-7000-8000-000000000001",
    random: () => 0,
    data: createRuntimeDataGenerator(() => 0),
    clone: <T>(value: T) => structuredClone(value),
  },
};

describe("canonical authored model", () => {
  it("accepts typed direct declarations through the same runtime model as YAML", () => {
    const definition = simulation()
      .boundary(
        boundary(boundaryName("Ledger"), contractPath(pathSegment("ledger")))
          .eventCatalog(
            event(eventType("LedgerCreated"), {
              id: expression(
                "event",
                ({ command }: EventContext) => command.targetId ?? "generated",
              ),
            }),
          )
          .behavior(
            behavior({
              name: "createLedger",
              operationId: operationId("createLedger"),
              condition: () => true,
              emit: eventType("LedgerCreated"),
            }),
          )
          .reducer(
            reducerRule(eventType("LedgerCreated"))
              .apply(({ state, event: emitted }) => ({ ...state, id: emitted.payload.id }))
              .build(),
          )
          .build(),
      )
      .build();

    const compiled = compileProgram(definition, { dependencies });
    const compiledBoundary = compiled.boundaries[0]!;

    expect(compiled.boundaries).toHaveLength(1);
    expect(typeof compiledBoundary.behaviors[0]?.condition).toBe("function");
    expect(typeof compiledBoundary.eventCatalog[0]?.payload.id).toBe("function");
    expect(compiledBoundary.eventCatalog[0]?.payload.id).toHaveProperty("phase", "event");
  });

  it("rejects malformed latency at the TypeScript authoring boundary", () => {
    expect(() =>
      boundary(boundaryName("Broken"), contractPath(pathSegment("broken"))).latency({
        fixedMs: -1,
      }),
    ).toThrow(
      expect.objectContaining({
        name: "TypeScriptAuthoringError",
        code: "TS_CONFIGURATION_INVALID",
      }),
    );
    expect(() =>
      boundary(boundaryName("Broken"), contractPath(pathSegment("broken"))).latency({
        minMs: 20,
        maxMs: 10,
      }),
    ).toThrow(TypeScriptAuthoringError);
  });
});
