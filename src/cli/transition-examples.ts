import { createHash } from "node:crypto";
import type { Server } from "node:http";
import request, { type Test } from "supertest";
import type { OpenApiDoc, OpenApiOperation } from "../contract/loader.js";
import type { DomainEvent } from "../types.js";
import type { IdentityContext, RuntimeBoundary } from "../model/runtime.js";
import type { RuntimeSystem } from "../runtime/system.js";
import type { Transition, TransitionMachine } from "../model/transitionModel.js";
import type { JsonObject, JsonValue } from "../types.js";
import type { ExportExample } from "./export-examples.js";
import type { createRuntimeGateway } from "../http/runtimeGateway.js";
import { POTEMKIN_SEED } from "../http/potemkinHeaders.js";
import { deterministicUuidv7 } from "../ids/uuidv7.js";
import { ExportError } from "../errors.js";
import type { ExportStatePlan, ExportStep } from "../dsl/types.js";

export type ExportRequestTarget = ReturnType<typeof createRuntimeGateway> | Server;

export interface OperationRoute {
  readonly method: string;
  readonly path: string;
  readonly operation: OpenApiOperation;
  readonly form?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

interface TransitionBranch {
  readonly state: string;
  readonly steps: readonly Transition[];
}

const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

export function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "example";
}

function normalized(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function aggregateAliases(value: string): ReadonlySet<string> {
  const key = normalized(value);
  const aliases = new Set([key]);
  if (key.endsWith("ies")) aliases.add(`${key.slice(0, -3)}y`);
  if (key.endsWith("ie")) aliases.add(`${key.slice(0, -2)}y`);
  if (key.endsWith("s")) aliases.add(key.slice(0, -1));
  return aliases;
}

function sameAggregate(left: string, right: string): boolean {
  const rightAliases = aggregateAliases(right);
  return [...aggregateAliases(left)].some((candidate) => rightAliases.has(candidate));
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function jsonObject(value: unknown): JsonObject {
  return isObject(value) ? (value as JsonObject) : {};
}

export function routesFor(openapi: OpenApiDoc): readonly OperationRoute[] {
  return Object.entries(openapi.paths).flatMap(([path, item]) =>
    Object.entries(item).flatMap(([method, operation]) =>
      operation?.operationId === undefined
        ? []
        : [{ method: method.toUpperCase(), path, operation }],
    ),
  );
}

export function routeFor(
  routes: readonly OperationRoute[],
  operationId: string,
): OperationRoute | undefined {
  return routes.find((route) => route.operation.operationId === operationId);
}

function rawOperation(
  openapi: OpenApiDoc,
  route: OperationRoute,
): Record<string, unknown> | undefined {
  const raw = openapi.raw;
  if (!isObject(raw) || !isObject(raw.paths)) return undefined;
  const pathItem = raw.paths[route.path];
  if (!isObject(pathItem)) return undefined;
  const operation = pathItem[route.method.toLowerCase()];
  return isObject(operation) ? operation : undefined;
}

export function isFormOperation(openapi: OpenApiDoc, route: OperationRoute): boolean {
  const content = rawOperation(openapi, route)?.requestBody;
  if (!isObject(content) || !isObject(content.content)) return false;
  return isObject(content.content[FORM_MEDIA_TYPE]);
}

function primitiveFor(name: string, schema: Record<string, unknown>): JsonValue {
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    const preferred =
      name === "currency" && enumValues.includes("usd")
        ? "usd"
        : enumValues.find((value) => value !== null);
    return (preferred ?? enumValues[0]) as JsonValue;
  }
  if (schema.default !== undefined) return schema.default as JsonValue;
  if (schema.example !== undefined) return schema.example as JsonValue;
  if (name === "currency") return "usd";
  if (name === "payment_method") return "pm_card_visa";
  if (name === "capture_method") return "automatic";
  if (name === "amount" || name === "amount_received" || name === "amount_to_capture") return 2000;
  if (name === "startedAt" || name === "startDate") return "2020-01-01T00:00:00.000Z";
  if (name === "endedAt" || name === "endDate") return "2020-01-02T00:00:00.000Z";
  if (name.toLowerCase().includes("email")) return "export@example.com";
  if (name.toLowerCase().includes("date")) return "2020-01-01T00:00:00.000Z";
  switch (schema.format) {
    case "email":
      return "export@example.com";
    case "uuid":
      return "00000000-0000-7000-8000-000000000001";
    case "date":
      return "2020-01-01";
    case "date-time":
      return "2020-01-01T00:00:00.000Z";
    case "uri":
      return "https://example.com/export";
    default:
      break;
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((value) => value !== "null")
    : schema.type;
  if (type === "integer" || type === "number") {
    return typeof schema.minimum === "number" ? schema.minimum : 1;
  }
  if (type === "boolean") return false;
  return "export";
}

function schemaValue(name: string, schema: unknown, depth = 0): JsonValue {
  if (!isObject(schema) || depth > 6) return "export";
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0)
    return schemaValue(name, schema.oneOf[0], depth + 1);
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0)
    return schemaValue(name, schema.anyOf[0], depth + 1);
  if (isObject(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const result: JsonObject = {};
    for (const [property, propertySchema] of Object.entries(schema.properties)) {
      if (required.has(property))
        result[property] = schemaValue(property, propertySchema, depth + 1);
    }
    return result;
  }
  if (schema.type === "array" || schema.items !== undefined) {
    return schema.items === undefined ? [] : [schemaValue(name, schema.items, depth + 1)];
  }
  return primitiveFor(name, schema);
}

export function requestBody(route: OperationRoute, variant: number): JsonObject {
  const base = jsonObject(schemaValue("body", route.operation.requestBodySchema ?? {}, 0));
  const properties = isObject(route.operation.requestBodySchema?.properties)
    ? route.operation.requestBodySchema.properties
    : {};
  const result = { ...base };
  for (const property of ["targetCalls", "targetConversions"]) {
    if (properties[property] !== undefined && result[property] === undefined)
      result[property] = schemaValue(property, properties[property]);
  }
  if (variant % 2 === 1 && properties.payment_method !== undefined)
    result.payment_method = "pm_card_visa";
  if (properties.capture_method !== undefined)
    result.capture_method = variant >= 2 && variant % 2 === 0 ? "manual" : "automatic";
  return result;
}

function createVariants(route: OperationRoute): readonly JsonObject[] {
  const properties = isObject(route.operation.requestBodySchema?.properties)
    ? route.operation.requestBodySchema.properties
    : {};
  const count =
    properties.payment_method === undefined ? 1 : properties.capture_method === undefined ? 2 : 4;
  return Array.from({ length: count }, (_, index) => requestBody(route, index));
}

export function pathForOperation(
  routes: readonly OperationRoute[],
  operationId: string,
  targetId: string,
): string | undefined {
  const route = routeFor(routes, operationId);
  return route?.path.replace(/\{[^}]+\}/g, encodeURIComponent(targetId));
}

export function byIdPath(
  openapi: OpenApiDoc,
  collectionPath: string,
  id: string,
): string | undefined {
  return Object.entries(openapi.paths)
    .filter(
      ([path, item]) =>
        path.startsWith(`${collectionPath}/`) &&
        /^\/\{[^/}]+\}$/.test(path.slice(collectionPath.length)) &&
        item.get !== undefined,
    )
    .map(([path]) => path.replace(/\{[^}]+\}/g, encodeURIComponent(id)))
    .sort()[0];
}

export function operationRequest(
  app: ExportRequestTarget,
  route: OperationRoute,
  body: JsonObject,
  seed = `potemkin-export:${route.method}:${route.path}:${JSON.stringify(body)}`,
): Test {
  const method = route.method.toLowerCase();
  let result: Test;
  switch (method) {
    case "delete":
      result = request(app).delete(route.path);
      break;
    case "patch":
      result = request(app).patch(route.path);
      break;
    case "put":
      result = request(app).put(route.path);
      break;
    default:
      result = request(app).post(route.path);
      break;
  }
  if (route.headers !== undefined)
    for (const [name, value] of Object.entries(route.headers)) result.set(name, value);
  if (route.headers?.[POTEMKIN_SEED] === undefined) {
    result.set(POTEMKIN_SEED, createHash("sha256").update(seed).digest("hex"));
  }
  return route.form === true ? result.type("form").send(body) : result.send(body);
}

function transitionPaths(
  machine: TransitionMachine,
  start: string,
  target: string,
  excludedOperation: string,
): readonly TransitionBranch[] {
  const queue: TransitionBranch[] = [{ state: start, steps: [] }];
  const result: TransitionBranch[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.state === target) {
      result.push(current);
      continue;
    }
    if (current.steps.length >= 5) continue;
    for (const transition of machine.transitions) {
      if (transition.op === excludedOperation) continue;
      if (!transition.nextStateKnown || transition.to === "UNKNOWN") continue;
      if (transition.from !== "*" && transition.from !== current.state) continue;
      if (current.steps.some((step) => step.op === transition.op && step.to === transition.to))
        continue;
      if ([start, ...current.steps.map((step) => step.to)].includes(transition.to)) continue;
      queue.push({ state: transition.to, steps: [...current.steps, transition] });
    }
  }
  return result.slice(0, 24);
}

async function restoreSeed(
  system: RuntimeSystem,
  boundary: RuntimeBoundary,
  id: string,
  state: JsonObject,
): Promise<void> {
  await system.engine.reset();
  const baseline = system.engine.snapshot();
  const seedEvent: DomainEvent = {
    eventId: `transition-seed-${boundary.boundary}-${id}`,
    type: "BaselineEntityCreatedEvent",
    boundary: boundary.boundary,
    aggregateId: id,
    payload: state,
    timestamp: new Date(system.clock.nowMs()).toISOString(),
    sequenceVersion: 1,
    causedBy: null,
  };
  system.engine.restore({
    state: [...baseline.state, [id, state]],
    events: [...baseline.events, seedEvent],
    projections: baseline.projections,
  });
}

function responseExample(
  system: RuntimeSystem,
  boundary: RuntimeBoundary,
  state: string,
  id: string,
  response: {
    readonly status: number;
    readonly headers: Record<string, string | string[]>;
    readonly body: unknown;
  },
): ExportExample {
  const headers = Object.fromEntries(
    Object.entries(response.headers)
      .filter(
        ([name]) =>
          !new Set([
            "connection",
            "content-length",
            "date",
            "etag",
            "keep-alive",
            "transfer-encoding",
            "x-powered-by",
          ]).has(name.toLowerCase()),
      )
      .map(([name, value]) => [
        name.toLowerCase(),
        Array.isArray(value) ? value.join(", ") : value,
      ]),
  );
  return {
    name: `${safeName(boundary.boundary)}__${safeName(state)}__GET__${safeName(id)}`,
    httpRequest: {
      method: "GET",
      path: byIdPath(system.openapi, boundary.contractPath, id) ?? boundary.contractPath,
    },
    httpResponse: { status: response.status, headers, body: (response.body ?? null) as JsonValue },
  };
}

function stateOf(value: unknown, field: string): string | undefined {
  return isObject(value) && typeof value[field] === "string" ? value[field] : undefined;
}

function rebaseIdentity(value: JsonValue, from: string, to: string): JsonValue {
  if (typeof value === "string") {
    if (value === from) return to;
    if (value.startsWith(`${from}_`)) return `${to}${value.slice(from.length)}`;
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => rebaseIdentity(entry, from, to));
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        rebaseIdentity(entry as JsonValue, from, to),
      ]),
    ) as JsonObject;
  return value;
}

function allocateIdentity(
  system: RuntimeSystem,
  boundary: RuntimeBoundary,
  state: string,
  seedIndex: number,
): string | undefined {
  const generate = boundary.identity?.generate;
  if (generate === undefined) return undefined;
  const command = {
    commandId: `transition-identity-${boundary.boundary}-${state}`,
    boundary: boundary.boundary,
    intent: "creation" as const,
    targetId: null,
    payload: {},
    queryParams: {},
    httpMethod: "POST",
    path: boundary.contractPath,
    origin: "inbound" as const,
    depth: 0,
  };
  return generate({
    boundary: boundary.boundary,
    command,
    request: {
      command,
      headers: {},
      controls: { seed: `potemkin-export-${seedIndex}` },
    },
    state: null,
    payload: {},
    helpers: {
      ...system.program.dependencies.helpers,
      uuid: () => deterministicUuidv7(`potemkin-export-${seedIndex}`),
    },
  } satisfies IdentityContext);
}

function machineBoundary(
  system: RuntimeSystem,
  machine: TransitionMachine,
): RuntimeBoundary | undefined {
  const key = machine.aggregate;
  return system.program.boundaries.find(
    (boundary) =>
      boundary.identity !== undefined &&
      boundary.contractPath.includes("{") === false &&
      sameAggregate(boundary.schema ?? boundary.boundary, key),
  );
}

function createRouteFor(
  routes: readonly OperationRoute[],
  boundary: RuntimeBoundary,
  transition: Transition,
): OperationRoute | undefined {
  const route = routeFor(routes, transition.op);
  return route?.method === "POST" && route.path === boundary.contractPath ? route : undefined;
}

async function capture(
  system: RuntimeSystem,
  app: ExportRequestTarget,
  boundary: RuntimeBoundary,
  state: string,
  id: string,
): Promise<ExportExample | undefined> {
  const path = byIdPath(system.openapi, boundary.contractPath, id);
  if (path === undefined) return undefined;
  const response = await request(app).get(path);
  if (response.status < 200 || response.status >= 300) return undefined;
  return responseExample(system, boundary, state, id, response);
}

function resolveExportValue(value: JsonValue, targetId: string | undefined): JsonValue {
  if (value === "$targetId" && targetId !== undefined) return targetId;
  if (Array.isArray(value)) return value.map((entry) => resolveExportValue(entry, targetId));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveExportValue(entry as JsonValue, targetId),
      ]),
    ) as JsonObject;
  }
  return value;
}

function bodyForExportStep(
  route: OperationRoute,
  step: ExportStep,
  targetId: string | undefined,
): JsonObject {
  const generated = requestBody(route, 0);
  const declared =
    step.body === undefined ? {} : (resolveExportValue(step.body, targetId) as JsonObject);
  return { ...generated, ...declared };
}

function collectionBoundaryForAggregate(
  system: RuntimeSystem,
  boundaryName: string,
): RuntimeBoundary | undefined {
  const direct = system.program.byBoundaryName.get(boundaryName);
  if (direct?.contractPath.includes("{") === false) return direct;
  const source = direct?.schema ?? direct?.contractPath ?? boundaryName;
  const firstSegment = source
    .split("/")
    .filter(Boolean)
    .find((segment) => !/^v\d+$/i.test(segment));
  const aggregate = firstSegment ?? boundaryName;
  return system.program.boundaries.find((candidate) => {
    if (candidate.contractPath.includes("{") || candidate.identity === undefined) return false;
    const segment = candidate.contractPath
      .split("/")
      .filter(Boolean)
      .find((entry) => !/^v\d+$/i.test(entry));
    return sameAggregate(candidate.schema ?? segment ?? candidate.boundary, aggregate);
  });
}

function collectionBoundaryForEvent(
  system: RuntimeSystem,
  event: DomainEvent,
): RuntimeBoundary | undefined {
  if (event.boundary === "__saga__") return undefined;
  return collectionBoundaryForAggregate(system, event.boundary);
}

function baselineAggregateIds(system: RuntimeSystem): ReadonlySet<string> {
  return new Set(
    system.engine
      .snapshot()
      .events.filter((event) => event.eventId.startsWith("baseline-"))
      .map((event) => event.aggregateId),
  );
}

async function captureSideEffects(
  system: RuntimeSystem,
  app: ExportRequestTarget,
  examples: ExportExample[],
  excludedIds: ReadonlySet<string>,
): Promise<void> {
  const seen = new Set([...baselineAggregateIds(system), ...excludedIds]);
  for (const event of system.engine
    .snapshot()
    .events.filter(
      (candidate) =>
        !candidate.eventId.startsWith("baseline-") &&
        !candidate.eventId.startsWith("transition-seed-") &&
        candidate.boundary !== "__saga__",
    )) {
    if (seen.has(event.aggregateId)) continue;
    const boundary = collectionBoundaryForEvent(system, event);
    if (boundary === undefined) continue;
    const example = await capture(system, app, boundary, event.type, event.aggregateId);
    if (example !== undefined) examples.push(example);
    seen.add(event.aggregateId);
  }
}

function expectedMachineState(
  system: RuntimeSystem,
  boundary: RuntimeBoundary,
  requested: string,
): { readonly controlField: string; readonly state: string } | undefined {
  const aggregate = boundary.schema ?? boundary.boundary;
  const machine = system.transitionModel?.machines.find((candidate) =>
    sameAggregate(candidate.aggregate, aggregate),
  );
  if (machine === undefined) return undefined;
  const state = machine.states.find((candidate) => normalized(candidate) === normalized(requested));
  return state === undefined ? undefined : { controlField: machine.controlField, state };
}

async function runDeclaredDirectPlan(
  system: RuntimeSystem,
  app: ExportRequestTarget,
  routes: readonly OperationRoute[],
  boundary: RuntimeBoundary,
  plan: ExportStatePlan,
  targetId: string,
): Promise<readonly ExportExample[] | undefined> {
  const [createStep, ...actions] = plan.steps;
  if (createStep === undefined) return undefined;
  const createRoute = routeFor(routes, createStep.operationId);
  if (createRoute === undefined || createRoute.path !== boundary.contractPath) {
    throw new ExportError(
      `Declared export state ${boundary.boundary}.${plan.name} must start with the boundary creation operation`,
      { boundary: boundary.boundary, state: plan.name, operationId: createStep.operationId },
    );
  }

  await system.engine.reset();
  const created = await operationRequest(
    app,
    {
      ...createRoute,
      form: isFormOperation(system.openapi, createRoute),
      ...(createStep.headers === undefined ? {} : { headers: createStep.headers }),
    },
    bodyForExportStep(createRoute, createStep, undefined),
  );
  if (created.status < 200 || created.status >= 300) return undefined;
  const createdBody = jsonObject(created.body);
  const createdId = typeof createdBody.id === "string" ? createdBody.id : undefined;
  if (createdId === undefined) return undefined;
  const createdState = system.engine.snapshot().state.find(([id]) => id === createdId)?.[1];
  if (createdState === undefined) return undefined;

  await restoreSeed(
    system,
    boundary,
    targetId,
    rebaseIdentity(createdState, createdId, targetId) as JsonObject,
  );
  let finalBody: JsonObject = createdBody;
  for (const step of actions) {
    const route = routeFor(routes, step.operationId);
    if (route === undefined) {
      throw new ExportError(`Declared export references unknown operation ${step.operationId}`, {
        boundary: boundary.boundary,
        state: plan.name,
        operationId: step.operationId,
      });
    }
    const path = pathForOperation(routes, step.operationId, targetId) ?? route.path;
    const response = await operationRequest(
      app,
      {
        ...route,
        path,
        form: isFormOperation(system.openapi, route),
        ...(step.headers === undefined ? {} : { headers: step.headers }),
      },
      bodyForExportStep(route, step, targetId),
    );
    if (response.status < 200 || response.status >= 300) return undefined;
    finalBody = jsonObject(response.body);
  }

  const expected = expectedMachineState(system, boundary, plan.name);
  if (expected !== undefined && stateOf(finalBody, expected.controlField) !== expected.state)
    return undefined;
  const primary = await capture(system, app, boundary, plan.name, targetId);
  if (primary === undefined) return undefined;
  const examples = [primary];
  await captureSideEffects(system, app, examples, new Set([targetId]));
  return examples;
}

async function runDeclaredSagaPlan(
  system: RuntimeSystem,
  app: ExportRequestTarget,
  routes: readonly OperationRoute[],
  boundary: RuntimeBoundary,
  plan: ExportStatePlan,
): Promise<readonly ExportExample[] | undefined> {
  const saga = system.program.policies.sagas?.find((candidate) => candidate.name === plan.saga);
  if (saga === undefined) {
    throw new ExportError(`Declared export references unknown saga ${plan.saga ?? ""}`, {
      boundary: boundary.boundary,
      state: plan.name,
      ...(plan.saga === undefined ? {} : { saga: plan.saga }),
    });
  }
  const finalStep = saga.steps[saga.steps.length - 1];
  if (finalStep === undefined) return undefined;
  await system.engine.reset();
  let targetId: string | undefined;
  for (const step of plan.steps) {
    const route = routeFor(routes, step.operationId);
    if (route === undefined) {
      throw new ExportError(
        `Declared saga export references unknown operation ${step.operationId}`,
        {
          boundary: boundary.boundary,
          state: plan.name,
          operationId: step.operationId,
          ...(plan.saga === undefined ? {} : { saga: plan.saga }),
        },
      );
    }
    if (route.path.includes("{") && targetId === undefined) return undefined;
    const response = await operationRequest(
      app,
      {
        ...route,
        path:
          targetId === undefined
            ? route.path
            : (pathForOperation(routes, step.operationId, targetId) ?? route.path),
        form: isFormOperation(system.openapi, route),
        ...(step.headers === undefined ? {} : { headers: step.headers }),
      },
      bodyForExportStep(route, step, targetId),
    );
    if (response.status < 200 || response.status >= 300) return undefined;
    const responseBody = jsonObject(response.body);
    if (targetId === undefined && typeof responseBody.id === "string") targetId = responseBody.id;
  }
  if (targetId === undefined) return undefined;

  const targetEvent = [...system.engine.snapshot().events]
    .reverse()
    .find(
      (event) =>
        event.boundary === finalStep.boundary &&
        event.type !== "BaselineEntityCreatedEvent" &&
        event.type !== "SagaStarted" &&
        event.type !== "SagaStepCompleted",
    );
  if (targetEvent === undefined) return undefined;
  const targetBoundary = collectionBoundaryForAggregate(system, finalStep.boundary);
  if (targetBoundary === undefined) return undefined;
  const primary = await capture(system, app, targetBoundary, plan.name, targetEvent.aggregateId);
  if (primary === undefined) return undefined;
  const examples = [primary];
  await captureSideEffects(system, app, examples, new Set([targetEvent.aggregateId]));
  return examples;
}

/** Replay explicit export plans through the live gateway. */
export async function collectDeclaredExportExamples(
  system: RuntimeSystem,
  app: ExportRequestTarget,
): Promise<readonly ExportExample[]> {
  const routes = routesFor(system.openapi);
  const examples = new Map<string, ExportExample>();
  let seedIndex = 10_000;
  try {
    for (const boundary of system.program.boundaries) {
      const config = boundary.export;
      if (config === undefined) continue;
      if (boundary.contractPath.includes("{") || boundary.identity?.generate === undefined) {
        throw new ExportError(
          `Declared export boundary ${boundary.boundary} must be a collection with an identity generator`,
          { boundary: boundary.boundary },
        );
      }
      for (const plan of config.states) {
        const captured =
          plan.saga === undefined
            ? await (async () => {
                const targetId = allocateIdentity(system, boundary, plan.name, seedIndex++);
                if (targetId === undefined) {
                  throw new ExportError(
                    `Declared export boundary ${boundary.boundary} has no usable identity generator`,
                    { boundary: boundary.boundary, state: plan.name },
                  );
                }
                return runDeclaredDirectPlan(system, app, routes, boundary, plan, targetId);
              })()
            : await runDeclaredSagaPlan(system, app, routes, boundary, plan);
        if (captured === undefined) {
          console.warn(
            `Declared export coverage: unable to reach ${boundary.boundary}.${plan.name}`,
          );
          continue;
        }
        for (const example of captured) examples.set(example.name, example);
      }
    }
  } finally {
    await system.engine.reset();
  }
  return [...examples.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function runTarget(
  system: RuntimeSystem,
  app: ExportRequestTarget,
  machine: TransitionMachine,
  boundary: RuntimeBoundary,
  create: OperationRoute,
  target: string,
  targetId: string,
): Promise<readonly ExportExample[] | undefined> {
  for (const [variant, body] of createVariants(create).entries()) {
    await system.engine.reset();
    const created = await operationRequest(
      app,
      { ...create, form: isFormOperation(system.openapi, create) },
      body,
    );
    if (created.status < 200 || created.status >= 300) continue;
    const createdBody = jsonObject(created.body);
    const id = typeof createdBody.id === "string" ? createdBody.id : undefined;
    if (id === undefined) continue;
    const createdState = system.engine.snapshot().state.find(([entryId]) => entryId === id)?.[1];
    if (createdState === undefined) continue;
    const current =
      stateOf(createdState, machine.controlField) ?? stateOf(createdBody, machine.controlField);
    if (current === undefined) continue;
    const branches = transitionPaths(machine, current, target, create.operation.operationId!);
    for (const branch of branches) {
      const rebasedState = rebaseIdentity(createdState, id, targetId) as JsonObject;
      const seededState =
        (target === "QUALIFIED" || target === "CONVERTED") &&
        normalized(machine.aggregate) === "lead"
          ? { ...rebasedState, callIds: ["00000000-0000-7000-8000-000000000010"] }
          : rebasedState;
      await restoreSeed(system, boundary, targetId, seededState);
      let reached = current;
      let actionFailed = false;
      for (const transition of branch.steps) {
        const action = routeFor(routesFor(system.openapi), transition.op);
        if (action === undefined) {
          actionFailed = true;
          break;
        }
        const path = pathForOperation(routesFor(system.openapi), transition.op, targetId);
        if (path === undefined) {
          actionFailed = true;
          break;
        }
        const actionResponse = await operationRequest(
          app,
          {
            ...action,
            path,
            form: isFormOperation(system.openapi, action),
            ...(transition.op === "dncLead"
              ? { headers: { "x-potemkin-actor": "export:manager" } }
              : {}),
          },
          requestBody(action, variant),
        );
        if (actionResponse.status < 200 || actionResponse.status >= 300) {
          actionFailed = true;
          break;
        }
        reached = stateOf(actionResponse.body, machine.controlField) ?? transition.to;
      }
      if (actionFailed || reached !== target) continue;
      const primary = await capture(system, app, boundary, target, targetId);
      if (primary === undefined) continue;

      const examples = [primary];
      const seen = new Set([...baselineAggregateIds(system), targetId]);
      for (const event of system.engine
        .snapshot()
        .events.filter(
          (candidate) =>
            !candidate.eventId.startsWith("baseline-") && candidate.aggregateId !== targetId,
        )) {
        if (seen.has(event.aggregateId)) continue;
        const sideBoundary = system.program.byBoundaryName.get(event.boundary);
        if (sideBoundary === undefined) continue;
        const sideExample = await capture(system, app, sideBoundary, event.type, event.aggregateId);
        if (sideExample !== undefined) examples.push(sideExample);
        seen.add(event.aggregateId);
      }
      return examples;
    }
  }
  return undefined;
}

/** Walk known transition-model states through the live gateway for export. */
export async function collectTransitionExamples(
  system: RuntimeSystem,
  app: ExportRequestTarget,
): Promise<readonly ExportExample[]> {
  const model = system.transitionModel;
  if (model === undefined) return [];
  const routes = routesFor(system.openapi);
  const examples = new Map<string, ExportExample>();
  let identitySeedIndex = 0;
  try {
    for (const machine of model.machines) {
      const boundary = machineBoundary(system, machine);
      if (boundary === undefined) {
        console.warn(`Transition export coverage: no identity boundary for ${machine.aggregate}`);
        continue;
      }
      if (boundary.export !== undefined) continue;
      const createTransitions = machine.transitions.filter(
        (transition) => transition.nextStateKnown,
      );
      const create = createTransitions
        .map((transition) => ({ transition, route: createRouteFor(routes, boundary, transition) }))
        .find((entry) => entry.route !== undefined);
      if (create === undefined) {
        console.warn(`Transition export coverage: no creation operation for ${machine.aggregate}`);
        continue;
      }
      for (const target of machine.states.filter((state) => state !== "UNKNOWN").sort()) {
        const targetId = allocateIdentity(system, boundary, target, identitySeedIndex++);
        if (targetId === undefined) {
          console.warn(
            `Transition export coverage: no identity generator for ${machine.aggregate}.${target}`,
          );
          continue;
        }
        const captured = await runTarget(
          system,
          app,
          machine,
          boundary,
          create.route!,
          target,
          targetId,
        );
        if (captured === undefined) {
          console.warn(
            `Transition export coverage: unable to reach ${machine.aggregate}.${target}`,
          );
          continue;
        }
        for (const example of captured) examples.set(example.name, example);
      }
    }
  } finally {
    await system.engine.reset();
  }
  return [...examples.values()].sort((left, right) => left.name.localeCompare(right.name));
}
