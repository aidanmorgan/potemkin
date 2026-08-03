import { runConformanceGate } from "../../../src/conformance/gate";
import { parseAllowlistDocument } from "../../../src/conformance/allowlist";
import type { ConformanceFailure, SpecmaticTestResult } from "../../../src/conformance/types";

const failure: ConformanceFailure = {
  testName: "unknown lead",
  message: "404 instead of 200",
  details: "",
  method: "GET",
  path: "/leads/{id}",
  scenario: "unknown lead",
  expectedStatus: "200",
  actualStatus: "404",
};

function result(
  cases: readonly ConformanceFailure[],
  exitCode = 0,
  reportOverrides: Partial<SpecmaticTestResult["report"]> = {},
  processOverrides: Partial<SpecmaticTestResult["process"]> = {},
): SpecmaticTestResult {
  return {
    process: {
      command: "java",
      args: [],
      exitCode,
      signal: null,
      stdout: "",
      stderr: "",
      ...processOverrides,
    },
    report: {
      tests: cases.length,
      failures: cases.length,
      errors: 0,
      skipped: 0,
      cases,
      sourceFiles: ["report.xml"],
      ...reportOverrides,
    },
  };
}

describe("conformance gate lifecycle", () => {
  it("resets before verification and shuts down after a passing run", async () => {
    const calls: string[] = [];
    await runConformanceGate({
      provider: {
        baseUrl: "http://stub",
        async reset() {
          calls.push("reset");
        },
        async shutdown() {
          calls.push("shutdown");
        },
      },
      verifier: async () => {
        calls.push("verify");
        return result([], 0, { tests: 1 });
      },
    });
    expect(calls).toEqual(["reset", "verify", "shutdown"]);
  });

  it("fails unexpected findings, keeps the report available in the error, and still shuts down", async () => {
    const calls: string[] = [];
    await expect(
      runConformanceGate({
        provider: {
          baseUrl: "http://stub",
          async reset() {
            calls.push("reset");
          },
          async shutdown() {
            calls.push("shutdown");
          },
        },
        verifier: async () => {
          calls.push("verify");
          return result([failure]);
        },
      }),
    ).rejects.toThrow(`GET /leads/{id}, scenario="unknown lead", expected=200, actual=404`);
    expect(calls).toEqual(["reset", "verify", "shutdown"]);
  });

  it("proves the value path bites on an intentionally wrong contract status", async () => {
    const calls: string[] = [];
    const deliberatelyWrongResult = result([
      {
        ...failure,
        testName: "deliberately wrong provider status",
        actualStatus: "500",
      },
    ]);

    await expect(
      runConformanceGate({
        provider: {
          baseUrl: "http://stub",
          async reset() {
            calls.push("reset");
          },
          async shutdown() {
            calls.push("shutdown");
          },
        },
        verifier: async () => {
          calls.push("verify");
          return deliberatelyWrongResult;
        },
      }),
    ).rejects.toThrow("expected=200, actual=500");
    expect(calls).toEqual(["reset", "verify", "shutdown"]);
  });

  it("rejects a report with no tests so an unmatched filter cannot pass silently", async () => {
    const calls: string[] = [];
    await expect(
      runConformanceGate({
        provider: {
          baseUrl: "http://stub",
          async reset() {
            calls.push("reset");
          },
          async shutdown() {
            calls.push("shutdown");
          },
        },
        verifier: async () => result([], 0, { tests: 0 }),
      }),
    ).rejects.toThrow("Specmatic reported no tests");
    expect(calls).toEqual(["reset", "shutdown"]);
  });

  it("rejects unparsed JUnit failures instead of treating them as a passing report", async () => {
    await expect(
      runConformanceGate({
        provider: { baseUrl: "http://stub", reset: async () => {}, shutdown: async () => {} },
        verifier: async () => result([], 1, { tests: 1, failures: 1 }),
      }),
    ).rejects.toThrow("only 0 failure case(s) could be parsed");
  });

  it("includes verifier termination and diagnostics in a gate failure", async () => {
    await expect(
      runConformanceGate({
        provider: { baseUrl: "http://stub", reset: async () => {}, shutdown: async () => {} },
        verifier: async () =>
          result([], 1, { tests: 1 }, { stderr: "Specmatic could not connect to provider" }),
      }),
    ).rejects.toThrow(
      "Specmatic verifier terminated with exit code 1.\nVerifier diagnostics:\nSpecmatic could not connect to provider",
    );
  });

  it("permits a fully allowlisted Specmatic exit while still enforcing staleness", async () => {
    const allowlist = parseAllowlistDocument({
      version: 1,
      name: "crm-layer-c",
      entries: [
        {
          id: "unknown-lead",
          method: "GET",
          path: "/leads/{id}",
          scenario: "unknown lead",
          expected_status: 200,
          actual_status: 404,
          reason: "An unseeded id is a valid stateful 404.",
        },
      ],
    })[0];
    await expect(
      runConformanceGate({
        provider: { baseUrl: "http://stub", reset: async () => {}, shutdown: async () => {} },
        allowlist,
        verifier: async () => result([failure], 1),
      }),
    ).resolves.toBeDefined();
  });
});
