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
  RuntimeLink,
  RuntimePolicies,
  RuntimePredicate,
  RuntimeReaction,
  RuntimeReducer,
  RuntimeReducerContext,
  RuntimeResponse,
  RuntimeResponsePolicy,
  RuntimeSaga,
  RuntimeSagaCompensation,
  RuntimeSagaStep,
  RuntimeSecondaryCommand,
  RuntimeWebhook,
  RuntimeValue,
  SagaContext,
  WebhookContext,
} from "../model/runtime.js";
import type { OpenApiDoc } from "../contract/loader.js";
import { expandResources, type ResourceDefinition } from "./resourceModel.js";
import type { TypeScriptHelperDefinition, TypeScriptHelperRegistration } from "./helpers.js";
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
  BehaviorName,
  ContractPath,
  EventReference,
  EventSelector,
  EventType,
  FaultName,
  FieldPath,
  GuardName,
  HttpMethod,
  LinkRelation,
  OperationId,
  QueryPath,
  SagaName,
  SagaStepName,
  ScopeName,
  SchemaReference,
  WebhookName,
} from "./references.js";

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
> = Omit<EventDefinition, "payload"> & {
  readonly payload: Readonly<{
    [Key in keyof EventPayload]: RuntimeValue<
      TypedEventContext<CommandPayload, State>,
      EventPayload[Key]
    >;
  }>;
};

export interface BehaviorDefinition extends Omit<
  RuntimeBehavior,
  | "operationId"
  | "emit"
  | "emitWhen"
  | "dispatchCommands"
  | "method"
  | "requiredScopes"
  | "linkName"
  | "requires"
> {
  readonly name: BehaviorName;
  readonly operationId: OperationId;
  readonly method?: HttpMethod;
  readonly requiredScopes?: readonly ScopeName[];
  readonly requires?: readonly GuardDefinition[];
  readonly linkName?: LinkRelation;
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
export type GuardDefinition = Omit<RuntimeGuard, "name"> & {
  readonly name: GuardName;
};
export type SecondaryCommandDefinition = NonNullable<
  BehaviorDefinition["dispatchCommands"]
>[number];
export type IdentityKeyDefinition =
  | {
      readonly from: "path" | "query" | "header";
      readonly name: string;
      readonly pointer?: never;
    }
  | {
      readonly from: "payload";
      readonly name: string;
      readonly pointer?: string;
    }
  | {
      readonly from: "payload";
      readonly name?: string;
      readonly pointer: string;
    };
export type IdentityDefinition = Omit<NonNullable<RuntimeBoundary["identity"]>, "key"> & {
  readonly key?: IdentityKeyDefinition;
};
export type ResponseLinkDefinition = Omit<RuntimeLink, "rel"> & {
  readonly rel: LinkRelation;
};
export type ResponseDefinition = Omit<RuntimeResponsePolicy, "mask" | "hateoas"> & {
  readonly mask?: readonly FieldPath[];
  readonly hateoas?: readonly ResponseLinkDefinition[];
};
export type FaultDefinition = Omit<RuntimeFault, "name" | "requiredScopes" | "requires"> & {
  readonly name: FaultName;
  readonly requiredScopes?: readonly ScopeName[];
  readonly requires?: readonly GuardDefinition[];
};
export type ReactionDefinition = Omit<RuntimeReaction, "on" | "boundary" | "emit"> & {
  readonly on: EventSelector;
  readonly boundary: BoundaryName;
  readonly emit: EventType;
};
export type WebhookDefinition = Omit<RuntimeWebhook, "name"> & {
  readonly name: WebhookName;
};
export type SagaCompensationDefinition = Omit<RuntimeSagaCompensation, "operationId"> & {
  readonly operationId: OperationId;
};
export type SagaStepDefinition = Omit<
  RuntimeSagaStep,
  "name" | "boundary" | "operationId" | "compensation"
> & {
  readonly name: SagaStepName;
  readonly boundary: BoundaryName;
  readonly operationId: OperationId;
  readonly compensation?: SagaCompensationDefinition;
};
export type SagaDefinition = Omit<RuntimeSaga, "name" | "trigger" | "steps"> & {
  readonly name: SagaName;
  readonly trigger: Omit<RuntimeSaga["trigger"], "boundary"> & {
    readonly boundary: BoundaryName;
  };
  readonly steps: readonly SagaStepDefinition[];
};
export type ProjectionDefinition = Omit<RuntimeDerivedProjection, "subscribe" | "reduce"> & {
  readonly subscribe: readonly EventSelector[];
  readonly reduce: readonly ReducerDefinition[];
};
export type BoundaryDefinition = Omit<
  ComposableBoundary,
  | "boundary"
  | "contractPath"
  | "schema"
  | "eventCatalog"
  | "behaviors"
  | "reducers"
  | "mask"
  | "faults"
  | "identity"
  | "query"
  | "response"
  | "reactions"
> & {
  readonly boundary: BoundaryName;
  readonly contractPath: ContractPath;
  readonly schema?: SchemaReference;
  readonly eventCatalog: readonly EventDefinition[];
  readonly behaviors: readonly BehaviorDefinition[];
  readonly reducers: readonly ReducerDefinition[];
  readonly identity?: IdentityDefinition;
  readonly query?: QueryDefinition;
  readonly response?: ResponseDefinition;
  readonly mask?: readonly FieldPath[];
  readonly faults?: readonly FaultDefinition[];
  readonly reactions?: readonly ReactionDefinition[];
};
export type GlobalDefinition = Omit<
  RuntimePolicies,
  "faults" | "reactions" | "derivedProjections" | "sagas" | "webhooks"
> & {
  readonly faults?: readonly FaultDefinition[];
  readonly reactions?: readonly ReactionDefinition[];
  readonly derivedProjections?: readonly ProjectionDefinition[];
  readonly sagas?: readonly SagaDefinition[];
  readonly webhooks?: readonly WebhookDefinition[];
};

export interface SimulationDefinition {
  readonly boundaries: readonly BoundaryDefinition[];
  readonly resources?: readonly ResourceDefinition[];
  readonly policies?: GlobalDefinition;
  readonly uses?: readonly UseDefinition[];
  readonly helpers?: readonly TypeScriptHelperDefinition[];
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
export type QueryValue<Value> = (context: Readonly<QueryContext>) => Value;
export interface QueryDefinition {
  readonly fields?: Readonly<Record<string, QueryExpression>>;
  readonly filter?: QueryExpression;
  readonly sort?: (
    left: Readonly<JsonObject>,
    right: Readonly<JsonObject>,
    input: Readonly<QueryContext>,
  ) => number;
  readonly pageSize?: QueryValue<number>;
  readonly maxPageSize?: number;
  readonly cursor?: QueryValue<string | undefined>;
  readonly expand?: readonly QueryPath[];
  readonly pagination?: "raw" | "envelope";
  readonly includeDeleted?: boolean;
  readonly fallback?: QueryValue<JsonValue | undefined>;
}
export type ResponseExpression = RuntimeValue<ResponseContext, RuntimeResponse | null | undefined>;
export type EventHydrationExpression = RuntimeValue<EventContext, JsonValue>;
export type ReducerExpression = RuntimeValue<RuntimeReducerContext, JsonValue>;
export type IdentityExpression = RuntimeValue<IdentityContext, string>;
export type FaultExpression = RuntimePredicate<FaultContext>;
export type WebhookExpression = RuntimeValue<WebhookContext, string>;
export type SagaExpression = RuntimeValue<SagaContext, string | null>;
export type ProjectionExpression = RuntimeValue<ProjectionContext, string>;

export function expression<Value, Phase extends ExpressionPhase>(
  phase: Phase,
  callback: () => Value,
): Expression<unknown, Value, Phase>;
export function expression<Context, Value, Phase extends ExpressionPhase>(
  phase: Phase,
  callback: (context: Readonly<Context>) => Value,
): Expression<Context, Value, Phase>;
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

type EventPayloadExpressions<
  EventPayload extends object,
  CommandPayload extends object,
  State extends object,
> = Readonly<{
  [Key in keyof EventPayload]: RuntimeValue<
    TypedEventContext<CommandPayload, State>,
    EventPayload[Key]
  >;
}>;

type MergeEventPayload<Current extends object, Added extends object> = Omit<Current, keyof Added> &
  Added;

export interface EventBuilder<
  EventPayload extends object = {},
  CommandPayload extends object = JsonObject,
  State extends object = JsonObject,
> {
  payload<AddedPayload extends object>(
    values: EventPayloadExpressions<AddedPayload, CommandPayload, State>,
  ): EventBuilder<MergeEventPayload<EventPayload, AddedPayload>, CommandPayload, State>;
  schemaRef(reference: SchemaReference): EventBuilder<EventPayload, CommandPayload, State>;
  build(): TypedEventDefinition<EventPayload, CommandPayload, State>;
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
export function event<
  EventPayload extends object = {},
  CommandPayload extends object = JsonObject,
  State extends object = JsonObject,
>(type: EventType): EventBuilder<EventPayload, CommandPayload, State>;
export function event(
  type: EventType,
  payload: Readonly<Record<string, RuntimeValue<EventContext, JsonValue>>> = {},
  schemaRef?: SchemaReference,
): EventDefinition | EventBuilder {
  const build = <
    EventPayload extends object = {},
    CommandPayload extends object = JsonObject,
    State extends object = JsonObject,
  >(
    value: EventDefinition,
  ): EventBuilder<EventPayload, CommandPayload, State> => ({
    payload: <AddedPayload extends object>(
      next: EventPayloadExpressions<AddedPayload, CommandPayload, State>,
    ) =>
      build<MergeEventPayload<EventPayload, AddedPayload>, CommandPayload, State>({
        ...value,
        payload: { ...value.payload, ...next } as EventDefinition["payload"],
      }),
    schemaRef: (reference) =>
      build<EventPayload, CommandPayload, State>({
        ...value,
        schemaRef: reference,
      }),
    build: () =>
      freeze(copyValue(value)) as TypedEventDefinition<EventPayload, CommandPayload, State>,
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
  requires(...guards: readonly GuardDefinition[]): BehaviorBuilder<Payload, State>;
  scopes(...scopes: readonly ScopeName[]): BehaviorBuilder<Payload, State>;
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
  link(
    name: LinkRelation,
    condition?: RuntimeBehavior["linkCondition"],
  ): BehaviorBuilder<Payload, State>;
  status(status: number): BehaviorBuilder<Payload, State>;
  build(): BehaviorDefinition;
}

export function behavior<Payload extends object = JsonObject, State extends object = JsonObject>(
  name: BehaviorName,
): BehaviorBuilder<Payload, State>;
export function behavior(value: BehaviorDefinition): BehaviorDefinition;
export function behavior(
  valueOrName: BehaviorName | BehaviorDefinition,
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
  identity(value: IdentityDefinition): BoundaryBuilder;
  query(value: QueryDefinition): BoundaryBuilder;
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
