import type {
  Actor,
  Command,
  DomainEvent,
  ExecutionResult,
  JsonObject,
  JsonValue,
} from "../types.js";
import type { Patch, JournalEntry } from "./patches.js";
import type { RuntimeDataGenerator } from "./data.js";

/**
 * The source-independent execution model.
 *
 * This module intentionally has no dependency on a source language or
 * representation. Source compilers provide these values before the runtime
 * starts.
 */

export type RuntimeValue<Input, Output> = Output | ((input: Readonly<Input>) => Output);
export type RuntimePredicate<Input> = (input: Readonly<Input>) => boolean;

/**
 * A source-independent function which can be invoked by declarative CEL and
 * directly by TypeScript authoring code.
 */
export interface RuntimeHelperDefinition {
  readonly name: string;
  readonly invoke: (args: readonly JsonValue[]) => JsonValue;
}

export interface RuntimeHelpers {
  readonly now: () => string;
  readonly uuid: () => string;
  readonly random: () => number;
  /** Typed fake-data provider for direct TypeScript authoring. */
  readonly data: RuntimeDataGenerator;
  readonly clone: <T>(value: T) => T;
}

export interface RuntimeRequest {
  readonly command: Readonly<Command>;
  readonly headers: Readonly<Record<string, string>>;
  readonly actor?: Readonly<Actor>;
  /**
   * Source-neutral identity provenance. The gateway may request an effective
   * actor through `actor`; the engine fills this record after authentication so
   * events and audit consumers can retain both identities.
   */
  readonly identity?: Readonly<RuntimeRequestIdentity>;
  readonly sideEffects?: Readonly<{
    skipSagas?: boolean;
    skipWebhooks?: boolean;
    skipReactions?: boolean;
    skipProjections?: boolean;
    skipDispatch?: boolean;
  }>;
  /** Position of this command when it was expanded from one transport batch. */
  readonly batchItem?: Readonly<{ index: number; size: number }>;
  /** Transport-neutral request controls. HTTP gateways may populate these from headers. */
  readonly controls?: Readonly<RuntimeControls>;
}

export interface RuntimeRequestIdentity {
  readonly original?: Readonly<Actor>;
  readonly effective?: Readonly<Actor>;
}

export interface RuntimeBatchOptions {
  readonly transactional?: boolean;
  /** Original transport payload, used to validate an array request as one document. */
  readonly requestBody?: JsonValue;
}

export interface RuntimeControls {
  readonly dryRun?: boolean;
  readonly includeEvents?: boolean;
  readonly echo?: boolean;
  /** Optional per-request seed for deterministic helper randomness. */
  readonly seed?: string;
  readonly clockOffsetMs?: number;
  readonly skipSagas?: boolean;
  readonly skipWebhooks?: boolean;
  readonly skipReactions?: boolean;
  readonly skipProjections?: boolean;
  readonly skipDispatch?: boolean;
  readonly bulkTransactional?: boolean;
  readonly maxCascadeDepth?: number;
  readonly causedBy?: string;
  readonly readAtVersion?: number;
  readonly replayEvent?: string;
  readonly responseFormat?: "hal" | "jsonapi" | "plain";
  readonly paginationStyle?: "envelope" | "raw" | "link-header";
  readonly maskFields?: readonly string[];
  readonly skipRequestValidation?: boolean;
  readonly skipResponseValidation?: boolean;
  readonly allowAdditionalProperties?: boolean;
  readonly traceId?: string;
  readonly spanName?: string;
  readonly logLevel?: "debug" | "info" | "warn" | "error";
  readonly metricTag?: Readonly<{ key: string; value: string }>;
  readonly useFault?: string;
  /** Generic direct chaos controls exposed by the HTTP gateway. */
  readonly featureFlag?: string;
  readonly rateLimit?: boolean;
  readonly signal?: string;
  readonly forceResponse?: string;
  readonly scenario?: string;
  readonly forceStatus?: number;
  readonly errorClass?:
    | "timeout"
    | "throttle"
    | "outage"
    | "bad_gateway"
    | "conflict"
    | "auth"
    | "forbidden";
  readonly forceLatencyMs?: number;
  readonly jitterMs?: Readonly<{ min: number; max: number }>;
  readonly dropConnectionMs?: number;
  readonly successRate?: number;
  readonly retryAfterSeconds?: number;
  readonly bodyTruncateBytes?: number;
}

/** Maximum delay a request-scoped chaos control may ask the runtime to apply. */
export const MAX_RUNTIME_DELAY_MS = 30_000;

function boundedRuntimeDelay(value: number | undefined): number | undefined {
  return value !== undefined &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_RUNTIME_DELAY_MS
    ? value
    : undefined;
}

/**
 * Apply source-neutral bounds for request-scoped chaos controls.
 *
 * HTTP headers are parsed by the transport, but direct TypeScript callers can
 * provide the same `RuntimeControls` object without crossing that boundary.
 * Keeping this policy in the core makes both paths obey the same contract.
 */
export function normalizeRuntimeControls(
  value: RuntimeControls | undefined,
): RuntimeControls | undefined {
  if (value === undefined) return undefined;
  const { forceLatencyMs, jitterMs, dropConnectionMs, ...rest } = value;
  const boundedJitter =
    jitterMs !== undefined &&
    Number.isFinite(jitterMs.min) &&
    Number.isFinite(jitterMs.max) &&
    jitterMs.min >= 0 &&
    jitterMs.max >= jitterMs.min &&
    jitterMs.max <= MAX_RUNTIME_DELAY_MS
      ? jitterMs
      : undefined;
  const boundedForceLatency = boundedRuntimeDelay(forceLatencyMs);
  const boundedDropConnection = boundedRuntimeDelay(dropConnectionMs);
  return {
    ...rest,
    ...(boundedForceLatency === undefined ? {} : { forceLatencyMs: boundedForceLatency }),
    ...(boundedJitter === undefined ? {} : { jitterMs: boundedJitter }),
    ...(boundedDropConnection === undefined ? {} : { dropConnectionMs: boundedDropConnection }),
  };
}

/**
 * Authoring-neutral grouped defaults for request controls. Transport boundaries
 * may populate these groups from their own inputs, while a direct TypeScript
 * program can provide the same policy as values. The core never needs to know
 * the wire spelling of a control.
 */
export interface RuntimeControlDefaults {
  readonly transparency?: Pick<
    RuntimeControls,
    "dryRun" | "includeEvents" | "echo" | "seed" | "clockOffsetMs"
  >;
  readonly sideEffects?: Pick<
    RuntimeControls,
    | "skipSagas"
    | "skipWebhooks"
    | "skipReactions"
    | "skipProjections"
    | "skipDispatch"
    | "maxCascadeDepth"
    | "bulkTransactional"
  >;
  readonly identity?: Pick<RuntimeControls, "causedBy">;
  readonly timeTravel?: Pick<RuntimeControls, "readAtVersion" | "replayEvent">;
  readonly format?: Pick<RuntimeControls, "responseFormat" | "paginationStyle" | "maskFields">;
  readonly observability?: Pick<RuntimeControls, "traceId" | "spanName" | "logLevel" | "metricTag">;
  readonly validation?: Pick<
    RuntimeControls,
    "skipRequestValidation" | "skipResponseValidation" | "allowAdditionalProperties"
  >;
  readonly chaos?: Pick<
    RuntimeControls,
    | "featureFlag"
    | "useFault"
    | "rateLimit"
    | "signal"
    | "forceResponse"
    | "scenario"
    | "forceStatus"
    | "errorClass"
    | "forceLatencyMs"
    | "jitterMs"
    | "dropConnectionMs"
    | "successRate"
    | "retryAfterSeconds"
    | "bodyTruncateBytes"
  >;
}

export function flattenRuntimeControlDefaults(
  value: RuntimeControlDefaults | undefined,
): RuntimeControls | undefined {
  if (value === undefined) return undefined;
  return {
    ...value.transparency,
    ...value.sideEffects,
    ...value.identity,
    ...value.timeTravel,
    ...value.format,
    ...value.observability,
    ...value.validation,
    ...value.chaos,
  };
}

export interface MatchContext {
  readonly command: Readonly<Command>;
  readonly request: Readonly<RuntimeRequest>;
  readonly state: Readonly<JsonObject> | null;
  readonly payload: Readonly<JsonObject>;
  readonly helpers: Readonly<RuntimeHelpers>;
}

export interface EventContext extends MatchContext {
  readonly event?: Readonly<DomainEvent>;
  readonly payload: Readonly<JsonObject>;
}

export interface IdentityContext extends MatchContext {
  readonly boundary: string;
}

export interface RuntimeReducerContext {
  readonly boundary: string;
  readonly state: Readonly<JsonObject>;
  readonly event: Readonly<DomainEvent>;
  readonly payload: Readonly<JsonObject>;
  readonly helpers: Readonly<RuntimeHelpers>;
}

export interface QueryContext {
  readonly command: Readonly<Command>;
  readonly request: Readonly<RuntimeRequest>;
  readonly state: Readonly<JsonObject>;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  /** The query value currently being evaluated by a declarative mapping. */
  readonly param?: string | readonly string[];
  readonly helpers: Readonly<RuntimeHelpers>;
}

export interface ResponseContext extends EventContext {
  readonly operationId?: string;
  readonly response: Readonly<{
    status: number;
    body: JsonValue | null;
    headers: Readonly<Record<string, string>>;
  }>;
}

export interface PostCommitContext extends EventContext {
  readonly response?: Readonly<{
    status: number;
    body: JsonValue | null;
    headers: Readonly<Record<string, string>>;
  }>;
  readonly committedEvents: readonly DomainEvent[];
}

export interface FaultContext extends MatchContext {
  readonly headers: Readonly<Record<string, string>>;
}

export interface WebhookContext extends PostCommitContext {
  readonly headers: Readonly<Record<string, string>>;
}

export interface SagaContext extends PostCommitContext {
  readonly steps: Readonly<Record<string, Readonly<{ status: number; body: JsonValue | null }>>>;
  readonly prevStep?: Readonly<{ status: number; body: JsonValue | null }>;
}

export interface ProjectionContext extends PostCommitContext {
  readonly projection: string;
}

export interface RuntimeIdentity {
  readonly generate?: (input: Readonly<IdentityContext>) => string;
  readonly key?: {
    readonly from: "path" | "query" | "header" | "payload";
    readonly name?: string;
    readonly pointer?: string;
  };
}

/** Source-independent metadata for explicit Specmatic example drives. */
export interface RuntimeExportStep {
  readonly operationId: string;
  readonly body?: JsonObject;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RuntimeExportStatePlan {
  readonly name: string;
  readonly steps: readonly RuntimeExportStep[];
  readonly saga?: string;
}

export interface RuntimeExportConfig {
  readonly states: readonly RuntimeExportStatePlan[];
}

export interface RuntimeEvent {
  readonly type: string;
  readonly payload: Readonly<Record<string, RuntimeValue<EventContext, JsonValue>>>;
  readonly schemaRef?: string;
}

export interface RuntimeGuard {
  readonly name: string;
  readonly check: RuntimePredicate<MatchContext | FaultContext>;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly errorStatus?: number;
}

export interface RuntimeEmission {
  readonly when: RuntimePredicate<MatchContext>;
  readonly event: string;
}

export interface RuntimeSecondaryCommand {
  readonly boundary: string;
  readonly intent: Command["intent"];
  readonly operationId: string;
  readonly targetId?: RuntimeValue<MatchContext, string | null>;
  readonly payload?: Readonly<Record<string, RuntimeValue<MatchContext, JsonValue>>>;
  readonly condition?: RuntimePredicate<MatchContext>;
}

export interface RuntimeBehavior {
  readonly name: string;
  readonly operationId: string;
  readonly condition?: RuntimePredicate<MatchContext>;
  readonly requires?: readonly RuntimeGuard[];
  readonly requiredScopes?: readonly string[];
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly emit?: string;
  readonly emitWhen?: readonly RuntimeEmission[];
  readonly dispatchCommands?: readonly RuntimeSecondaryCommand[];
  readonly postcondition?: RuntimePredicate<PostCommitContext>;
  readonly linkName?: string;
  readonly linkCondition?: RuntimePredicate<MatchContext>;
  readonly responseStatus?: number;
}

export interface RuntimeReducer<State extends object = object> {
  readonly on: string;
  readonly apply?: (input: Readonly<RuntimeReducerContext>) => readonly Patch[];
  /** Native TypeScript state transition. Source-specific authoring may return
   * the complete next JSON object without constructing patch operations. */
  reduce?(input: Readonly<RuntimeReducerContext>): State;
  readonly replaceState?: boolean;
}

export interface RuntimeQueryPolicy {
  readonly fields?: Readonly<Record<string, RuntimePredicate<QueryContext>>>;
  readonly filter?: RuntimePredicate<QueryContext>;
  readonly sort?: (
    left: Readonly<JsonObject>,
    right: Readonly<JsonObject>,
    input: Readonly<QueryContext>,
  ) => number;
  readonly pageSize?: RuntimeValue<QueryContext, number>;
  readonly maxPageSize?: number;
  readonly cursor?: RuntimeValue<QueryContext, string | undefined>;
  readonly expand?: readonly string[];
  readonly pagination?: "raw" | "envelope";
  readonly includeDeleted?: boolean;
  readonly fallback?: (input: Readonly<QueryContext>) => JsonValue | undefined;
}

export interface RuntimeResponse {
  readonly status?: number;
  readonly body?: JsonValue | null;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RuntimeResponsePolicy {
  readonly transform?: (input: Readonly<ResponseContext>) => RuntimeResponse | null | undefined;
  readonly mask?: readonly string[];
  readonly auditFields?: boolean;
  readonly deprecated?: RuntimeDeprecation;
  readonly hateoas?: readonly RuntimeLink[];
  readonly latency?: RuntimeLatency;
  readonly status?: RuntimeValue<ResponseContext, number>;
  readonly headers?: Readonly<Record<string, RuntimeValue<ResponseContext, string>>>;
}

export interface RuntimeDeprecation {
  readonly date: string;
  readonly sunset?: string;
  readonly replacement?: string;
}

export interface RuntimeLatency {
  readonly minMs?: number;
  readonly maxMs?: number;
  readonly fixedMs?: number;
}

export interface RuntimeLink {
  readonly rel: string;
  readonly href: RuntimeValue<ResponseContext, string>;
  readonly condition?: RuntimePredicate<ResponseContext>;
}

export interface RuntimeComputedField {
  readonly name: string;
  readonly formula: RuntimeValue<RuntimeReducerContext, JsonValue>;
  readonly dependsOn: readonly string[];
}

export interface RuntimeStateSchema {
  readonly computed?: readonly RuntimeComputedField[];
  readonly internal?: readonly Readonly<{ name: string; type?: string }>[];
  readonly validate?: (state: Readonly<JsonObject>) => void;
}

export interface RuntimeFault {
  readonly name: string;
  readonly matches: RuntimePredicate<FaultContext>;
  readonly requires?: readonly RuntimeGuard[];
  readonly probability?: number;
  readonly requiredScopes?: readonly string[];
  /** Optional transport matcher metadata for declarative fault overrides. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Typed selectors used by direct TypeScript callers instead of wire headers. */
  readonly selectors?: Readonly<{
    readonly signal?: string;
    readonly forceResponse?: string;
    readonly scenario?: string;
    readonly featureFlag?: string;
    readonly errorClass?: NonNullable<RuntimeControls["errorClass"]>;
  }>;
  readonly response: Readonly<{
    status: number;
    body?: JsonValue;
    headers?: Readonly<Record<string, string>>;
  }>;
  readonly delayMs?: number;
}

export interface RuntimeReaction {
  readonly name?: string;
  readonly on: string;
  readonly when?: RuntimePredicate<PostCommitContext>;
  readonly boundary: string;
  readonly emit: string;
  readonly intent?: "mutation" | "creation";
  readonly target?: RuntimeValue<PostCommitContext, string | null>;
  readonly payload?: Readonly<Record<string, RuntimeValue<PostCommitContext, JsonValue>>>;
}

export interface RuntimeWebhook {
  readonly name: string;
  readonly trigger: RuntimePredicate<WebhookContext>;
  readonly url: RuntimeValue<WebhookContext, string>;
  readonly payload?: Readonly<Record<string, RuntimeValue<WebhookContext, JsonValue>>>;
  readonly secret?: string;
  readonly retry?: Readonly<{ maxAttempts?: number; delayMs?: number }>;
}

export interface RuntimeSagaCompensation {
  readonly intent: Command["intent"];
  readonly operationId: string;
  readonly targetId?: RuntimeValue<SagaContext, string | null>;
  readonly payload?: Readonly<Record<string, RuntimeValue<SagaContext, JsonValue>>>;
}

export interface RuntimeSagaStep {
  readonly name: string;
  readonly boundary: string;
  readonly intent: Command["intent"];
  readonly operationId: string;
  readonly targetId?: RuntimeValue<SagaContext, string | null>;
  readonly payload?: Readonly<Record<string, RuntimeValue<SagaContext, JsonValue>>>;
  readonly compensation?: RuntimeSagaCompensation;
}

export interface RuntimeSaga {
  readonly name: string;
  readonly trigger: {
    readonly boundary: string;
    readonly intent: Command["intent"];
    readonly condition?: RuntimePredicate<SagaContext>;
  };
  readonly steps: readonly RuntimeSagaStep[];
}

export interface RuntimeDerivedProjection {
  readonly name: string;
  readonly key: RuntimeValue<ProjectionContext, string>;
  readonly subscribe: readonly string[];
  readonly reduce: readonly RuntimeReducer[];
  readonly reset?: () => void;
}

export interface RuntimeIdempotency {
  readonly enabled: boolean;
  readonly ttlSeconds: number;
  readonly hashIncludesBody: boolean;
}

export interface RuntimeAuth {
  readonly mode?: "simple" | "jwt" | "session";
  readonly authenticate?: (input: Readonly<RuntimeRequest>) => Readonly<Actor> | undefined;
  readonly authorize?: (input: Readonly<MatchContext>, scopes: readonly string[]) => boolean;
  readonly jwt?: Readonly<{
    secret: string;
    algorithm?: "HS256";
    issuer?: string;
    audience?: string;
    requiredClaims?: Readonly<Record<string, string>>;
    subjectClaim?: string;
    scopesClaim?: string;
  }>;
  readonly session?: Readonly<{
    cookieName?: string;
    ttlSeconds?: number;
    csrf?: boolean;
    csrfHeader?: string;
    loginPath?: string;
    logoutPath?: string;
  }>;
}

/** Host-owned authentication policy implementation used while compiling the model. */
export interface RuntimeAuthenticationPort {
  readonly authenticate: (
    request: Readonly<RuntimeRequest>,
    policy: Readonly<RuntimeAuth>,
  ) => Readonly<Actor> | undefined;
}

export interface RuntimeSecurityHeaders {
  readonly enabled?: boolean;
  readonly hsts?: boolean;
  readonly includeSubDomains?: boolean;
  readonly nosniff?: boolean;
  readonly frameDeny?: boolean;
  readonly referrerPolicy?: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
}

export interface RuntimeHateoas {
  readonly enabled?: boolean;
  readonly baseUrl?: string;
  readonly selfLinks?: boolean;
}

export interface RuntimeVersioning {
  readonly enabled?: boolean;
  readonly versions?: readonly Readonly<{ version: string; prefix: string; default?: boolean }>[];
}

export interface RuntimeFallback {
  readonly rules?: readonly Readonly<{
    readonly match: Readonly<{ path?: string; method?: string; inContract?: boolean }>;
    readonly respond: Readonly<{
      status: number;
      body?: JsonValue;
      headers?: Readonly<Record<string, string>>;
    }>;
  }>[];
  readonly default?: Readonly<{
    status: number;
    body?: JsonValue;
    headers?: Readonly<Record<string, string>>;
  }>;
}

export interface RuntimeContract {
  readonly operationIdFor: (path: string, method: string) => string | undefined;
  /** Resolve the contract's preferred successful status for a runtime intent. */
  readonly responseStatusFor?: (
    operationId: string,
    intent: Command["intent"],
  ) => number | undefined;
  /** Resolve an operation's route for a secondary command target. */
  readonly pathForOperation?: (operationId: string, targetId?: string | null) => string | undefined;
  readonly validateRequest?: (
    operationId: string,
    payload: JsonObject,
    request?: Readonly<RuntimeRequest>,
  ) => void;
  /** Validate the original transport payload before it is expanded into commands. */
  readonly validateBatchRequest?: (
    operationId: string,
    payload: JsonValue,
    request?: Readonly<RuntimeRequest>,
  ) => void;
  readonly validateResponse?: (
    operationId: string,
    status: number,
    body: JsonValue,
    request?: Readonly<RuntimeRequest>,
    options?: Readonly<{ allowAdditionalProperties?: boolean }>,
  ) => void;
  /** Validate the aggregated response body for a transport batch. */
  readonly validateBatchResponse?: (
    operationId: string,
    status: number,
    body: JsonValue,
    request?: Readonly<RuntimeRequest>,
    options?: Readonly<{ allowAdditionalProperties?: boolean }>,
  ) => void;
  /** Shape a runtime error with the transport contract's declared error schema. */
  readonly shapeError?: (
    operationId: string,
    status: number,
    body: JsonValue,
  ) => JsonValue | undefined;
  readonly requiresPrecondition?: (operationId: string) => boolean;
  readonly validateEvent?: (
    boundary: string,
    eventType: string,
    payload: JsonObject,
    schemaRef?: string,
  ) => void;
  readonly validateEntity?: (boundary: string, entity: JsonObject) => void;
  readonly responseSupportsHateoas?: (
    operationId: string,
    status: number,
    body: JsonValue,
  ) => boolean;
  readonly responseAllowsPaginationEnvelope?: (operationId: string) => boolean;
}

export interface RuntimeEventStore {
  readonly append: (events: readonly DomainEvent[]) => void;
  readonly events: (boundary?: string, aggregateId?: string) => readonly DomainEvent[];
  readonly currentSequenceVersion: (aggregateId: string) => number;
  readonly clear: () => void;
}

export interface RuntimeStateStore {
  readonly get: (aggregateId: string) => JsonObject | undefined;
  readonly set: (aggregateId: string, state: JsonObject) => void;
  readonly delete: (aggregateId: string) => void;
  readonly entries: () => readonly (readonly [string, JsonObject])[];
  readonly clear: () => void;
}

export interface RuntimeIdempotencyStore {
  /** Read using an optional request-local clock for expiry decisions. */
  readonly get: (key: string, nowMs?: number) => ExecutionResult | undefined;
  readonly set: (key: string, result: ExecutionResult, ttlSeconds: number) => void;
  readonly clear: () => void;
}

export interface RuntimeFaultEntry {
  readonly id: string;
  readonly rule: RuntimeFault;
  readonly createdAt: number;
  readonly expiresAt?: number;
}

export interface RuntimeFaultStore {
  readonly add: (rule: RuntimeFault, ttlMs?: number) => string;
  readonly remove: (id: string) => boolean;
  /** The optional time is request-local; it never changes the shared clock. */
  readonly list: (nowMs?: number) => readonly RuntimeFaultEntry[];
  readonly all: (nowMs?: number) => readonly RuntimeFault[];
  readonly clear: () => void;
}

/**
 * Virtual clock owned by one runtime instance.
 *
 * The core uses this for event timestamps and injected helpers. HTTP admin
 * routes may advance or reset it, while a request can add its own temporary
 * offset through RuntimeControls.clockOffsetMs.
 */
export interface RuntimeClock {
  readonly nowMs: () => number;
  readonly offsetMs: () => number;
  readonly advance: (milliseconds: number) => number;
  readonly reset: () => void;
}

export interface RuntimeSession {
  readonly id: string;
  readonly actor: Readonly<Actor>;
  readonly csrfToken?: string;
  readonly expiresAt?: number;
}

export interface RuntimeSessionStore {
  readonly create?: (actor: Readonly<Actor>, ttlSeconds: number) => RuntimeSession;
  /** Read using an optional request-local clock for expiry decisions. */
  readonly get?: (id: string, nowMs?: number) => RuntimeSession | undefined;
  readonly destroy?: (id: string) => void;
  readonly clear?: () => void;
}

export interface RuntimeWebhookTransport {
  readonly deliver: (
    input: Readonly<{
      url: string;
      body: string;
      headers: Readonly<Record<string, string>>;
      attempts: number;
    }>,
  ) => Promise<void>;
}

export interface RuntimeForwardingPort {
  readonly forward: (input: Readonly<RuntimeRequest>) => Promise<ExecutionResult>;
}

/** Correlation carried by one source-independent request/response observation. */
export interface RuntimeCorrelationContext {
  readonly traceId?: string;
  readonly commandId?: string;
}

/**
 * The completed observation handed to the injected observability port.
 *
 * `request` is the inbound request object supplied to `RuntimeEngine.execute`;
 * `result` is the result after the runtime has completed behavior execution,
 * side effects, response shaping, chaos, masking, and validation.
 */
export interface RuntimeRequestResponseObservation {
  readonly request: Readonly<RuntimeRequest>;
  readonly result: Readonly<RuntimeExecutionResult>;
  readonly correlation: Readonly<RuntimeCorrelationContext>;
}

export type RuntimeRequestResponseObserver = (
  observation: Readonly<RuntimeRequestResponseObservation>,
) => void | Promise<void>;

export type RuntimeCaptureDirection = "request" | "response";

/**
 * Explicit policy for transport body capture. Without this policy, transport
 * observers receive metadata but no body. A redactor runs before the byte cap.
 */
export interface RuntimeRequestResponseCapturePolicy {
  readonly maxBytes: number;
  readonly redact?: (
    direction: RuntimeCaptureDirection,
    body: JsonValue | null,
  ) => JsonValue | null;
}

export interface RuntimeCapturedBody {
  readonly captured: boolean;
  readonly value?: JsonValue | null;
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface RuntimeTransportRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: RuntimeCapturedBody;
}

export interface RuntimeTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: RuntimeCapturedBody;
  readonly connectionClosed?: boolean;
}

/** Final transport exchange, after the HTTP gateway has serialized the result. */
export interface RuntimeTransportObservation {
  readonly request: Readonly<RuntimeTransportRequest>;
  readonly response: Readonly<RuntimeTransportResponse>;
  readonly correlation: Readonly<RuntimeCorrelationContext>;
}

export type RuntimeTransportObserver = (
  observation: Readonly<RuntimeTransportObservation>,
) => void | Promise<void>;

export interface RuntimeObservability {
  readonly log?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => void;
  readonly trace?: <T>(name: string, run: () => Promise<T>) => Promise<T>;
  readonly metric?: (
    name: string,
    value?: number,
    fields?: Readonly<Record<string, string>>,
  ) => void;
  /** Observe the original request and the final result as one correlated exchange. */
  readonly observeRequestResponse?: RuntimeRequestResponseObserver;
  /** Observe the request and response actually serialized by an HTTP gateway. */
  readonly observeTransportRequestResponse?: RuntimeTransportObserver;
  /** Body capture is opt-in and bounded; it is never inferred from debug logging. */
  readonly requestResponseCapture?: RuntimeRequestResponseCapturePolicy;
}

export interface RuntimeDependencies {
  readonly contract: RuntimeContract;
  readonly helpers: RuntimeHelpers;
  readonly events?: RuntimeEventStore;
  readonly state?: RuntimeStateStore;
  readonly idempotency?: RuntimeIdempotencyStore;
  readonly faults?: RuntimeFaultStore;
  /** The runtime clock is always supplied by the boot boundary. */
  readonly clock: RuntimeClock;
  readonly sessions?: RuntimeSessionStore;
  readonly authentication?: RuntimeAuthenticationPort;
  readonly webhooks?: RuntimeWebhookTransport;
  readonly forwarding?: RuntimeForwardingPort;
  readonly observability?: RuntimeObservability;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface RuntimeLifecycle {
  readonly boot?: () => void | Promise<void>;
  readonly validation?: () => void | Promise<void>;
  readonly initialization?: () => void | Promise<void>;
  readonly request?: (input: Readonly<MatchContext>) => void | Promise<void>;
  readonly projection?: (input: Readonly<PostCommitContext>) => void | Promise<void>;
  readonly commit?: (input: Readonly<PostCommitContext>) => void | Promise<void>;
  readonly postCommit?: (input: Readonly<PostCommitContext>) => void | Promise<void>;
  readonly reset?: () => void | Promise<void>;
  readonly shutdown?: () => void | Promise<void>;
}

/** Static-analysis policy for one extracted aggregate machine. */
export interface RuntimeModelCoverage {
  readonly strict?: boolean;
  readonly initialStates?: readonly string[];
  readonly terminalStates?: readonly string[];
  readonly operations?: readonly string[];
  readonly suppressStates?: readonly string[];
}

export interface RuntimeBoundary {
  readonly boundary: string;
  readonly contractPath: string;
  readonly schema?: string;
  readonly fallbackOverride?: boolean;
  readonly identity?: RuntimeIdentity;
  readonly query?: RuntimeQueryPolicy;
  readonly queryMapping?: Readonly<Record<string, RuntimeValue<QueryContext, boolean>>>;
  readonly eventCatalog: readonly RuntimeEvent[];
  readonly behaviors: readonly RuntimeBehavior[];
  readonly reducers: readonly RuntimeReducer[];
  readonly initialization?: readonly (JsonObject | RuntimeSeed)[];
  readonly response?: RuntimeResponsePolicy;
  readonly mask?: readonly string[];
  readonly latency?: RuntimeLatency;
  readonly auditFields?: boolean;
  readonly deprecated?: RuntimeDeprecation;
  readonly state?: RuntimeStateSchema;
  readonly strictSchema?: boolean;
  readonly faults?: readonly RuntimeFault[];
  readonly reactions?: readonly RuntimeReaction[];
  readonly include?: never;
  readonly export?: RuntimeExportConfig;
}

export interface RuntimeSeed {
  readonly state: JsonObject;
  readonly id?: string;
  readonly eventType?: string;
  readonly timestamp?: string;
}

export interface RuntimePolicies {
  readonly auth?: RuntimeAuth;
  readonly idempotency?: RuntimeIdempotency;
  readonly securityHeaders?: RuntimeSecurityHeaders;
  readonly hateoas?: RuntimeHateoas;
  readonly versioning?: RuntimeVersioning;
  readonly fallback?: RuntimeFallback;
  readonly sagas?: readonly RuntimeSaga[];
  readonly derivedProjections?: readonly RuntimeDerivedProjection[];
  readonly faults?: readonly RuntimeFault[];
  readonly reactions?: readonly RuntimeReaction[];
  readonly webhooks?: readonly RuntimeWebhook[];
  readonly lifecycle?: RuntimeLifecycle;
  /** Transport-neutral defaults applied to each request at the boundary. */
  readonly controlDefaults?: Readonly<RuntimeControlDefaults>;
  /** Optional per-aggregate policy for the source-independent model checker. */
  readonly coverage?: Readonly<Record<string, RuntimeModelCoverage>>;
}

export interface RuntimeProgram {
  readonly boundaries: readonly RuntimeBoundary[];
  readonly byBoundaryName: ReadonlyMap<string, RuntimeBoundary>;
  readonly byContractPath: ReadonlyMap<string, RuntimeBoundary>;
  readonly policies: RuntimePolicies;
  /** Named functions contributed by TypeScript factories for CEL and TS use. */
  readonly helpers?: readonly RuntimeHelperDefinition[];
  readonly dependencies: RuntimeDependencies;
}

export interface RuntimeExecutionResult extends ExecutionResult {
  readonly committed: boolean;
  /** Base response retained for the forwarding boundary's patch envelope. */
  readonly unmaskedBody?: JsonValue | null;
  /** The transport must close the connection instead of serialising a body. */
  readonly connectionClosed?: boolean;
  readonly trace?: readonly string[];
}

export interface ProjectionResult {
  readonly journal: readonly JournalEntry[];
}
