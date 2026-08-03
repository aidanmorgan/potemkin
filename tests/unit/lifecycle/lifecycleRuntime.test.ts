import {
  defineLifecycle,
  lifecycleHook,
  runLifecyclePhase,
  type LifecycleDiagnostic,
} from "../../../src/authoring/lifecycle.js";
import type { JsonObject } from "../../../src/types.js";

describe("runtime lifecycle diagnostics", () => {
  it("reports completion and failure with phase, hook, and duration", async () => {
    const diagnostics: LifecycleDiagnostic[] = [];
    const definition = defineLifecycle({
      hooks: [
        lifecycleHook("request", () => undefined, "accepted"),
        lifecycleHook(
          "request",
          () => {
            throw new Error("refused");
          },
          "rejected",
        ),
      ],
    });

    await runLifecyclePhase(
      definition,
      "request",
      {
        helpers: {
          uuid: () => "id",
          now: () => "2026-01-01T00:00:00.000Z",
          deepClone: <T>(value: T): T => structuredClone(value),
          deepMerge: (a: JsonObject, b: JsonObject) => ({ ...a, ...b }),
        },
      },
      {
        failure: "continue",
        nowMs: () => 0,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    );

    expect(diagnostics).toHaveLength(2);
    expect(
      diagnostics.map(({ phase, hookName, outcome }) => ({ phase, hookName, outcome })),
    ).toEqual([
      { phase: "request", hookName: "accepted", outcome: "completed" },
      { phase: "request", hookName: "rejected", outcome: "failed" },
    ]);
    expect(diagnostics[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics[1]?.error).toBe("refused");
  });
});
