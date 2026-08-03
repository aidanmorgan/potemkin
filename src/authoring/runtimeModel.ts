import type { DeepReadonly, JsonObject, JsonValue } from "../types.js";
import { compileRuntime } from "../model/compiler.js";
import type { RuntimeDefinition, RuntimeModel } from "../model/index.js";
import type {
  MatchContext,
  EventContext,
  FaultContext,
  IdentityContext,
  ProjectionContext,
  QueryContext,
  ResponseContext,
  RuntimeBehavior,
  RuntimeBoundary,
  RuntimeDependencies,
  RuntimeDerivedProjection,
  RuntimeEvent,
  RuntimeFault,
  RuntimeGuard,
  RuntimeHelperDefinition,
  RuntimePolicies,
  RuntimePredicate,
  RuntimeReaction,
  RuntimeReducer,
  RuntimeReducerContext,
  RuntimeResponse,
  RuntimeResponsePolicy,
  RuntimeSaga,
  RuntimeSecondaryCommand,
  RuntimeWebhook,
  RuntimeValue,
  SagaContext,
  WebhookContext,
} from "../model/runtime.js";
import type { OpenApiDoc } from "../contract/loader.js";
import { expandResources, type ResourceDefinition } from "./resourceModel.js";
import type { TypeScriptHelperRegistration } from "./helpers.js";
import { definitionError, TypeScriptAuthoringError } from "./errors.js";
import { runtimeLatencyProblem } from "../model/latency.js";
import {
  composeBoundaries,
  type ComponentInclude,
  type ComposableBoundary,
  type UseDefinition,
} from "./composition.js";
import type {
  BoundaryName,
  ContractPath,
  EventType,
  FieldPath,
  HttpMethod,
  OperationId,
  SchemaReference,
} from "./references.js";

export type { RuntimeHelperDefinition };

/**
 * The direct authoring model.
 *
 * These interfaces deliberately describe the runtime projection rather than
 * the YAML grammar. A value which is dynamic is a typed callback; there are no
 * CEL expressions, source-specific references, YAML field names, or parser registries in
 * this model.
 */
export interface EventDefinition extends Omit<RuntimeEvent, "payload" | "type" | "schemaRef"> {
  readonly type: EventType;
  readonly schemaRef?: SchemaReference;
  readonly payload: Readonly<Record<string, RuntimeValue<EventContext, JsonValue>>>;
}

/** Event definition retaining the authored payload expressions for IDE inference. */
export type TypedEventDefinition<
  EventPayload extends object,
  CommandPayload extends object = JsonObject,
  State extends object = JsonObject,
> = EventDefinition & {
  readonly payload: Readonly<{
    [Key in keyof EventPayload]: RuntimeValue<
      TypedEventContext<CommandPayload, State>,
      EventPayload[Key]
    >;
  }>;
};

export interface BehaviorDefinition extends Omit<
  RuntimeBehavior,
  "operationId" | "emit" | "emitWhen" | "dispatchCommands" | "method"
> {
  readonly operationId: OperationId;
  readonly method?: HttpMethod;
  readonly emit?: EventType;
  readonly emitWhen?: readonly (Omit<NonNullable<RuntimeBehavior["emitWhen"]>[number], "event"> & {
    readonly event: EventType;
  })[];
  readonly dispatchCommands?: readonly (Omit<
    RuntimeSecondaryCommand,
    "boundary" | "operationId"
  > & {
    readonly boundary: BoundaryName;
    readonly operationId: OperationId;
  })[];
}
export interface ReducerDefinition extends Omit<RuntimeReducer, "on"> {
  readonly on: EventType;
}
export type GuardDefinition = RuntimeGuard;
export type SecondaryCommandDefinition = NonNullable<
  BehaviorDefinition["dispatchCommands"]
>[number];
export type IdentityDefinition = NonNullable<RuntimeBoundary["identity"]>;
export type ResponseDefinition = RuntimeResponsePolicy;
export type FaultDefinition = RuntimeFault;
export type ReactionDefinition = RuntimeReaction;
export type WebhookDefinition = RuntimeWebhook;
export type SagaDefinition = RuntimeSaga;
export type ProjectionDefinition = RuntimeDerivedProjection;
export type BoundaryDefinition = Omit<
  ComposableBoundary,
  "boundary" | "contractPath" | "schema" | "eventCatalog" | "behaviors" | "reducers" | "mask"
> & {
  readonly boundary: BoundaryName;
  readonly contractPath: ContractPath;
  readonly schema?: SchemaReference;
  readonly eventCatalog: readonly EventDefinition[];
  readonly behaviors: readonly BehaviorDefinition[];
  readonly reducers: readonly ReducerDefinition[];
  readonly mask?: readonly FieldPath[];
};
export type GlobalDefinition = RuntimePolicies;

export interface SimulationDefinition {
  readonly boundaries: readonly BoundaryDefinition[];
  readonly resources?: readonly ResourceDefinition[];
  readonly policies?: GlobalDefinition;
  readonly uses?: readonly UseDefinition[];
  readonly helpers?: readonly RuntimeHelperDefinition[];
}

export type AuthoringValue<Context, Value> = RuntimeValue<Context, Value>;
export type AuthoringPredicate<Context> = RuntimePredicate<Context>;

/** Context views that retain the payload's TypeScript shape while remaining
 * backed by the source-independent runtime contexts. */
export type TypedMatchContext<Payload extends object, State extends object = JsonObject> = Omit<
  MatchContext,
  "payload" | "state"
> & {
  readonly payload: DeepReadonly<Payload>;
  readonly state: DeepReadonly<State> | null;
};

export type TypedEventContext<Payload extends object, State extends object = JsonObject> = Omit<
  EventContext,
  "payload" | "state"
> & {
  readonly payload: DeepReadonly<Payload>;
  readonly state: DeepReadonly<State> | null;
};

export type TypedReducerContext<Payload extends object, State extends object = JsonObject> = Omit<
  RuntimeReducerContext,
  "event" | "payload" | "state"
> & {
  readonly state: DeepReadonly<State>;
  readonly payload: DeepReadonly<Payload>;
  readonly event: Omit<RuntimeReducerContext["event"], "payload"> & {
    readonly payload: DeepReadonly<Payload>;
  };
};

export type ExpressionPhase =
  | "behavior"
  | "event"
  | "identity"
  | "reducer"
  | "query"
  | "response"
  | "post-commit"
  | "fault"
  | "webhook"
  | "saga"
  | "projection";

/** A phase-labelled callback is still an ordinary callable TypeScript value. */
export type Expression<Context, Value, Phase extends ExpressionPhase = ExpressionPhase> = ((
  context: Readonly<Context>,
) => Value) &
  Readonly<{ phase: Phase }>;

export type QueryExpression = RuntimePredicate<QueryContext>;
export type ResponseExpression = RuntimeValue<ResponseContext, RuntimeResponse | null | undefined>;
export type EventHydrationExpression = RuntimeValue<EventContext, JsonValue>;
export type ReducerExpression = RuntimeValue<RuntimeReducerContext, JsonValue>;
export type IdentityExpression = RuntimeValue<IdentityContext, string>;
export type FaultExpression = RuntimePredicate<FaultContext>;
export type WebhookExpression = RuntimeValue<WebhookContext, string>;
export type SagaExpression = RuntimeValue<SagaContext, string | null>;
export type ProjectionExpression = RuntimeValue<ProjectionContext, string>;

export function expression<Context, Value, Phase extends ExpressionPhase>(
  phase: Phase,
  callback: (context: Readonly<Context>) => Value,
): Expression<Context, Value, Phase> {
  return Object.assign(callback, { phase }) as Expression<Context, Value, Phase>;
}

export function query(predicate: QueryExpression): QueryExpression {
  return predicate;
}

export function all<Context>(
  ...predicates: readonly RuntimePredicate<Context>[]
): RuntimePredicate<Context> {
  return (context) => predicates.every((predicate) => predicate(context));
}

export function any<Context>(
  ...predicates: readonly RuntimePredicate<Context>[]
): RuntimePredicate<Context> {
  return (context) => predicates.some((predicate) => predicate(context));
}

export function not<Context>(predicate: RuntimePredicate<Context>): RuntimePredicate<Context> {
  return (context) => !predicate(context);
}

export function pipe<Input, Output>(input: Input, step: (value: Input) => Output): Output;
export function pipe<Input, A, Output>(
  input: Input,
  first: (value: Input) => A,
  second: (value: A) => Output,
): Output;
export function pipe<Input, Output>(
  input: Input,
  ...steps: readonly ((value: unknown) => unknown)[]
): Output;
export function pipe<Input, Output>(
  input: Input,
  ...steps: readonly ((value: unknown) => unknown)[]
): Output {
  return steps.reduce<unknown>((value, step) => step(value), input) as Output;
}

export function compose<Input, Output>(step: (value: Input) => Output): (value: Input) => Output;
export function compose<Input, A, Output>(
  outer: (value: A) => Output,
  inner: (value: Input) => A,
): (value: Input) => Output;
export function compose<Input, Output>(
  ...steps: readonly ((value: unknown) => unknown)[]
): (value: Input) => Output;
export function compose<Input, Output>(
  ...steps: readonly ((value: unknown) => unknown)[]
): (value: Input) => Output {
  return (input) => steps.reduceRight<unknown>((value, step) => step(value), input) as Output;
}

export function mapReadonly<Input, Output>(
  values: readonly Input[],
  map: (value: Input) => Output,
): readonly Output[] {
  return Object.freeze(values.map(map));
}

export function concatReadonly<T>(...values: readonly (readonly T[])[]): readonly T[] {
  return Object.freeze(values.flatMap((value) => [...value]));
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}

function copyValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(copyValue) as T;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, copyValue(child)]),
  ) as T;
}

export interface EventBuilder {
  payload(values: Readonly<Record<string, RuntimeValue<EventContext, JsonValue>>>): EventBuilder;
  schemaRef(reference: SchemaReference): EventBuilder;
  build(): EventDefinition;
}

export function event<
  EventPayload extends object,
  CommandPayload extends object = JsonObject,
  State extends object = JsonObject,
>(
  type: EventType,
  payload: Readonly<{
    [Key in keyof EventPayload]: RuntimeValue<
      TypedEventContext<CommandPayload, State>,
      EventPayload[Key]
    >;
  }>,
  schemaRef?: SchemaReference,
): TypedEventDefinition<EventPayload, CommandPayload, State>;
export function event(
  type: EventType,
  payload: Readonly<Record<string, RuntimeValue<EventContext, JsonValue>>>,
  schemaRef?: SchemaReference,
): EventDefinition;
export function event(type: EventType): EventBuilder;
export function event(
  type: EventType,
  payload: Readonly<Record<string, RuntimeValue<EventContext, JsonValue>>> = {},
  schemaRef?: SchemaReference,
): EventDefinition | EventBuilder {
  const build = (value: EventDefinition): EventBuilder => ({
    payload: (next) => build({ ...value, payload: { ...value.payload, ...next } }),
    schemaRef: (reference) => build({ ...value, schemaRef: reference }),
    build: () => freeze(copyValue(value)),
  });
  const value: EventDefinition = {
    type,
    payload,
    ...(schemaRef === undefined ? {} : { schemaRef }),
  };
  return arguments.length === 1 ? build(value) : freeze(copyValue(value));
}

export interface BehaviorBuilder<
  Payload extends object = JsonObject,
  State extends object = JsonObject,
> {
  operation(operationId: OperationId): BehaviorBuilder<Payload, State>;
  when(
    condition: (input: Readonly<TypedMatchContext<Payload, State>>) => boolean,
  ): BehaviorBuilder<Payload, State>;
  condition(
    condition: (input: Readonly<TypedMatchContext<Payload, State>>) => boolean,
  ): BehaviorBuilder<Payload, State>;
  method(method: HttpMethod): BehaviorBuilder<Payload, State>;
  headers(headers: Readonly<Record<string, string>>): BehaviorBuilder<Payload, State>;
  requires(...guards: readonly RuntimeGuard[]): BehaviorBuilder<Payload, State>;
  scopes(...scopes: readonly string[]): BehaviorBuilder<Payload, State>;
  emit(eventType: EventType): BehaviorBuilder<Payload, State>;
  emitWhen(
    ...emissions: readonly NonNullable<BehaviorDefinition["emitWhen"]>[number][]
  ): BehaviorBuilder<Payload, State>;
  dispatch(
    ...commands: readonly NonNullable<BehaviorDefinition["dispatchCommands"]>[number][]
  ): BehaviorBuilder<Payload, State>;
  postcondition(
    condition: (input: Readonly<TypedEventContext<Payload, State>>) => boolean,
  ): BehaviorBuilder<Payload, State>;
  link(name: string, condition?: RuntimeBehavior["linkCondition"]): BehaviorBuilder<Payload, State>;
  status(status: number): BehaviorBuilder<Payload, State>;
  build(): BehaviorDefinition;
}

export function behavior<Payload extends object = JsonObject, State extends object = JsonObject>(
  name: string,
): BehaviorBuilder<Payload, State>;
export function behavior(value: BehaviorDefinition): BehaviorDefinition;
export function behavior(
  valueOrName: string | BehaviorDefinition,
): BehaviorBuilder | BehaviorDefinition {
  if (typeof valueOrName !== "string") return freeze(copyValue(valueOrName));
  const build = (value: BehaviorDefinition): BehaviorBuilder => ({
    operation: (operationId) => build({ ...value, operationId }),
    when: (condition) =>
      build({ ...value, condition: condition as NonNullable<RuntimeBehavior["condition"]> }),
    condition: (condition) =>
      build({ ...value, condition: condition as NonNullable<RuntimeBehavior["condition"]> }),
    method: (method) => build({ ...value, method }),
    headers: (headers) => build({ ...value, headers: { ...headers } }),
    requires: (...guards) => build({ ...value, requires: [...(value.requires ?? []), ...guards] }),
    scopes: (...scopes) =>
      build({ ...value, requiredScopes: [...(value.requiredScopes ?? []), ...scopes] }),
    emit: (eventType) => build({ ...value, emit: eventType, emitWhen: undefined }),
    emitWhen: (...emissions) => build({ ...value, emit: undefined, emitWhen: [...emissions] }),
    dispatch: (...commands) =>
      build({ ...value, dispatchCommands: [...(value.dispatchCommands ?? []), ...commands] }),
    postcondition: (condition) =>
      build({
        ...value,
        postcondition: condition as NonNullable<RuntimeBehavior["postcondition"]>,
      }),
    link: (name, condition) =>
      build({
        ...value,
        linkName: name,
        ...(condition === undefined ? {} : { linkCondition: condition }),
      }),
    status: (status) => build({ ...value, responseStatus: status }),
    build: () => {
      if (value.operationId === "")
        throw definitionError(`Behavior "${valueOrName}" requires an operationId`);
      if (
        value.emit === undefined &&
        value.emitWhen === undefined &&
        value.dispatchCommands === undefined
      )
        throw definitionError(`Behavior "${valueOrName}" requires an event or dispatch`);
      return freeze(copyValue(value));
    },
  });
  return build({ name: valueOrName, operationId: "" as OperationId });
}

export function defineEvent(value: EventDefinition): EventDefinition {
  return freeze(copyValue(value));
}
export function defineBehavior(value: BehaviorDefinition): BehaviorDefinition {
  return freeze(copyValue(value));
}
export function defineFault(value: FaultDefinition): FaultDefinition {
  return freeze(copyValue(value));
}
export function defineReaction(value: ReactionDefinition): ReactionDefinition {
  return freeze(copyValue(value));
}
export function defineWebhook(value: WebhookDefinition): WebhookDefinition {
  return freeze(copyValue(value));
}
export function defineSaga(value: SagaDefinition): SagaDefinition {
  return freeze(copyValue(value));
}
export function defineProjection(value: ProjectionDefinition): ProjectionDefinition {
  return freeze(copyValue(value));
}
export function defineGlobal(value: GlobalDefinition): GlobalDefinition {
  return freeze(copyValue(value));
}

export interface BoundaryBuilder {
  schema(value: SchemaReference): BoundaryBuilder;
  fallbackOverride(enabled?: boolean): BoundaryBuilder;
  identity(value: NonNullable<RuntimeBoundary["identity"]>): BoundaryBuilder;
  query(value: NonNullable<RuntimeBoundary["query"]>): BoundaryBuilder;
  queryMapping(value: NonNullable<RuntimeBoundary["queryMapping"]>): BoundaryBuilder;
  event(...values: readonly EventDefinition[]): BoundaryBuilder;
  eventCatalog(...values: readonly EventDefinition[]): BoundaryBuilder;
  behavior(...values: readonly BehaviorDefinition[]): BoundaryBuilder;
  reducer(...values: readonly ReducerDefinition[]): BoundaryBuilder;
  seed(
    ...values: readonly NonNullable<RuntimeBoundary["initialization"]>[number][]
  ): BoundaryBuilder;
  initialization(
    ...values: readonly NonNullable<RuntimeBoundary["initialization"]>[number][]
  ): BoundaryBuilder;
  response(value: ResponseDefinition): BoundaryBuilder;
  mask(...fields: readonly FieldPath[]): BoundaryBuilder;
  deprecated(value: NonNullable<RuntimeBoundary["deprecated"]>): BoundaryBuilder;
  latency(value: NonNullable<RuntimeBoundary["latency"]>): BoundaryBuilder;
  auditFields(enabled?: boolean): BoundaryBuilder;
  strictSchema(enabled?: boolean): BoundaryBuilder;
  state(value: NonNullable<RuntimeBoundary["state"]>): BoundaryBuilder;
  faults(...values: readonly FaultDefinition[]): BoundaryBuilder;
  reactions(...values: readonly ReactionDefinition[]): BoundaryBuilder;
  include(...values: readonly ComponentInclude[]): BoundaryBuilder;
  build(): BoundaryDefinition;
}

export function boundary(name: BoundaryName, contractPath: ContractPath): BoundaryBuilder {
  const build = (value: BoundaryDefinition): BoundaryBuilder => ({
    schema: (schema) => build({ ...value, schema }),
    fallbackOverride: (enabled = true) => build({ ...value, fallbackOverride: enabled }),
    identity: (identity) => build({ ...value, identity }),
    query: (query) => build({ ...value, query }),
    queryMapping: (queryMapping) =>
      build({ ...value, queryMapping: { ...value.queryMapping, ...queryMapping } }),
    event: (...events) => build({ ...value, eventCatalog: [...value.eventCatalog, ...events] }),
    eventCatalog: (...events) =>
      build({ ...value, eventCatalog: [...value.eventCatalog, ...events] }),
    behavior: (...behaviors) => build({ ...value, behaviors: [...value.behaviors, ...behaviors] }),
    reducer: (...reducers) => build({ ...value, reducers: [...value.reducers, ...reducers] }),
    seed: (...records) =>
      build({ ...value, initialization: [...(value.initialization ?? []), ...records] }),
    initialization: (...records) =>
      build({ ...value, initialization: [...(value.initialization ?? []), ...records] }),
    response: (response) => {
      const problem = runtimeLatencyProblem(response.latency);
      if (problem !== undefined)
        throw new TypeScriptAuthoringError(
          "TS_CONFIGURATION_INVALID",
          `Boundary "${value.boundary}" has invalid response latency: ${problem.message}`,
          {
            details: {
              boundary: value.boundary,
              ...(problem.field === undefined ? {} : { field: problem.field }),
            },
          },
        );
      return build({ ...value, response });
    },
    mask: (...fields) => build({ ...value, mask: [...(value.mask ?? []), ...fields] }),
    deprecated: (deprecated) => build({ ...value, deprecated }),
    latency: (latency) => {
      const problem = runtimeLatencyProblem(latency);
      if (problem !== undefined)
        throw new TypeScriptAuthoringError(
          "TS_CONFIGURATION_INVALID",
          `Boundary "${value.boundary}" has invalid latency: ${problem.message}`,
          {
            details: {
              boundary: value.boundary,
              ...(problem.field === undefined ? {} : { field: problem.field }),
            },
          },
        );
      return build({ ...value, latency });
    },
    auditFields: (enabled = true) => build({ ...value, auditFields: enabled }),
    strictSchema: (enabled = true) => build({ ...value, strictSchema: enabled }),
    state: (state) => build({ ...value, state }),
    faults: (...faults) => build({ ...value, faults: [...(value.faults ?? []), ...faults] }),
    reactions: (...reactions) =>
      build({ ...value, reactions: [...(value.reactions ?? []), ...reactions] }),
    include: (...includes) => build({ ...value, include: [...(value.include ?? []), ...includes] }),
    build: () => freeze(copyValue(value)),
  });
  return build({ boundary: name, contractPath, eventCatalog: [], behaviors: [], reducers: [] });
}

export interface SimulationBuilder {
  boundary(value: BoundaryDefinition | BoundaryBuilder): SimulationBuilder;
  boundaries(...values: readonly (BoundaryDefinition | BoundaryBuilder)[]): SimulationBuilder;
  use(...values: readonly UseDefinition[]): SimulationBuilder;
  policies(value: GlobalDefinition): SimulationBuilder;
  global(value: GlobalDefinition): SimulationBuilder;
  resource(value: ResourceDefinition): SimulationBuilder;
  resources(...values: readonly ResourceDefinition[]): SimulationBuilder;
  helper(value: TypeScriptHelperRegistration): SimulationBuilder;
  helpers(...values: readonly TypeScriptHelperRegistration[]): SimulationBuilder;
  build(): SimulationDefinition;
  compile(dependencies: RuntimeDependencies): RuntimeModel;
}

function built<T>(value: T | { build(): T }): T {
  return typeof value === "object" &&
    value !== null &&
    "build" in value &&
    typeof value.build === "function"
    ? value.build()
    : (value as T);
}

export function simulation(initial: readonly BoundaryDefinition[] = []): SimulationBuilder {
  const make = (definition: SimulationDefinition): SimulationBuilder => ({
    boundary: (value) =>
      make({ ...definition, boundaries: [...definition.boundaries, built(value)] }),
    boundaries: (...values) =>
      make({ ...definition, boundaries: [...definition.boundaries, ...values.map(built)] }),
    use: (...values) => make({ ...definition, uses: [...(definition.uses ?? []), ...values] }),
    policies: (policies) =>
      make({ ...definition, policies: { ...definition.policies, ...policies } }),
    global: (policies) =>
      make({ ...definition, policies: { ...definition.policies, ...policies } }),
    resource: (resource) =>
      make({ ...definition, resources: [...(definition.resources ?? []), resource] }),
    resources: (...resources) =>
      make({ ...definition, resources: [...(definition.resources ?? []), ...resources] }),
    helper: (helper) =>
      make({
        ...definition,
        helpers: [...(definition.helpers ?? []), helper.definition],
      }),
    helpers: (...helpers) =>
      make({
        ...definition,
        helpers: [...(definition.helpers ?? []), ...helpers.map((helper) => helper.definition)],
      }),
    build: () => freeze(copyValue(definition)),
    compile: (dependencies) => compileProgram(definition, { dependencies }),
  });
  return make({ boundaries: [...initial] });
}

export function compileProgram(
  definition: SimulationDefinition,
  options: Readonly<{
    dependencies: RuntimeDependencies;
    openapi?: OpenApiDoc;
    allowExternalReferences?: boolean;
  }>,
): RuntimeModel {
  if (!definition || !Array.isArray(definition.boundaries))
    throw definitionError("A simulation requires a boundaries array");
  const boundaries = composeBoundaries(
    [...definition.boundaries, ...expandResources(definition.resources ?? [], options.openapi)],
    definition.uses,
  );
  const runtimeDefinition: RuntimeDefinition = {
    boundaries,
    policies: definition.policies,
    helpers: definition.helpers,
  };
  return compileRuntime(runtimeDefinition, options.dependencies, {
    allowExternalReferences: options.allowExternalReferences,
  });
}

export function defineSimulation(definition: SimulationDefinition): SimulationDefinition {
  return freeze(copyValue(definition));
}
