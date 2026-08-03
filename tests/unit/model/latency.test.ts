import { isValidRuntimeLatency, runtimeLatencyProblem } from "../../../src/model/latency.js";

describe("runtime latency validation", () => {
  it("rejects unknown fields and accepts finite non-negative combinations", () => {
    expect(runtimeLatencyProblem({ unknown: 1 })).toMatchObject({
      message: 'latency contains unknown field "unknown"',
    });
    expect(runtimeLatencyProblem({ fixedMs: 1, minMs: 2, maxMs: 2 })).toBeUndefined();
    expect(runtimeLatencyProblem(undefined)).toBeUndefined();
    expect(isValidRuntimeLatency({ minMs: 1, maxMs: 5 })).toBe(true);
    expect(isValidRuntimeLatency({ minMs: 5, maxMs: 1 })).toBe(false);
  });
});
