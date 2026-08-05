/**
 * The complete TypeScript authoring contract.
 *
 * This module is deliberately independent of the runtime compiler. Authors
 * describe a simulation with these types; the compiler adapts the completed
 * definition to the private source-independent runtime model afterwards.
 */

import type {
  SimulationEventContext,
  SimulationFaultContext,
  SimulationHelpers,
  SimulationIdentityContext,
  SimulationMatchContext,
  SimulationHateoas,
  SimulationLifecycle,
  SimulationModelCoverage,
  SimulationPostCommitContext,
  SimulationProjectionContext,
  SimulationQueryContext,
  SimulationReducerContext,
  SimulationRequest,
  SimulationResponseContext,
  SimulationSagaContext,
  SimulationSecurityHeaders,
  SimulationVersion,
  SimulationVersioning,
  SimulationWebhookContext,
} from '../types.js';
import type { DataGenerator } from '../contracts/data.js';
import type { Actor, JwtValidationConfig } from '../contracts/identity.js';
import type { Command } from '../contracts/domain.js';
import type { DeepReadonly, JsonObject, JsonValue } from '../contracts/value.js';
import type { ErrorClass, RequestControls } from '../contracts/controlHeaders.js';
import type {
  BoundaryName,
  BehaviorName,
  ComponentName,
  ContractPath,
  EventSelector,
  EventType,
  FaultName,
  FieldPath,
  HelperName,
  GuardName,
  HttpMethod,
  LinkRelation,
  OperationId,
  ProjectionName,
  QueryPath,
  ReactionName,
  ResourceName,
  SagaName,
  SagaStepName,
  SchemaReference,
  ScopeName,
  StateFieldName,
  WebhookName,
} from '../domain/references.js';

export type { DeepReadonly };
export type { Actor, Command, RequestControls };

// Contexts -----------------------------------------------------------------

export type AuthoringHelpers = SimulationHelpers;
export type AuthoringRequest = SimulationRequest;
export type MatchContext = SimulationMatchContext;
export type EventContext = SimulationEventContext;
export type IdentityContext = SimulationIdentityContext;
export type ReducerContext = SimulationReducerContext;
export type QueryContext = SimulationQueryContext;
export type ResponseContext = SimulationResponseContext;
export type PostCommitContext = SimulationPostCommitContext;
export type FaultContext = SimulationFaultContext;
export type WebhookContext = SimulationWebhookContext;
export type SagaContext = SimulationSagaContext;
export type ProjectionContext = SimulationProjectionContext;

export type { DataGenerator };

export type AuthoringValue<Context, Value> = Value | ((input: Readonly<Context>) => Value);
export type AuthoringPredicate<Context> = (input: Readonly<Context>) => boolean;
export type TypedEventType<Name extends string> = string extends Name ? string : EventType<Name>;

export type TypedMatchContext<Payload extends object, State extends object = JsonObject> = Omit<
  MatchContext,
  'payload' | 'state'
> & {
  readonly payload: DeepReadonly<Payload>;
  readonly state: DeepReadonly<State> | null;
};

export type TypedEventContext<Payload extends object, State extends object = JsonObject> = Omit<
  EventContext,
  'payload' | 'state'
> & {
  readonly payload: DeepReadonly<Payload>;
  readonly state: DeepReadonly<State> | null;
};

export type TypedReducerContext<
  Payload extends object,
  State extends object,
  EventName extends string = string,
> = Omit<ReducerContext, 'event' | 'payload' | 'state'> & {
  readonly state: DeepReadonly<State>;
  readonly payload: DeepReadonly<Payload>;
  readonly event: Omit<ReducerContext['event'], 'type' | 'payload'> & {
    readonly type: TypedEventType<EventName>;
    readonly payload: DeepReadonly<Payload>;
  };
};

export type ExpressionPhase =
  | 'behavior'
  | 'event'
  | 'identity'
  | 'reducer'
  | 'query'
  | 'response'
  | 'post-commit'
  | 'fault'
  | 'webhook'
  | 'saga'
  | 'projection';

export type Expression<Context, Value, Phase extends ExpressionPhase = ExpressionPhase> = ((
  context: Readonly<Context>,
) => Value) &
  Readonly<{ phase: Phase }>;

// Definitions ---------------------------------------------------------------

export interface EventDefinition<Name extends string = string> {
  readonly type: EventType<Name>;
  readonly schemaRef?: SchemaReference;
  readonly payload: Readonly<Record<string, AuthoringValue<EventContext, JsonValue>>>;
}

export type TypedEventDefinition<
  EventPayload extends object,
  CommandPayload extends object = JsonObject,
  State extends object = JsonObject,
  EventName extends string = string,
> = Omit<EventDefinition<EventName>, 'payload'> & {
  readonly payload: Readonly<{
    [Key in keyof EventPayload]: AuthoringValue<
      TypedEventContext<CommandPayload, State>,
      EventPayload[Key]
    >;
  }>;
};

export interface BehaviorEmissionDefinition {
  readonly when: AuthoringPredicate<MatchContext>;
  readonly event: EventType;
}

export interface SecondaryCommandDefinition {
  readonly boundary: BoundaryName;
  readonly intent: Command['intent'];
  readonly operationId: OperationId;
  readonly targetId?: AuthoringValue<MatchContext, string | null>;
  readonly payload?: Readonly<Record<string, AuthoringValue<MatchContext, JsonValue>>>;
  readonly condition?: AuthoringPredicate<MatchContext>;
}

export interface BehaviorDefinition {
  readonly name: BehaviorName;
  readonly operationId: OperationId;
  readonly condition?: AuthoringPredicate<MatchContext>;
  readonly requires?: readonly GuardDefinition[];
  readonly requiredScopes?: readonly ScopeName[];
  readonly method?: HttpMethod;
  readonly headers?: Readonly<Record<string, string>>;
  readonly emit?: EventType;
  readonly emitWhen?: readonly BehaviorEmissionDefinition[];
  readonly dispatchCommands?: readonly SecondaryCommandDefinition[];
  readonly postcondition?: AuthoringPredicate<PostCommitContext>;
  readonly linkName?: LinkRelation;
  readonly linkCondition?: AuthoringPredicate<MatchContext>;
  readonly responseStatus?: number;
}

export interface GuardDefinition {
  readonly name: GuardName;
  readonly check: AuthoringPredicate<MatchContext | FaultContext>;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly errorStatus?: number;
}

export type IdentityKeyDefinition =
  | { readonly from: 'path' | 'query' | 'header'; readonly name: string; readonly pointer?: never }
  | { readonly from: 'payload'; readonly name: string; readonly pointer?: string }
  | { readonly from: 'payload'; readonly name?: string; readonly pointer: string };

export interface IdentityDefinition {
  readonly generate?: (input: Readonly<IdentityContext>) => string;
  readonly key?: IdentityKeyDefinition;
}

export interface Response {
  readonly status?: number;
  readonly body?: JsonValue | null;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ResponseLinkDefinition {
  readonly rel: LinkRelation;
  readonly href: AuthoringValue<ResponseContext, string>;
  readonly condition?: AuthoringPredicate<ResponseContext>;
}

export interface DeprecationDefinition {
  readonly date: string;
  readonly sunset?: string;
  readonly replacement?: string;
}

export interface LatencyDefinition {
  readonly minMs?: number;
  readonly maxMs?: number;
  readonly fixedMs?: number;
}

export interface ResponseDefinition {
  readonly transform?: (input: Readonly<ResponseContext>) => Response | null | undefined;
  readonly mask?: readonly FieldPath[];
  readonly hateoas?: readonly ResponseLinkDefinition[];
  readonly deprecated?: DeprecationDefinition;
  readonly latency?: LatencyDefinition;
  readonly auditFields?: boolean;
  readonly status?: AuthoringValue<ResponseContext, number>;
  readonly headers?: Readonly<Record<string, AuthoringValue<ResponseContext, string>>>;
}

export type FaultErrorClass = ErrorClass;

export interface FaultSelectorDefinition {
  readonly signal?: string;
  readonly forceResponse?: string;
  readonly scenario?: string;
  readonly featureFlag?: string;
  readonly errorClass?: FaultErrorClass;
}

export interface FaultResponseDefinition {
  readonly status: number;
  readonly body?: JsonValue;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface FaultDefinition {
  readonly name: FaultName;
  readonly matches: AuthoringPredicate<FaultContext>;
  readonly probability?: number;
  readonly requiredScopes?: readonly ScopeName[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly selectors?: Readonly<FaultSelectorDefinition>;
  readonly response: Readonly<FaultResponseDefinition>;
  readonly delayMs?: number;
  readonly requires?: readonly GuardDefinition[];
}

export interface ReactionDefinition {
  readonly name?: ReactionName;
  readonly on: EventSelector;
  readonly when?: AuthoringPredicate<PostCommitContext>;
  readonly boundary: BoundaryName;
  readonly emit: EventType;
  readonly intent?: 'mutation' | 'creation';
  readonly target?: AuthoringValue<PostCommitContext, string | null>;
  readonly payload?: Readonly<Record<string, AuthoringValue<PostCommitContext, JsonValue>>>;
}

export interface WebhookDefinition {
  readonly name: WebhookName;
  readonly trigger: AuthoringPredicate<WebhookContext>;
  readonly url: AuthoringValue<WebhookContext, string>;
  readonly payload?: Readonly<Record<string, AuthoringValue<WebhookContext, JsonValue>>>;
  readonly secret?: string;
  readonly retry?: Readonly<{ maxAttempts?: number; delayMs?: number }>;
}

export interface SagaCompensationDefinition {
  readonly intent: Command['intent'];
  readonly operationId: OperationId;
  readonly targetId?: AuthoringValue<SagaContext, string | null>;
  readonly payload?: Readonly<Record<string, AuthoringValue<SagaContext, JsonValue>>>;
}

export interface SagaStepDefinition {
  readonly name: SagaStepName;
  readonly boundary: BoundaryName;
  readonly intent: Command['intent'];
  readonly operationId: OperationId;
  readonly targetId?: AuthoringValue<SagaContext, string | null>;
  readonly payload?: Readonly<Record<string, AuthoringValue<SagaContext, JsonValue>>>;
  readonly compensation?: SagaCompensationDefinition;
}

export interface SagaTriggerDefinition {
  readonly boundary: BoundaryName;
  readonly intent: Command['intent'];
  readonly condition?: AuthoringPredicate<SagaContext>;
}

export interface SagaDefinition {
  readonly name: SagaName;
  readonly trigger: SagaTriggerDefinition;
  readonly steps: readonly SagaStepDefinition[];
}

export interface ReducerDefinition<
  EventPayload extends object = object,
  State extends object = object,
  EventName extends string = string,
> {
  readonly on: TypedEventType<EventName>;
  reduce(input: Readonly<TypedReducerContext<EventPayload, State, EventName>>): State;
}

export interface ProjectionDefinition {
  readonly name: ProjectionName;
  readonly key: AuthoringValue<ProjectionContext, string>;
  readonly subscribe: readonly EventSelector[];
  readonly reduce: readonly ReducerDefinition[];
  readonly reset?: () => void;
}

export type StateFieldType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'null'
  | 'array'
  | 'object'
  | 'unknown';

export interface ComputedFieldDefinition {
  readonly name: StateFieldName;
  readonly formula: (context: Readonly<ReducerContext>) => JsonValue;
  readonly dependsOn: readonly StateFieldName[];
}

export interface InternalFieldDefinition {
  readonly name: StateFieldName;
  readonly type?: StateFieldType;
}

export interface StateDefinition {
  readonly computed?: readonly ComputedFieldDefinition[];
  readonly internal?: readonly InternalFieldDefinition[];
  readonly validate?: (state: Readonly<JsonObject>) => void;
}

export interface SeedDefinition {
  readonly state: JsonObject;
  readonly id?: string;
  readonly eventType?: EventType;
  readonly timestamp?: string;
}

export type InitializationDefinition = JsonObject | SeedDefinition;

export interface QueryDefinition {
  readonly fields?: Readonly<Record<string, AuthoringPredicate<QueryContext>>>;
  readonly filter?: AuthoringPredicate<QueryContext>;
  readonly sort?: (
    left: Readonly<JsonObject>,
    right: Readonly<JsonObject>,
    input: Readonly<QueryContext>,
  ) => number;
  readonly pageSize?: AuthoringValue<QueryContext, number>;
  readonly maxPageSize?: number;
  readonly cursor?: AuthoringValue<QueryContext, string | undefined>;
  readonly expand?: readonly QueryPath[];
  readonly pagination?: 'raw' | 'envelope';
  readonly includeDeleted?: boolean;
  readonly fallback?: AuthoringValue<QueryContext, JsonValue | undefined>;
}

export type QueryMappingDefinition = Readonly<Record<string, AuthoringPredicate<QueryContext>>>;

// Policies -----------------------------------------------------------------

export interface AuthDefinition {
  readonly mode?: 'simple' | 'jwt' | 'session';
  readonly authenticate?: (input: Readonly<AuthoringRequest>) => Readonly<Actor> | undefined;
  readonly authorize?: (input: Readonly<MatchContext>, scopes: readonly string[]) => boolean;
  readonly jwt?: Readonly<JwtValidationConfig>;
  readonly session?: Readonly<{
    readonly cookieName?: string;
    readonly ttlSeconds?: number;
    readonly csrf?: boolean;
    readonly csrfHeader?: string;
    readonly loginPath?: string;
    readonly logoutPath?: string;
  }>;
}

export interface IdempotencyDefinition {
  readonly enabled: boolean;
  readonly ttlSeconds: number;
  readonly hashIncludesBody: boolean;
}
export type SecurityHeadersDefinition = SimulationSecurityHeaders;
export type HateoasDefinition = SimulationHateoas;
export type VersionDefinition = SimulationVersion;
export type VersioningDefinition = SimulationVersioning;
export interface FallbackResponseDefinition {
  readonly status: number;
  readonly body?: JsonValue;
  readonly headers?: Readonly<Record<string, string>>;
}
export interface FallbackRuleDefinition {
  readonly match: Readonly<{ path?: string; method?: string; inContract?: boolean }>;
  readonly respond: Readonly<FallbackResponseDefinition>;
}
export interface FallbackDefinition {
  readonly rules?: readonly FallbackRuleDefinition[];
  readonly default?: Readonly<FallbackResponseDefinition>;
}
export interface ControlDefaultsDefinition {
  readonly transparency?: Readonly<{
    dryRun?: boolean;
    includeEvents?: boolean;
    echo?: boolean;
    seed?: string;
    clockOffsetMs?: number;
  }>;
  readonly sideEffects?: Readonly<{
    skipSagas?: boolean;
    skipWebhooks?: boolean;
    skipReactions?: boolean;
    skipProjections?: boolean;
    skipDispatch?: boolean;
    maxCascadeDepth?: number;
    bulkTransactional?: boolean;
  }>;
  readonly identity?: Readonly<{ causedBy?: string }>;
  readonly timeTravel?: Readonly<{ readAtVersion?: number; replayEvent?: string }>;
  readonly format?: Readonly<{
    responseFormat?: 'hal' | 'jsonapi' | 'plain';
    paginationStyle?: 'envelope' | 'raw' | 'link-header';
    maskFields?: readonly string[];
  }>;
  readonly observability?: Readonly<{
    traceId?: string;
    spanName?: string;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    metricTag?: Readonly<{ key: string; value: string }>;
  }>;
  readonly validation?: Readonly<{
    skipRequestValidation?: boolean;
    skipResponseValidation?: boolean;
    allowAdditionalProperties?: boolean;
  }>;
  readonly chaos?: Readonly<{
    featureFlag?: string;
    useFault?: string;
    rateLimit?: boolean;
    signal?: string;
    forceResponse?: string;
    scenario?: string;
    forceStatus?: number;
    errorClass?: FaultErrorClass;
    forceLatencyMs?: number;
    jitterMs?: Readonly<{ min: number; max: number }>;
    dropConnectionMs?: number;
    successRate?: number;
    retryAfterSeconds?: number;
    bodyTruncateBytes?: number;
  }>;
}
export type LifecycleDefinition = SimulationLifecycle;
export type CoverageDefinition = SimulationModelCoverage;

export interface GlobalDefinition {
  readonly auth?: AuthDefinition;
  readonly idempotency?: IdempotencyDefinition;
  readonly securityHeaders?: SecurityHeadersDefinition;
  readonly hateoas?: HateoasDefinition;
  readonly versioning?: VersioningDefinition;
  readonly fallback?: FallbackDefinition;
  readonly lifecycle?: LifecycleDefinition;
  readonly controlDefaults?: ControlDefaultsDefinition;
  readonly coverage?: Readonly<Record<string, CoverageDefinition>>;
  readonly faults?: readonly FaultDefinition[];
  readonly reactions?: readonly ReactionDefinition[];
  readonly derivedProjections?: readonly ProjectionDefinition[];
  readonly sagas?: readonly SagaDefinition[];
  readonly webhooks?: readonly WebhookDefinition[];
}

// Composition and resources -----------------------------------------------

export interface ExportDefinition {
  readonly states: readonly {
    readonly name: string;
    readonly steps: readonly {
      readonly operationId: OperationId;
      readonly body?: JsonObject;
      readonly headers?: Readonly<Record<string, string>>;
    }[];
    readonly saga?: SagaName;
  }[];
}

export interface ComponentSource {
  readonly schema?: SchemaReference;
  readonly fallbackOverride?: boolean;
  readonly eventCatalog?: readonly EventDefinition[];
  readonly behaviors?: readonly BehaviorDefinition[];
  readonly reducers?: readonly ReducerDefinition[];
  readonly identity?: IdentityDefinition;
  readonly query?: QueryDefinition;
  readonly queryMapping?: QueryMappingDefinition;
  readonly initialization?: readonly InitializationDefinition[];
  readonly state?: StateDefinition;
  readonly deprecated?: DeprecationDefinition;
  readonly latency?: LatencyDefinition;
  readonly response?: ResponseDefinition;
  readonly mask?: readonly FieldPath[];
  readonly faults?: readonly FaultDefinition[];
  readonly reactions?: readonly ReactionDefinition[];
  readonly include?: readonly ComponentInclude[];
  readonly auditFields?: boolean;
  readonly strictSchema?: boolean;
  readonly export?: ExportDefinition;
}

export interface ComponentDefinition {
  readonly name: ComponentName;
  readonly parameters?: Readonly<Record<string, ComponentParameterDefinition>>;
  readonly instantiate: (parameters: Readonly<JsonObject>) => ComponentSource;
}

export type ComponentParameterType = 'string' | 'number' | 'boolean';

export interface ComponentParameterDefinition {
  readonly type: ComponentParameterType;
  readonly default?: string | number | boolean;
  readonly required?: boolean;
}

/** Explicit reference to a YAML component in a mixed authoring program. */
export interface YamlComponentReference {
  readonly kind: 'yaml-component';
  readonly name: ComponentName;
}

export type ComponentReference = ComponentDefinition | YamlComponentReference;

export interface ComponentInclude {
  readonly component: ComponentReference;
  readonly parameters?: Readonly<JsonObject>;
}

export type ComposableBoundary = BoundaryDefinition;

export interface UseDefinition {
  readonly component: ComponentReference;
  readonly as: BoundaryName;
  readonly contractPath: ContractPath;
  readonly parameters?: Readonly<JsonObject>;
  readonly bind?: Readonly<Record<string, string>>;
}

export interface ResourceOperation {
  readonly operationId: OperationId;
  readonly contractPath?: ContractPath;
  readonly method?: HttpMethod;
  readonly emit?: EventType;
  readonly query?: boolean;
  readonly behavior?: Omit<BehaviorDefinition, 'name' | 'operationId'>;
}

export interface ResourceDefinition {
  readonly resource: ResourceName;
  readonly schema: SchemaReference;
  readonly identity?: IdentityDefinition;
  readonly response?: ResponseDefinition;
  readonly query?: QueryDefinition;
  readonly eventCatalog: readonly EventDefinition[];
  readonly reducers: readonly ReducerDefinition[];
  readonly initialization?: readonly InitializationDefinition[];
  readonly operations: readonly ResourceOperation[];
  readonly mask?: readonly FieldPath[];
  readonly auditFields?: boolean;
  readonly deprecated?: DeprecationDefinition;
  readonly latency?: LatencyDefinition;
  readonly state?: StateDefinition;
  readonly strictSchema?: boolean;
  readonly faults?: readonly FaultDefinition[];
  readonly reactions?: readonly ReactionDefinition[];
}

export interface BoundaryDefinition {
  readonly boundary: BoundaryName;
  readonly contractPath: ContractPath;
  readonly schema?: SchemaReference;
  readonly fallbackOverride?: boolean;
  readonly identity?: IdentityDefinition;
  readonly query?: QueryDefinition;
  readonly queryMapping?: QueryMappingDefinition;
  readonly eventCatalog: readonly EventDefinition[];
  readonly behaviors: readonly BehaviorDefinition[];
  readonly reducers: readonly ReducerDefinition[];
  readonly initialization?: readonly InitializationDefinition[];
  readonly response?: ResponseDefinition;
  readonly mask?: readonly FieldPath[];
  readonly latency?: LatencyDefinition;
  readonly auditFields?: boolean;
  readonly deprecated?: DeprecationDefinition;
  readonly state?: StateDefinition;
  readonly strictSchema?: boolean;
  readonly faults?: readonly FaultDefinition[];
  readonly reactions?: readonly ReactionDefinition[];
  readonly include?: readonly ComponentInclude[];
  readonly export?: ExportDefinition;
}

export interface SimulationDefinition {
  readonly boundaries: readonly BoundaryDefinition[];
  readonly components?: readonly ComponentDefinition[];
  readonly resources?: readonly ResourceDefinition[];
  readonly policies?: GlobalDefinition;
  readonly uses?: readonly UseDefinition[];
  readonly helpers?: readonly TypeScriptHelperDefinition[];
}

export interface TypeScriptHelperDefinition {
  readonly name: HelperName;
  /** CEL phases in which YAML may invoke this helper. Reducers are excluded. */
  readonly phases: readonly TypeScriptHelperPhase[];
  /** Synchronous execution budget enforced at the authoring boundary. */
  readonly maxDurationMs: number;
  readonly invoke: (args: readonly JsonValue[], phase?: string) => JsonValue;
}

export type TypeScriptHelperPhase =
  | 'behavior'
  | 'event-hydration'
  | 'identity'
  | 'query'
  | 'response'
  | 'post-commit'
  | 'fault'
  | 'webhook'
  | 'saga'
  | 'projection'
  | 'lifecycle';

export interface TypeScriptHelperRegistration {
  readonly definition: TypeScriptHelperDefinition;
}

export interface TypeScriptHelper<
  Args extends readonly JsonValue[] = readonly JsonValue[],
  Output extends JsonValue = JsonValue,
> {
  (...args: Args): Output;
  readonly definition: TypeScriptHelperDefinition;
}

// Query and convenience function types ------------------------------------

export type QueryExpression = AuthoringPredicate<QueryContext>;
export type QueryValue<Value> = AuthoringValue<QueryContext, Value>;
export type ResponseExpression = AuthoringValue<ResponseContext, Response | null | undefined>;
export type EventHydrationExpression = AuthoringValue<EventContext, JsonValue>;
export type ReducerExpression = AuthoringValue<ReducerContext, JsonValue>;
export type IdentityExpression = AuthoringValue<IdentityContext, string>;
export type FaultExpression = AuthoringPredicate<FaultContext>;
export type WebhookExpression = AuthoringValue<WebhookContext, string>;
export type SagaExpression = AuthoringValue<SagaContext, string | null>;
export type ProjectionExpression = AuthoringValue<ProjectionContext, string>;

export interface EventBuilder<
  EventPayload extends object = Record<never, never>,
  CommandPayload extends object = JsonObject,
  State extends object = JsonObject,
  EventName extends string = string,
> {
  payload<AddedPayload extends object>(
    values: Readonly<{
      [Key in keyof AddedPayload]: AuthoringValue<
        TypedEventContext<CommandPayload, State>,
        AddedPayload[Key]
      >;
    }>,
  ): EventBuilder<
    Omit<EventPayload, keyof AddedPayload> & AddedPayload,
    CommandPayload,
    State,
    EventName
  >;
  schemaRef(
    reference: SchemaReference,
  ): EventBuilder<EventPayload, CommandPayload, State, EventName>;
  build(): TypedEventDefinition<EventPayload, CommandPayload, State, EventName>;
}

export interface BehaviorBuilder<
  Payload extends object = JsonObject,
  State extends object = JsonObject,
> {
  operation(operationId: OperationId): BehaviorBuilder<Payload, State>;
  condition(
    condition: (input: Readonly<TypedMatchContext<Payload, State>>) => boolean,
  ): BehaviorBuilder<Payload, State>;
  method(method: HttpMethod): BehaviorBuilder<Payload, State>;
  headers(headers: Readonly<Record<string, string>>): BehaviorBuilder<Payload, State>;
  requires(...guards: readonly GuardDefinition[]): BehaviorBuilder<Payload, State>;
  scopes(...scopes: readonly ScopeName[]): BehaviorBuilder<Payload, State>;
  emit(eventType: EventType): BehaviorBuilder<Payload, State>;
  emitWhen(...emissions: readonly BehaviorEmissionDefinition[]): BehaviorBuilder<Payload, State>;
  dispatch(...commands: readonly SecondaryCommandDefinition[]): BehaviorBuilder<Payload, State>;
  postcondition(
    condition: (input: Readonly<TypedEventContext<Payload, State>>) => boolean,
  ): BehaviorBuilder<Payload, State>;
  link(
    name: LinkRelation,
    condition?: AuthoringPredicate<MatchContext>,
  ): BehaviorBuilder<Payload, State>;
  status(status: number): BehaviorBuilder<Payload, State>;
  build(): BehaviorDefinition;
}

export interface BoundaryBuilder {
  schema(value: SchemaReference): BoundaryBuilder;
  fallbackOverride(enabled?: boolean): BoundaryBuilder;
  identity(value: IdentityDefinition): BoundaryBuilder;
  query(value: QueryDefinition): BoundaryBuilder;
  queryMapping(value: QueryMappingDefinition): BoundaryBuilder;
  eventCatalog(...values: readonly EventDefinition[]): BoundaryBuilder;
  behavior(...values: readonly BehaviorDefinition[]): BoundaryBuilder;
  reducer(...values: readonly ReducerDefinition[]): BoundaryBuilder;
  initialization(...values: readonly InitializationDefinition[]): BoundaryBuilder;
  response(value: ResponseDefinition): BoundaryBuilder;
  mask(...fields: readonly FieldPath[]): BoundaryBuilder;
  deprecated(value: DeprecationDefinition): BoundaryBuilder;
  latency(value: LatencyDefinition): BoundaryBuilder;
  auditFields(enabled?: boolean): BoundaryBuilder;
  strictSchema(enabled?: boolean): BoundaryBuilder;
  state(value: StateDefinition): BoundaryBuilder;
  faults(...values: readonly FaultDefinition[]): BoundaryBuilder;
  reactions(...values: readonly ReactionDefinition[]): BoundaryBuilder;
  include(...values: readonly ComponentInclude[]): BoundaryBuilder;
  build(): BoundaryDefinition;
}

export interface SimulationBuilder {
  boundary(value: BoundaryDefinition | BoundaryBuilder): SimulationBuilder;
  boundaries(...values: readonly (BoundaryDefinition | BoundaryBuilder)[]): SimulationBuilder;
  component(value: ComponentDefinition): SimulationBuilder;
  components(...values: readonly ComponentDefinition[]): SimulationBuilder;
  use(...values: readonly UseDefinition[]): SimulationBuilder;
  global(value: GlobalDefinition): SimulationBuilder;
  resource(value: ResourceDefinition): SimulationBuilder;
  resources(...values: readonly ResourceDefinition[]): SimulationBuilder;
  helper(value: TypeScriptHelperRegistration): SimulationBuilder;
  build(): SimulationDefinition;
}

export interface EventFactory {
  <
    const Name extends string,
    const Definitions extends Readonly<Record<string, AuthoringValue<EventContext, JsonValue>>>,
  >(
    type: EventType<Name>,
    payload: Definitions,
    schemaRef?: SchemaReference,
  ): TypedEventDefinition<
    {
      readonly [Key in keyof Definitions]: Definitions[Key] extends (
        ...args: never[]
      ) => infer Result
        ? Result
        : Definitions[Key];
    },
    JsonObject,
    JsonObject,
    Name & string
  >;
  <
    EventPayload extends object,
    CommandPayload extends object = JsonObject,
    State extends object = JsonObject,
    const Name extends string = string,
  >(
    type: EventType<Name>,
    payload: Readonly<{
      [Key in keyof EventPayload]: AuthoringValue<
        TypedEventContext<CommandPayload, State>,
        EventPayload[Key]
      >;
    }>,
    schemaRef?: SchemaReference,
  ): TypedEventDefinition<EventPayload, CommandPayload, State>;
  <
    EventPayload extends object = Record<never, never>,
    CommandPayload extends object = JsonObject,
    State extends object = JsonObject,
    const Name extends string = string,
  >(
    type: EventType<Name>,
  ): EventBuilder<EventPayload, CommandPayload, State, Name>;
}

export interface BehaviorFactory {
  <Payload extends object = JsonObject, State extends object = JsonObject>(
    name: BehaviorName,
  ): BehaviorBuilder<Payload, State>;
  (value: BehaviorDefinition): BehaviorDefinition;
}

export type Pipe = <Input, Output>(
  input: Input,
  ...steps: readonly ((value: Input | unknown) => Output)[]
) => Output;
export type Compose = <Input, Output>(
  ...steps: readonly ((value: Input | unknown) => Output)[]
) => (input: Input) => Output;
