import {
  compareEquivalenceTrace,
  validateDivergenceLedger,
  validatePinnedDivergenceLedger,
  validateProjectionPolicy,
} from "../../equivalence/comparator.js";
import { generateModelSequences, generateWpSuite } from "../../equivalence/generator.js";
import { contractFieldPolicies } from "../../equivalence/contractMetadata.js";
import { loadOpenApi } from "../../../src/contract/loader.js";
import { shrinkDivergingSequence, type DependentRequest } from "../../equivalence/shrinker.js";
import type {
  DivergenceLedgerEntry,
  EquivalenceRequest,
  EquivalenceStep,
  FiniteStateModel,
} from "../../equivalence/types.js";

function request(operation: string, path: string): EquivalenceRequest {
  return { method: "GET", path, headers: { accept: "application/json" } };
}

function step(
  operation: string,
  model: EquivalenceStep["model"],
  real: EquivalenceStep["real"],
): EquivalenceStep {
  return { operation, request: request(operation, `/orders/${operation}`), model, real };
}

describe("equivalence observables", () => {
  it("accepts contract-declared UUID and date-time volatility without hard-coded field names", async () => {
    const openapi = await loadOpenApi("examples/crm/openapi/nuisance-bureau.yaml");
    const result = compareEquivalenceTrace(
      [
        step(
          "getLead",
          {
            status: 200,
            body: {
              id: "00000000-0000-7000-8000-000000000010",
              createdAt: "1970-01-01T00:00:00.000Z",
            },
          },
          {
            status: 200,
            body: {
              id: "00000000-0000-7000-8000-000000000011",
              createdAt: "2030-01-01T00:00:00.000Z",
            },
          },
        ),
      ],
      { contractFields: contractFieldPolicies(openapi, "getLead") },
    );
    expect(result.conforms).toBe(true);
  });

  it("keeps one coherent identifier bijection across a trace", () => {
    const result = compareEquivalenceTrace([
      step(
        "create",
        {
          status: 201,
          headers: { etag: "v1" },
          body: { id: "model-order", customerId: "model-customer" },
        },
        {
          status: 201,
          headers: { etag: "v1" },
          body: { id: "real-order", customerId: "real-customer" },
        },
      ),
      step(
        "get",
        {
          status: 200,
          headers: { etag: "v1" },
          body: { id: "model-order", customerId: "model-customer" },
        },
        {
          status: 200,
          headers: { etag: "v1" },
          body: { id: "real-order", customerId: "real-customer" },
        },
      ),
    ]);

    expect(result.conforms).toBe(true);
    expect(result.identifiers).toEqual({
      modelToReal: { "model-order": "real-order", "model-customer": "real-customer" },
      realToModel: { "real-order": "model-order", "real-customer": "model-customer" },
    });
  });

  it("detects a bijection contradiction when an identifier is reused differently", () => {
    const result = compareEquivalenceTrace([
      step(
        "create",
        { status: 201, body: { id: "model-1" } },
        { status: 201, body: { id: "real-1" } },
      ),
      step(
        "get",
        { status: 200, body: { id: "model-1" } },
        { status: 200, body: { id: "real-2" } },
      ),
    ]);

    expect(result.conforms).toBe(false);
    expect(result.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "IDENTIFIER_CONTRADICTION", path: "$.body.id" }),
      ]),
    );
  });

  it("supports shape-only and frame projections as explicit future-state policies", () => {
    const shapeResult = compareEquivalenceTrace(
      [
        step(
          "profile",
          { status: 200, body: { profile: { name: "Ada", tags: ["one"] } } },
          { status: 200, body: { profile: { name: "Grace", tags: ["two"] } } },
        ),
      ],
      { shapeOnlyPaths: ["$.profile"] },
    );
    expect(shapeResult.conforms).toBe(true);

    const frameResult = compareEquivalenceTrace(
      [
        step(
          "read",
          { status: 200, body: { version: 1, state: "ready" } },
          { status: 200, body: { version: 1, state: "ready" } },
        ),
        step(
          "read-again",
          { status: 200, body: { version: 1, state: "ready" } },
          { status: 200, body: { version: 2, state: "ready" } },
        ),
      ],
      { framePaths: ["$.version"] },
    );
    expect(frameResult.conforms).toBe(false);
    expect(frameResult.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "FRAME_VIOLATION", path: "$.body.version" }),
      ]),
    );
  });

  it("can ledger an intentional mismatch while rejecting stale ledger entries", () => {
    const observed = [step("create", { status: 201, body: null }, { status: 202, body: null })];
    const entry: DivergenceLedgerEntry = {
      operation: "create",
      path: "$.status",
      code: "STATUS_MISMATCH",
      justification: "The contract allows the implementation to acknowledge asynchronously.",
      citation: "REQ-72",
      pinnedSequence: [observed[0]!.request],
    };

    const allowed = compareEquivalenceTrace(observed, {}, [entry]);
    expect(allowed.conforms).toBe(true);
    expect(
      validateDivergenceLedger(
        [entry],
        [
          ...allowed.divergences,
          { code: "STATUS_MISMATCH", operation: "create", path: "$.status", message: "observed" },
        ],
      ),
    ).toEqual({ valid: true, stale: [] });
    expect(validatePinnedDivergenceLedger([entry])).toEqual({ valid: true, unpinned: [] });

    const stale = compareEquivalenceTrace(observed, {}, [{ ...entry, operation: "delete" }]);
    expect(stale.conforms).toBe(false);
    expect(stale.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "LEDGER_STALE", operation: "delete" }),
      ]),
    );
  });

  it("derives frame and shape projections from the operation write-set", () => {
    const result = compareEquivalenceTrace([
      {
        operation: "update",
        request: request("update", "/orders/1"),
        preState: {
          model: { status: "new", untouched: 1 },
          real: { status: "new", untouched: 1 },
        },
        writeSet: {
          fields: ["status"],
          replaceState: false,
          derivedClosure: [],
          volatile: ["score"],
        },
        model: { status: 200, body: { status: "done", untouched: 1, score: "model-score" } },
        real: { status: 200, body: { status: "done", untouched: 1, score: "real-score" } },
      },
    ]);

    expect(result.conforms).toBe(true);
  });

  it("rejects a frame mutation and accepts uioco extra output fields", () => {
    const result = compareEquivalenceTrace([
      {
        operation: "update",
        request: request("update", "/orders/1"),
        preState: {
          model: { status: "new", untouched: 1 },
          real: { status: "new", untouched: 1 },
        },
        writeSet: {
          fields: ["status"],
          replaceState: false,
          derivedClosure: [],
          volatile: [],
        },
        model: { status: 200, body: { status: "done", untouched: 1 } },
        real: { status: 200, body: { status: "done", untouched: 2, extra: true } },
      },
    ]);

    expect(result.conforms).toBe(false);
    expect(result.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "FRAME_VIOLATION", path: "$.body.untouched" }),
      ]),
    );
  });

  it("accepts additional actual array outputs under uioco inclusion", () => {
    const result = compareEquivalenceTrace([
      step(
        "list",
        { status: 200, body: { data: [{ id: "model-1" }] } },
        { status: 200, body: { data: [{ id: "real-1" }, { id: "real-extra" }] } },
      ),
    ]);

    expect(result.conforms).toBe(true);
    expect(result.identifiers.modelToReal).toEqual({ "model-1": "real-1" });
  });

  it("does not apply a frame oracle to a creation whose pre-state is absent", () => {
    const result = compareEquivalenceTrace([
      {
        operation: "create",
        request: request("create", "/orders"),
        preState: { model: null, real: null },
        writeSet: {
          fields: ["id", "status"],
          replaceState: false,
          derivedClosure: [],
          volatile: [],
        },
        model: { status: 201, body: { id: "order-model", status: "created", generated: 1 } },
        real: { status: 201, body: { id: "order-real", status: "created", generated: 2 } },
      },
    ]);

    expect(result.divergences.some((divergence) => divergence.code === "FRAME_VIOLATION")).toBe(
      false,
    );
  });

  it("binds embedded and cross-entity identifiers through one global sigma", () => {
    const result = compareEquivalenceTrace([
      step(
        "create",
        {
          status: 201,
          body: {
            id: "pi_model",
            latest_charge: "ch_model",
            client_secret: "pi_model_secret_model-secret",
          },
        },
        {
          status: 201,
          body: {
            id: "pi_real",
            latest_charge: "ch_real",
            client_secret: "pi_real_secret_real-secret",
          },
        },
      ),
      step(
        "read",
        { status: 200, body: { payment: "pi_model", charge: "ch_model" } },
        { status: 200, body: { payment: "pi_real", charge: "ch_real" } },
      ),
    ]);

    expect(result.conforms).toBe(true);
    expect(result.identifiers.modelToReal).toMatchObject({
      pi_model: "pi_real",
      ch_model: "ch_real",
    });
  });

  it("requires a cited ledger entry for configured enumerable narrowing", () => {
    const stepValue = step(
      "status",
      { status: 200, body: { status: "processing" } },
      { status: 200, body: { status: "succeeded" } },
    );
    const policy = {
      enumerableNarrowing: { status: { "$.status": ["succeeded"] } },
    } as const;
    const rejected = compareEquivalenceTrace([stepValue], policy);
    expect(rejected.conforms).toBe(false);
    expect(rejected.divergences).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "ENUMERABLE_NARROWING" })]),
    );

    const accepted = compareEquivalenceTrace([stepValue], policy, [
      {
        operation: "status",
        path: "$.body.status",
        code: "ENUMERABLE_NARROWING",
        justification: "Provider intentionally exposes a narrower enum.",
        citation: "EQ4-test-ledger",
        pinnedSequence: [stepValue.request],
      },
    ]);
    expect(accepted.conforms).toBe(true);
  });

  it("uses contract formats and read-only metadata as shape-only volatility", () => {
    const result = compareEquivalenceTrace(
      [
        step(
          "read",
          {
            status: 200,
            body: { created: 1_700_000_000, version: "model-version" },
          },
          {
            status: 200,
            body: { created: 1_700_000_001, version: "real-version" },
          },
        ),
      ],
      {
        contractFields: {
          "$.created": { format: "unix-time" },
          "$.version": { readOnly: true },
        },
      },
    );

    expect(result.conforms).toBe(true);
  });

  it("rejects a narrowing declaration before a trace can silently demote it", () => {
    const policy = {
      enumerableNarrowing: { read: { "$.status": ["succeeded"] } },
    } as const;
    expect(validateProjectionPolicy(policy)).toEqual([
      expect.objectContaining({
        code: "ENUMERABLE_NARROWING",
        operation: "read",
        path: "$.body.status",
      }),
    ]);
    expect(
      validateProjectionPolicy(policy, [
        {
          operation: "read",
          path: "$.body.status",
          code: "ENUMERABLE_NARROWING",
          justification: "The provider deliberately narrows this enum.",
          citation: "EQ4-test-ledger",
          pinnedSequence: [request("read", "/orders/read")],
        },
      ]),
    ).toEqual([]);
  });
});

describe("bounded equivalence sequence generation", () => {
  const model: FiniteStateModel = {
    initial: "draft",
    states: ["draft", "submitted", "approved"],
    transitions: [
      { from: "draft", operation: "submit", to: "submitted" },
      { from: "submitted", operation: "approve", to: "approved" },
      { from: "submitted", operation: "reject", to: "draft" },
    ],
  };

  it("covers every reachable transition deterministically", () => {
    const first = generateModelSequences(model, { maxDepth: 4 });
    const second = generateModelSequences(model, { maxDepth: 4 });
    expect(first).toEqual(second);
    expect(new Set(first.flatMap((sequence) => sequence.coveredTransitions))).toEqual(
      new Set([
        "draft:submit->submitted",
        "submitted:approve->approved",
        "submitted:reject->draft",
      ]),
    );
  });

  it("adds bounded distinguishing suffixes to the transition suite", () => {
    const suite = generateWpSuite(model, { maxDepth: 4 });
    expect(suite.length).toBeGreaterThan(generateModelSequences(model, { maxDepth: 4 }).length);
    expect(suite.every((sequence) => sequence.steps.length <= 4)).toBe(true);
  });

  it("uses the explicit extra-state bound and can include invalid operation probes", () => {
    const bounded = generateModelSequences(model, { extraStates: 2 });
    expect(bounded.every((sequence) => sequence.steps.length <= model.states.length + 3)).toBe(
      true,
    );

    const negative = generateModelSequences(model, { maxDepth: 2, includeNegative: true });
    expect(negative.some((sequence) => sequence.steps.join("/") === "approve")).toBe(true);
    expect(negative.some((sequence) => sequence.steps.join("/") === "submit/submit")).toBe(true);
  });
});

describe("dependent request shrinking", () => {
  it("removes irrelevant requests while retaining a minimal divergence", async () => {
    const sequence: readonly DependentRequest[] = [
      { method: "POST", path: "/orders", body: { id: "one" } },
      { method: "GET", path: "/orders/one", dependsOn: [0] },
      { method: "GET", path: "/health" },
    ];
    const result = await shrinkDivergingSequence(sequence, (candidate) =>
      candidate.some((item) => item.path === "/orders/one"),
    );

    expect(result.map((item) => item.path)).toEqual(["/orders/one"]);
  });

  it("reindexes retained symbolic dependencies after shrinking", async () => {
    const sequence: readonly DependentRequest[] = [
      { method: "GET", path: "/health" },
      { method: "POST", path: "/orders", body: { id: "one" } },
      { method: "GET", path: "/orders/one", dependsOn: [1] },
    ];
    const result = await shrinkDivergingSequence(
      sequence,
      (candidate) => candidate.some((item) => item.path === "/orders/one"),
      { preserveDependencies: true },
    );

    expect(result.map((item) => item.path)).toEqual(["/orders", "/orders/one"]);
    expect(result[1]?.dependsOn).toEqual([0]);
  });
});
