import {
  createSymbolicDualRunner,
  type SymbolicSequenceStep,
} from "../../equivalence/dualRunner.js";
import type { EquivalenceEndpoint } from "../../equivalence/realApi.js";
import type { EquivalenceObservation, EquivalenceRequest } from "../../equivalence/types.js";

function endpoint(
  handle: (request: EquivalenceRequest) => EquivalenceObservation,
): EquivalenceEndpoint {
  return { execute: async (request) => handle(request) };
}

function createSequence(): readonly SymbolicSequenceStep[] {
  return [
    {
      operation: "createCustomer",
      request: { method: "POST", path: "/customers", body: { name: "Ada" } },
      mutating: true,
      preStateRequest: { method: "GET", path: "/customers/absent" },
      captures: [{ symbol: "customer", responsePath: "$.id" }],
    },
    {
      operation: "updateCustomer",
      request: {
        method: "PATCH",
        path: "/customers/{{customer}}",
        body: { name: "Grace" },
      },
      mutating: true,
      preStateRequest: { method: "GET", path: "/customers/{{customer}}" },
      writeSet: {
        fields: ["name"],
        replaceState: false,
        derivedClosure: [],
        volatile: [],
      },
    },
  ];
}

describe("symbolic dual equivalence runner", () => {
  it("threads concrete identifiers independently and supplies both pre-states", async () => {
    const seen: { model: string[]; real: string[] } = { model: [], real: [] };
    const makeEndpoint = (prefix: string, side: "model" | "real") =>
      endpoint((request): EquivalenceObservation => {
        seen[side].push(`${request.method} ${request.path}`);
        if (request.method === "POST") return { status: 201, body: { id: `${prefix}_customer` } };
        if (request.path.endsWith("/absent")) return { status: 404, body: null };
        if (request.method === "GET") {
          return { status: 200, body: { id: request.path.split("/").pop()!, name: "Ada" } };
        }
        return {
          status: 200,
          body: { id: request.path.split("/").pop()!, name: "Grace" },
        };
      });

    const result = await createSymbolicDualRunner({
      model: makeEndpoint("cus_model", "model"),
      real: makeEndpoint("cus_real", "real"),
      resetModel: async () => undefined,
    }).run(createSequence());

    expect(result.verdict).toBe("CONFORMS");
    expect(result.steps[1]?.preState).toEqual({
      model: { id: "cus_model_customer", name: "Ada" },
      real: { id: "cus_real_customer", name: "Ada" },
    });
    expect(seen.model).toContain("PATCH /customers/cus_model_customer");
    expect(seen.real).toContain("PATCH /customers/cus_real_customer");
  });

  it("resets Potemkin per sequence while leaving the real side untouched", async () => {
    let resets = 0;
    let realCreates = 0;
    const result = await createSymbolicDualRunner({
      model: endpoint((request) => ({
        status: 201,
        body: { id: request.method === "POST" ? "cus_model" : null },
      })),
      real: endpoint(() => ({ status: 201, body: { id: `cus_real-${++realCreates}` } })),
      resetModel: async () => {
        resets += 1;
      },
    }).runMany([
      [
        {
          operation: "create",
          request: { method: "POST", path: "/customers" },
          captures: [{ symbol: "customer", responsePath: "$.id" }],
        },
      ],
      [
        {
          operation: "create",
          request: { method: "POST", path: "/customers" },
          captures: [{ symbol: "customer", responsePath: "$.id" }],
        },
      ],
    ]);

    expect(result.map((run) => run.verdict)).toEqual(["CONFORMS", "CONFORMS"]);
    expect(resets).toBe(2);
    expect(realCreates).toBe(2);
  });

  it("waits for a stable projection before comparing a stateful response", async () => {
    const makeEndpoint = (settled: string) => {
      let polls = 0;
      return endpoint((request) => {
        if (request.method === "POST") return { status: 200, body: { state: "pending" } };
        if (request.path.endsWith("/absent")) return { status: 404, body: null };
        polls += 1;
        return {
          status: 200,
          body: { state: polls < 2 ? "pending" : settled },
        };
      });
    };

    const result = await createSymbolicDualRunner({
      model: makeEndpoint("ready"),
      real: makeEndpoint("ready"),
      resetModel: async () => undefined,
      sleep: async () => undefined,
    }).run([
      {
        operation: "createOrder",
        request: { method: "POST", path: "/orders" },
        mutating: true,
        preStateRequest: { method: "GET", path: "/orders/absent" },
        poll: {
          request: { method: "GET", path: "/orders/1" },
          maxAttempts: 3,
          intervalMs: 0,
        },
      },
    ]);

    expect(result.verdict).toBe("CONFORMS");
    expect(result.steps[0]?.model.body).toEqual({ state: "ready" });
  });

  it("reports a settled difference, but an unsteady bound is inconclusive", async () => {
    const makeEndpoint = (states: readonly string[]) => {
      let polls = 0;
      return endpoint((request) => {
        if (request.method === "POST") return { status: 200, body: { state: "pending" } };
        if (request.path.endsWith("/absent")) return { status: 404, body: null };
        return { status: 200, body: { state: states[polls++] ?? states.at(-1)! } };
      });
    };
    const baseStep = {
      operation: "createOrder",
      request: { method: "POST", path: "/orders" },
      mutating: true,
      preStateRequest: { method: "GET", path: "/orders/absent" },
      poll: { request: { method: "GET", path: "/orders/1" }, maxAttempts: 3, intervalMs: 0 },
    } as const;

    const divergent = await createSymbolicDualRunner({
      model: makeEndpoint(["pending", "ready", "ready"]),
      real: makeEndpoint(["pending", "failed", "failed"]),
      resetModel: async () => undefined,
    }).run([baseStep]);
    expect(divergent.verdict).toBe("DIVERGES");
    expect(divergent.divergences).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "BODY_MISMATCH" })]),
    );

    const inconclusive = await createSymbolicDualRunner({
      model: makeEndpoint(["pending", "ready", "failed"]),
      real: makeEndpoint(["pending", "ready", "ready"]),
      resetModel: async () => undefined,
    }).run([baseStep]);
    expect(inconclusive.verdict).toBe("INCONCLUSIVE");
    expect(inconclusive.divergences).toEqual([expect.objectContaining({ code: "INCONCLUSIVE" })]);
  });

  it("compares a requires-guard rejection as a contract error output", async () => {
    const guardedRejection = endpoint(() => ({
      status: 422,
      body: { code: "LEAD_NOT_CONTACTED", message: "Lead must be contacted first" },
    }));
    const result = await createSymbolicDualRunner({
      model: guardedRejection,
      real: guardedRejection,
      resetModel: async () => undefined,
    }).run([
      {
        operation: "qualifyLead",
        request: { method: "POST", path: "/leads/cus_1/qualify" },
      },
    ]);

    expect(result.verdict).toBe("CONFORMS");
    expect(result.steps[0]?.model).toEqual({
      status: 422,
      body: { code: "LEAD_NOT_CONTACTED", message: "Lead must be contacted first" },
    });
  });
});
