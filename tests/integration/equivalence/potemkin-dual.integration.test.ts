import { bootYamlRuntimeFromConfig } from "../../../src/parser/files.js";
import { createRuntimeGateway } from "../../../src/http/runtimeGateway.js";
import { createDeterministicRuntimeHost } from "../../../src/runtime/host.js";
import { loadPotemkinConfig } from "../../../src/parser/configLoader.js";
import { buildConfiguredTransitionModel } from "../../../src/parser/transitionModel.js";
import { createSymbolicDualRunner } from "../../equivalence/dualRunner.js";
import type { SymbolicSequenceStep } from "../../equivalence/dualRunner.js";
import { createRealApiEndpoint } from "../../equivalence/realApi.js";
import {
  deriveModelMetamorphicRelations,
  runModelMetamorphicRelation,
  type ModelMetamorphicRequestFactory,
} from "../../equivalence/modelMetamorphic.js";
import {
  generateTransitionModelSequences,
  type ModelDrivenSequence,
} from "../../equivalence/modelGenerator.js";
import {
  isFormOperation,
  requestBody,
  routeFor,
  routesFor,
} from "../../../src/cli/transition-examples.js";
import { loadEngineFixture, type EngineFixture } from "../../fixtures/index.js";
import { withPersistentServer, type PersistentServer } from "../../_support/persistentAgent.js";
import type { JsonObject, JsonValue } from "../../../src/types.js";
import type { EquivalenceRequest, EquivalenceWriteSet } from "../../equivalence/types.js";
import type { TransitionMachine } from "../../../src/model/transitionModel.js";

function baseUrl(server: PersistentServer): string {
  const address = server.server.address();
  if (address === null || typeof address === "string")
    throw new Error("Potemkin server has no port");
  return `http://127.0.0.1:${address.port}`;
}

describe("EQ2 live Potemkin dual runner", () => {
  let fixture: EngineFixture;
  let first: Awaited<ReturnType<typeof bootYamlRuntimeFromConfig>>;
  let second: Awaited<ReturnType<typeof bootYamlRuntimeFromConfig>>;
  let firstServer: PersistentServer;
  let secondServer: PersistentServer;

  beforeAll(async () => {
    fixture = await loadEngineFixture("crm");
    const host = () =>
      createDeterministicRuntimeHost({
        epochMs: 0,
        randomSeed: "eq2-potemkin-dual",
        uuidSeedIndex: 0,
      });
    first = await bootYamlRuntimeFromConfig({ ...fixture, host: host() });
    second = await bootYamlRuntimeFromConfig({ ...fixture, host: host() });
    firstServer = await withPersistentServer(createRuntimeGateway(first));
    secondServer = await withPersistentServer(createRuntimeGateway(second));
  }, 120_000);

  afterAll(async () => {
    await Promise.all([firstServer?.close(), secondServer?.close()]);
    await Promise.all([first?.dispose(), second?.dispose()]);
  });

  it("runs one symbolic create/read trace through both live Potemkin instances", async () => {
    const absentId = "00000000-0000-7000-8000-0000deadbeef";
    const sequence: readonly SymbolicSequenceStep[] = [
      {
        operation: "createLead",
        request: {
          method: "POST",
          path: "/leads",
          body: {
            companyName: "EQ2 Corp",
            contactName: "Ada Lovelace",
            phone: "+61 400 000 001",
            email: "ada@example.com",
            source: "WEBSITE",
          },
        },
        captures: [{ symbol: "lead", responsePath: "$.id" }],
        mutating: true,
        preStateRequest: { method: "GET", path: `/leads/${absentId}` },
      },
      {
        operation: "getLead",
        request: { method: "GET", path: "/leads/{{lead}}" },
      },
      {
        operation: "qualifyLeadWithoutContact",
        request: { method: "POST", path: "/leads/{{lead}}/qualify" },
        mutating: true,
        preStateRequest: { method: "GET", path: "/leads/{{lead}}" },
      },
    ];
    const result = await createSymbolicDualRunner({
      modelBaseUrl: baseUrl(firstServer),
      realBaseUrl: baseUrl(secondServer),
      policy: {
        ignoredHeaders: ["connection", "date", "keep-alive", "transfer-encoding", "content-length"],
      },
    }).run(sequence);

    expect(result.verdict).toBe("CONFORMS");
    expect(result.steps).toHaveLength(3);
    const created = result.steps[0];
    if (created === undefined) throw new Error("EQ2 create step was not recorded");
    const modelId = (created.model.body as { id: string }).id;
    const realId = (created.real.body as { id: string }).id;
    expect(result.comparison.identifiers.modelToReal[modelId]).toBe(realId);
  });

  it("executes generated positive CRM traces through both live Potemkin instances", async () => {
    const loaded = await loadPotemkinConfig(fixture.potemkinConfigPath, {
      openapi: fixture.openapi,
    });
    const model = await buildConfiguredTransitionModel(loaded.yamlProgram, fixture.openapi);
    const machine = model.machines.find((candidate) => candidate.aggregate === "Lead");
    if (machine === undefined) throw new Error("Generated CRM proof requires the Lead machine");

    const generated = generateTransitionModelSequences(model, { maxDepth: 3 })
      .filter(
        (sequence) =>
          sequence.aggregate === "Lead" &&
          sequence.steps.length > 0 &&
          sequence.steps.every((step) => step.negative !== true),
      )
      .slice(0, 17);
    expect(generated.length).toBeGreaterThanOrEqual(3);
    expect(generated.every((sequence) => sequence.steps[0]?.operation === "createLead")).toBe(true);

    const sequences = generated.map((sequence) => toSymbolicSequence(sequence, machine, fixture));
    const result = await createSymbolicDualRunner({
      modelBaseUrl: baseUrl(firstServer),
      realBaseUrl: baseUrl(secondServer),
      policy: {
        ignoredHeaders: ["connection", "date", "keep-alive", "transfer-encoding", "content-length"],
        shapeOnlyPaths: ["$.updatedAt", "$.updatedBy"],
      },
    }).runMany(sequences);

    expect(result).toHaveLength(sequences.length);
    expect(
      result.map((run, index) => ({
        operations: generated[index]?.steps.map((step) => step.operation),
        verdict: run.verdict,
        divergence: run.divergences[0],
      })),
    ).toEqual(
      Array.from({ length: sequences.length }, (_, index) => ({
        operations: generated[index]?.steps.map((step) => step.operation),
        verdict: "CONFORMS",
        divergence: undefined,
      })),
    );
  }, 120_000);
});

describe("generated Stripe equivalence", () => {
  let fixture: EngineFixture;
  let first: Awaited<ReturnType<typeof bootYamlRuntimeFromConfig>>;
  let second: Awaited<ReturnType<typeof bootYamlRuntimeFromConfig>>;
  let firstServer: PersistentServer;
  let secondServer: PersistentServer;

  beforeAll(async () => {
    fixture = await loadEngineFixture("stripe");
    const host = () =>
      createDeterministicRuntimeHost({
        epochMs: 0,
        randomSeed: "eq3-stripe-dual",
        uuidSeedIndex: 0,
      });
    first = await bootYamlRuntimeFromConfig({ ...fixture, host: host() });
    second = await bootYamlRuntimeFromConfig({ ...fixture, host: host() });
    firstServer = await withPersistentServer(createRuntimeGateway(first));
    secondServer = await withPersistentServer(createRuntimeGateway(second));
  }, 120_000);

  afterAll(async () => {
    await Promise.all([firstServer?.close(), secondServer?.close()]);
    await Promise.all([first?.dispose(), second?.dispose()]);
  });

  it("executes every generated positive Stripe trace through both live runtimes", async () => {
    const loaded = await loadPotemkinConfig(fixture.potemkinConfigPath, {
      openapi: fixture.openapi,
    });
    const model = await buildConfiguredTransitionModel(loaded.yamlProgram, fixture.openapi);
    const generated = generateTransitionModelSequences(model, { maxDepth: 3 }).filter(
      (sequence) =>
        sequence.steps.length > 0 && sequence.steps.every((step) => step.negative !== true),
    );
    expect(generated.length).toBeGreaterThanOrEqual(30);

    const sequences = generated.map((sequence) => {
      const machine = model.machines.find(
        (candidate) => candidate.aggregate === sequence.aggregate,
      );
      if (machine === undefined)
        throw new Error(`Generated Stripe sequence has no machine: ${sequence.aggregate}`);
      const symbolic = toSymbolicSequence(sequence, machine, fixture);
      return sequence.aggregate === "Refund"
        ? [...paymentIntentChargePrerequisite(fixture), ...withCharge(symbolic)]
        : symbolic;
    });
    const result = await createSymbolicDualRunner({
      modelBaseUrl: baseUrl(firstServer),
      realBaseUrl: baseUrl(secondServer),
      policy: {
        ignoredHeaders: ["connection", "date", "keep-alive", "transfer-encoding", "content-length"],
      },
    }).runMany(sequences);

    expect(result).toHaveLength(sequences.length);
    expect(result.every((run) => run.verdict === "CONFORMS")).toBe(true);
  }, 120_000);
});

describe("model-derived live metamorphic relations", () => {
  it("executes a proven cross-aggregate commutativity relation against live Potemkin", async () => {
    const fixture = await loadEngineFixture("crm");
    const loaded = await loadPotemkinConfig(fixture.potemkinConfigPath, {
      openapi: fixture.openapi,
    });
    const model = await buildConfiguredTransitionModel(loaded.yamlProgram, fixture.openapi);
    const requests: ModelMetamorphicRequestFactory = {
      requestFor: (machine, operation) => {
        if (machine.aggregate === "Agent" && operation === "updateAgentStatus") {
          return {
            method: "POST",
            path: "/agents/00000000-0000-7000-8000-000000000003/status",
            body: { currentStatus: "BREAK" },
            operation,
          };
        }
        if (machine.aggregate === "Campaign" && operation === "getCampaign") {
          return {
            method: "GET",
            path: "/campaigns/00000000-0000-7000-8000-000000000001",
            operation,
          };
        }
        return undefined;
      },
    };
    const relation = deriveModelMetamorphicRelations(model, requests).find(
      (candidate) => candidate.name === "commutes:Agent:updateAgentStatus|Campaign:getCampaign",
    );
    if (relation === undefined)
      throw new Error("Expected CRM commutativity relation was not derived");

    let system: Awaited<ReturnType<typeof bootYamlRuntimeFromConfig>> | undefined;
    let server: PersistentServer | undefined;
    try {
      const liveTarget = {
        reset: async (): Promise<void> => {
          await server?.close();
          await system?.dispose();
          system = await bootYamlRuntimeFromConfig({
            ...fixture,
            host: createDeterministicRuntimeHost({
              epochMs: 0,
              randomSeed: "eq5-live-metamorphic",
              uuidSeedIndex: 0,
            }),
          });
          server = await withPersistentServer(createRuntimeGateway(system));
        },
        execute: async (requestsToExecute: readonly EquivalenceRequest[]) => {
          if (server === undefined) throw new Error("Metamorphic target server is not running");
          const address = server.server.address();
          if (address === null || typeof address === "string")
            throw new Error("Metamorphic target server has no port");
          const endpoint = createRealApiEndpoint({ baseUrl: `http://127.0.0.1:${address.port}` });
          const responses = [];
          for (const [index, request] of requestsToExecute.entries()) {
            responses.push(
              await endpoint.execute(request, {
                index,
                operation: request.operation ?? request.path,
              }),
            );
          }
          return responses;
        },
      };
      const result = await runModelMetamorphicRelation(relation, liveTarget);
      expect(result.divergences).toEqual([]);
    } finally {
      await server?.close();
      await system?.dispose();
    }
  }, 120_000);
});

function toSymbolicSequence(
  sequence: ModelDrivenSequence,
  machine: TransitionMachine,
  fixture: EngineFixture,
): readonly SymbolicSequenceStep[] {
  const routes = routesFor(fixture.openapi);
  const symbols = new Map<string, string>();
  const absentId = "00000000-0000-7000-8000-0000deadbeef";
  return sequence.steps.map((step) => {
    const route = routeFor(routes, step.operation);
    if (route === undefined)
      throw new Error(`Generated operation has no OpenAPI route: ${step.operation}`);
    const target = step.targetRef;
    const symbol = target === undefined ? undefined : symbolFor(target, symbols);
    const path =
      symbol === undefined ? route.path : route.path.replace(/\{[^}]+\}/g, `{{${symbol}}}`);
    const properties =
      route.operation.requestBodySchema?.properties !== null &&
      typeof route.operation.requestBodySchema?.properties === "object" &&
      !Array.isArray(route.operation.requestBodySchema?.properties)
        ? (route.operation.requestBodySchema.properties as JsonObject)
        : undefined;
    const input = Object.fromEntries(
      Object.entries(step.input).filter(([name]) => properties?.[name] !== undefined),
    );
    const body = representativeBody(route, { ...requestBody(route, 0), ...input });
    const mutating = route.method !== "GET";
    const preStatePath = byIdPath(
      routes,
      route.path,
      route.path.includes("{") && symbol !== undefined ? symbol : absentId,
    );
    const form = isFormOperation(fixture.openapi, route);
    return {
      operation: step.operation,
      request: {
        method: route.method,
        path,
        ...(route.method === "GET" ? {} : { body }),
        ...(form ? { bodyEncoding: "form" as const } : {}),
      },
      ...(target === undefined || symbol === undefined || route.path.includes("{")
        ? {}
        : { captures: [{ symbol, responsePath: "$.id" }] }),
      ...(mutating
        ? {
            mutating: true,
            preStateRequest: { method: "GET", path: preStatePath },
          }
        : {}),
      ...(writeSet(machine.writeSets[step.operation])
        ? { writeSet: machine.writeSets[step.operation] }
        : {}),
    } satisfies SymbolicSequenceStep;
  });
}

function byIdPath(
  routes: readonly ReturnType<typeof routesFor>[number][],
  operationPath: string,
  symbol: string,
): string {
  const segments = operationPath.split("/").filter(Boolean);
  const parameterIndex = segments.findIndex((segment) => segment.startsWith("{"));
  const collectionSegments =
    parameterIndex < 0 ? segments : segments.slice(0, Math.max(1, parameterIndex));
  const collectionPath = `/${collectionSegments.join("/") || "leads"}`;
  const route = routes.find(
    (candidate) =>
      candidate.method === "GET" &&
      candidate.path.startsWith(`${collectionPath}/`) &&
      candidate.path.includes("{") &&
      !candidate.path.endsWith("/contact") &&
      !candidate.path.endsWith("/qualify"),
  );
  return (route?.path ?? `${collectionPath}/{id}`).replace(
    /\{[^}]+\}/g,
    symbol.startsWith("{{") ? symbol : `{{${symbol}}}`,
  );
}

function representativeBody(
  route: ReturnType<typeof routesFor>[number],
  body: JsonObject,
): JsonObject {
  if (route.method !== "POST" || route.path.includes("{")) return body;
  const properties = route.operation.requestBodySchema?.properties;
  if (
    properties === undefined ||
    properties === null ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return body;
  const additions: JsonObject = {};
  const defaults: Readonly<Record<string, JsonValue>> = {
    email: "equivalence@example.com",
    name: "Equivalence",
    amount: 2000,
    currency: "usd",
    product: "prod_equivalence",
    charge: "ch_equivalence",
    payment_method: "pm_card_visa",
  };
  const objectProperties = properties as JsonObject;
  for (const [name, value] of Object.entries(defaults)) {
    if (objectProperties[name] !== undefined && body[name] === undefined) additions[name] = value;
  }
  return { ...body, ...additions };
}

function paymentIntentChargePrerequisite(fixture: EngineFixture): readonly SymbolicSequenceStep[] {
  const routes = routesFor(fixture.openapi);
  const create = routeFor(routes, "PostPaymentIntents");
  const confirm = routeFor(routes, "PostPaymentIntentsIntentConfirm");
  if (create === undefined || confirm === undefined)
    throw new Error("Stripe refund equivalence requires payment-intent create and confirm routes");
  const intent = "paymentIntent";
  return [
    {
      operation: create.operation.operationId!,
      request: {
        method: create.method,
        path: create.path,
        body: { amount: 2000, currency: "usd", payment_method: "pm_card_visa" },
        bodyEncoding: "form",
      },
      captures: [{ symbol: intent, responsePath: "$.id" }],
      mutating: true,
      preStateRequest: {
        method: "GET",
        path: byIdPath(routes, create.path, "00000000-0000-7000-8000-0000deadbeef"),
      },
    },
    {
      operation: confirm.operation.operationId!,
      request: {
        method: confirm.method,
        path: confirm.path.replace(/\{[^}]+\}/g, `{{${intent}}}`),
        body: {},
        bodyEncoding: "form",
      },
      captures: [{ symbol: "charge", responsePath: "$.latest_charge" }],
      mutating: true,
      preStateRequest: { method: "GET", path: byIdPath(routes, confirm.path, intent) },
    },
  ];
}

function withCharge(sequence: readonly SymbolicSequenceStep[]): readonly SymbolicSequenceStep[] {
  const first = sequence[0];
  if (first === undefined || first.request.body === undefined)
    throw new Error("Stripe refund equivalence requires a refund request body");
  return [
    {
      ...first,
      request: {
        ...first.request,
        body: { ...(first.request.body as JsonObject), charge: "{{charge}}" },
      },
    },
    ...sequence.slice(1),
  ];
}

function symbolFor(target: string, symbols: Map<string, string>): string {
  const current = symbols.get(target);
  if (current !== undefined) return current;
  const symbol = `lead${symbols.size + 1}`;
  symbols.set(target, symbol);
  return symbol;
}

function writeSet(value: EquivalenceWriteSet | undefined): value is EquivalenceWriteSet {
  return value !== undefined;
}
