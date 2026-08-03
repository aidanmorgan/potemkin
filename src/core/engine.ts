import { createHmac } from "node:crypto";
import { deterministicUuidv7 } from "../ids/uuidv7.js";
import { createSeededRandom } from "../model/data.js";
import type {
  Actor,
  Command,
  DomainEvent,
  ExecutionResult,
  JsonObject,
  JsonValue,
} from "../types.js";
import { applyPatches } from "../model/patches.js";
import {
  cloneValue as clone,
  createMemoryEventStore,
  createMemoryIdempotencyStore,
  createMemoryStateStore,
} from "./storage.js";
import {
  addSecurityHeaders,
  applyDebugEnvelope,
  applyPaginationControl,
  applyResponseFormat,
  decorateStandaloneResponse,
  maskBody,
  maskValues,
  truncateSerializedBody,
} from "./responsePolicies.js";
import type {
  EventContext,
  FaultContext,
  MatchContext,
  PostCommitContext,
  ProjectionContext,
  QueryContext,
  RuntimeBehavior,
  RuntimeBoundary,
  RuntimeExecutionResult,
  RuntimeFault,
  RuntimeHelpers,
  RuntimePolicies,
  RuntimeProgram,
  RuntimeReducerContext,
  RuntimeRequest,
  RuntimeBatchOptions,
  RuntimeControls,
  RuntimeResponse,
  RuntimeSeed,
  RuntimeSession,
  RuntimeSaga,
  RuntimeSagaStep,
  RuntimeValue,
  RuntimeLifecycle,
  SagaContext,
  WebhookContext,
  RuntimeFaultStore,
  RuntimeEventStore,
  RuntimeStateStore,
  RuntimeIdempotencyStore,
} from "../model/runtime.js";
import { normalizeRuntimeControls } from "../model/runtime.js";
import { createRuntimeFaultStore } from "./faults.js";
import { RuntimeExecutionError } from "./errors.js";
import {
  compareQueryValues,
  decodeCursor,
  encodeCursor,
  expandFields,
  queryOperator,
  queryValue,
  readPath,
  selectFields,
} from "./queryPolicies.js";

const MAX_DEPTH = 5;
const MAX_REACTION_EVENTS = 1_000;
const GLOBAL_BOUNDARY = "__global__";
type RuntimeLogLevel = NonNullable<RuntimeControls["logLevel"]>;

function resolveValue<Input, Output>(value: RuntimeValue<Input, Output>, input: Input): Output {
  return typeof value === "function" ? (value as (value: Input) => Output)(input) : value;
}

function asObject(value: JsonValue | null | undefined): JsonObject {
  if (value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)) {
    return clone(value as JsonObject);
  }
  return {};
}

function isJsonObject(value: JsonValue | null | undefined): value is JsonObject {
  return (
    value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
  );
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

function hasScopes(actor: Actor | undefined, scopes: readonly string[]): boolean {
  if (scopes.length === 0) return true;
  const actual = new Set(actor?.scopes ?? []);
  return scopes.every((scope) => actual.has(scope));
}

function pointerRead(
  value: JsonValue | null | undefined,
  pointer: string | undefined,
): JsonValue | undefined {
  if (pointer === undefined || pointer === "") return value ?? undefined;
  const segments = pointer.startsWith("/")
    ? pointer
        .slice(1)
        .split("/")
        .map((item) => item.replace(/~1/g, "/").replace(/~0/g, "~"))
    : pointer.split(".");
  let current: JsonValue | undefined = value ?? undefined;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = Array.isArray(current) ? current[Number(segment)] : (current as JsonObject)[segment];
  }
  return current;
}

function pathParameter(
  path: string,
  template: string,
  name: string | undefined,
): string | undefined {
  if (name === undefined) return path.split("/").filter(Boolean).at(-1);
  const actual = path.split("/").filter(Boolean);
  const expected = template.split("/").filter(Boolean);
  const index = expected.findIndex((segment) => segment === `{${name}}` || segment === `:${name}`);
  return index >= 0 ? actual[index] : undefined;
}

function eventKey(event: DomainEvent): string {
  return `${event.boundary}:${event.type}`;
}

function matchesSubscription(subscription: string, event: DomainEvent): boolean {
  return subscription === event.type || subscription === eventKey(event);
}

function serialise(value: unknown): string {
  return JSON.stringify(value, Object.keys((value ?? {}) as object).sort());
}

function matchesHeaders(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(([name, wanted]) => {
    const value = headerValue(actual, name);
    return wanted === "present" || wanted === "*" ? value !== undefined : value === wanted;
  });
}

function matchesFaultSelectors(
  selectors: NonNullable<RuntimeFault["selectors"]> | undefined,
  controls: RuntimeControls | undefined,
): boolean {
  if (selectors === undefined) return true;
  if (selectors.signal !== undefined && selectors.signal !== controls?.signal) return false;
  if (selectors.forceResponse !== undefined && selectors.forceResponse !== controls?.forceResponse)
    return false;
  if (selectors.scenario !== undefined && selectors.scenario !== controls?.scenario) return false;
  if (selectors.featureFlag !== undefined && selectors.featureFlag !== controls?.featureFlag)
    return false;
  if (selectors.errorClass !== undefined && selectors.errorClass !== controls?.errorClass)
    return false;
  return true;
}

function routeFallback(
  policies: RuntimePolicies,
  request: RuntimeRequest,
  inContract: boolean,
): RuntimeExecutionResult {
  const fallback = policies.fallback;
  const rule = fallback?.rules?.find((candidate) => {
    const match = candidate.match;
    if (
      match.method !== undefined &&
      match.method.toUpperCase() !== request.command.httpMethod.toUpperCase()
    )
      return false;
    if (match.inContract !== undefined && match.inContract !== inContract) return false;
    if (match.path !== undefined && !globMatch(match.path, request.command.path)) return false;
    return true;
  });
  const response: { status: number; body?: JsonValue; headers?: Readonly<Record<string, string>> } =
    rule?.respond ??
    fallback?.default ??
    (inContract
      ? { status: 501, body: { message: "Operation is not implemented" } }
      : { status: 404, body: { error: "NO_ROUTE", code: "NO_ROUTE", message: "Not found" } });
  return {
    status: response.status,
    body: response.body ?? null,
    headers: response.headers ?? {},
    events: [],
    committed: false,
  };
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(value);
}

function commandWith(command: Command, changes: Partial<Command>): Command {
  return { ...command, ...changes };
}

interface Pending {
  readonly command: Command;
  readonly request: RuntimeRequest;
}

interface Transaction {
  readonly states: Map<string, JsonObject>;
  readonly events: DomainEvent[];
  readonly reactionKeys: Set<string>;
  reactionEvents: number;
}

interface PendingPostCommit {
  readonly boundary: RuntimeBoundary;
  readonly request: RuntimeRequest;
  readonly events: readonly DomainEvent[];
  readonly response: RuntimeExecutionResult;
}

interface PendingIdempotency {
  readonly fingerprint: string;
  readonly result: ExecutionResult;
  readonly ttlSeconds: number;
}

interface PendingObservation {
  readonly request: RuntimeRequest;
  readonly result: RuntimeExecutionResult;
}

interface ActiveBatch {
  readonly postCommits: PendingPostCommit[];
  readonly idempotency: Map<string, PendingIdempotency>;
  readonly observations: PendingObservation[];
}

function isRuntimeSeed(value: JsonObject | RuntimeSeed): value is RuntimeSeed {
  const candidate = value as unknown as JsonObject;
  if (!isJsonObject(candidate) || !isJsonObject(candidate.state)) return false;
  return Object.keys(candidate).every(
    (key) => key === "state" || key === "id" || key === "eventType" || key === "timestamp",
  );
}

function seedState(value: JsonObject | RuntimeSeed): JsonObject {
  return isRuntimeSeed(value) ? clone(value.state) : clone(value);
}

function seedId(value: JsonObject | RuntimeSeed, boundary: string, index: number): string {
  if (isRuntimeSeed(value) && value.id !== undefined) return value.id;
  if (!isRuntimeSeed(value) && typeof value.id === "string") return value.id;
  return `baseline-${boundary}-${index}`;
}

export class RuntimeEngine {
  /** The active source-independent program. Replaced atomically by reload(). */
  program: RuntimeProgram;
  private readonly events: RuntimeEventStore;
  private readonly state: RuntimeStateStore;
  private readonly idempotency: RuntimeIdempotencyStore;
  private readonly faults: RuntimeFaultStore;
  private helpers: RuntimeHelpers;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly projections = new Map<string, Map<string, JsonObject>>();
  private readonly aggregateBoundaries = new Map<string, string>();
  private readonly idempotencyFingerprints = new Map<string, string>();
  private activeBatch: ActiveBatch | undefined;
  private initializationPromise: Promise<void>;
  private initialized = false;
  private resetGeneration = 0;

  constructor(program: RuntimeProgram) {
    this.program = program;
    this.events = program.dependencies.events ?? createMemoryEventStore();
    this.state = program.dependencies.state ?? createMemoryStateStore();
    this.idempotency =
      program.dependencies.idempotency ??
      createMemoryIdempotencyStore(program.dependencies.clock.nowMs);
    this.faults =
      program.dependencies.faults ??
      createRuntimeFaultStore(program.dependencies.clock.nowMs, program.dependencies.helpers.uuid);
    this.helpers = program.dependencies.helpers;
    this.initializationPromise = this.initialize();
  }

  /** Request controls are overlays, never process-wide mutations. */
  private helpersFor(request: RuntimeRequest | undefined): RuntimeHelpers {
    const controls = request?.controls;
    const offset = this.program.dependencies.clock.offsetMs() + (controls?.clockOffsetMs ?? 0);
    const seed = controls?.seed;
    if (offset === 0 && seed === undefined) return this.helpers;
    const seededRandom = seed === undefined ? undefined : createSeededRandom(seed);
    return {
      ...this.helpers,
      now:
        offset === 0
          ? this.helpers.now
          : () => {
              const current = Date.parse(this.helpers.now());
              return new Date(
                (Number.isFinite(current) ? current : this.program.dependencies.clock.nowMs()) +
                  offset,
              ).toISOString();
            },
      random: seededRandom ?? this.helpers.random,
      uuid:
        seed === undefined
          ? this.helpers.uuid
          : (() => {
              let uuidIndex = 0;
              return () => deterministicUuidv7(`${seed}:${uuidIndex++}`);
            })(),
      data:
        seededRandom === undefined ? this.helpers.data : this.helpers.data.withRandom(seededRandom),
    };
  }

  /**
   * Request-local time is an observation overlay. It is used for expiry
   * decisions as well as generated timestamps, without advancing the runtime
   * clock shared by other requests.
   */
  private nowMsFor(request: RuntimeRequest | undefined): number {
    return this.program.dependencies.clock.nowMs() + (request?.controls?.clockOffsetMs ?? 0);
  }

  async execute(request: RuntimeRequest): Promise<RuntimeExecutionResult> {
    // The batch barrier is shared by ordinary requests and bulk execution. A
    // normal request must not interleave with a transactional bulk checkpoint.
    // Secondary saga/compensation commands use executeUnlocked below while the
    // owning top-level request holds this barrier.
    const release = await this.acquire("__runtime_batch__");
    try {
      return await this.executeUnlocked(request);
    } finally {
      release();
    }
  }

  private async executeUnlocked(request: RuntimeRequest): Promise<RuntimeExecutionResult> {
    const trace = this.program.dependencies.observability?.trace;
    const operation =
      request.command.operationId ??
      this.program.dependencies.contract.operationIdFor(
        request.command.path,
        request.command.httpMethod,
      ) ??
      "unknown";
    try {
      const result =
        trace === undefined
          ? await this.executeInternal(request)
          : await trace("runtime.execute", () => this.executeInternal(request));
      const metricFields = {
        operation,
        method: request.command.httpMethod,
        status: String(result.status),
        outcome: result.status >= 400 ? "faulted" : result.committed ? "committed" : "completed",
      } satisfies Readonly<Record<string, string>>;
      this.writeMetric(request, "runtime.requests.completed", 1, metricFields);
      if (result.status >= 400)
        this.writeMetric(request, "runtime.requests.failed", 1, metricFields);
      if (result.events.length > 0)
        this.writeMetric(request, "runtime.events.appended", result.events.length, metricFields);
      await this.observeOrDeferRequestResponse(request, result);
      return result;
    } catch (error) {
      // Keep the established error contract for callers while giving the
      // observability port the same final response-shaped view of failures as
      // it receives for ordinary and declarative-fault responses.
      const result = this.errorResult(error, request);
      const metricFields = {
        operation,
        method: request.command.httpMethod,
        status: String(result.status),
        outcome: "error",
      } satisfies Readonly<Record<string, string>>;
      this.writeMetric(request, "runtime.requests.completed", 1, metricFields);
      this.writeMetric(request, "runtime.requests.failed", 1, metricFields);
      await this.observeOrDeferRequestResponse(request, result);
      throw error;
    }
  }

  /**
   * Execute a collection of transport-bound commands as one batch. The
   * transactional form restores the exact event/state/projection checkpoint
   * when any item fails, so a failed bulk request cannot leave a partial graph.
   * Individual commands still use the same normal execution path and therefore
   * retain their validation, behavior matching, and response semantics.
   */
  async executeBatch(
    requests: readonly RuntimeRequest[],
    options: RuntimeBatchOptions = {},
  ): Promise<readonly RuntimeExecutionResult[]> {
    if (this.activeBatch !== undefined) throw new Error("Nested runtime batches are not supported");
    const release = await this.acquire("__runtime_batch__");
    const checkpoint = options.transactional === true ? this.snapshot() : undefined;
    const batch: ActiveBatch | undefined =
      options.transactional === true
        ? { postCommits: [], idempotency: new Map(), observations: [] }
        : undefined;
    this.activeBatch = batch;
    let currentRequest: RuntimeRequest | undefined = requests[0];
    try {
      const firstRequest = requests[0];
      const operationId = firstRequest?.command.operationId;
      if (
        options.requestBody !== undefined &&
        operationId !== undefined &&
        firstRequest !== undefined
      ) {
        this.program.dependencies.contract.validateBatchRequest?.(
          operationId,
          options.requestBody,
          firstRequest,
        );
      }
      const results: RuntimeExecutionResult[] = [];
      for (const request of requests) {
        currentRequest = request;
        results.push(await this.executeUnlocked(request));
      }
      // Primary state/event commits are complete. Make the batch visible to
      // post-commit hooks only after every item has succeeded, so a failed
      // transactional bulk request cannot deliver a webhook, run a saga, or
      // update a derived projection for work that is about to be rolled back.
      this.activeBatch = undefined;
      this.flushBatchIdempotency(batch);
      if (batch !== undefined)
        for (const pending of batch.postCommits) {
          await this.runPostCommit(
            pending.boundary,
            pending.request,
            pending.events,
            pending.response,
          );
        }
      if (batch !== undefined) {
        for (const pending of batch.observations)
          await this.observeRequestResponse(pending.request, pending.result);
      }
      return results;
    } catch (error) {
      this.activeBatch = undefined;
      if (checkpoint !== undefined) this.restore(checkpoint);
      if (currentRequest !== undefined)
        await this.observeRequestResponse(currentRequest, this.errorResult(error, currentRequest));
      throw error;
    } finally {
      this.activeBatch = undefined;
      release();
    }
  }

  private async observeRequestResponse(
    request: RuntimeRequest,
    result: RuntimeExecutionResult,
  ): Promise<void> {
    const observer = this.program.dependencies.observability?.observeRequestResponse;
    if (observer === undefined) return;
    const traceId = request.controls?.traceId;
    const commandId = request.command?.commandId;
    try {
      await observer({
        request,
        result,
        correlation: {
          ...(traceId === undefined ? {} : { traceId }),
          ...(commandId === undefined ? {} : { commandId }),
        },
      });
    } catch (error) {
      // Telemetry must not change the behavior of the simulated system. A
      // failed exporter is still visible to the ordinary observability log
      // port when one is configured.
      this.writeLog(request, "error", "Runtime request/response observation failed", {
        error: String(error),
      });
    }
  }

  private writeLog(
    request: RuntimeRequest | undefined,
    level: RuntimeLogLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void {
    const log = this.program.dependencies.observability?.log;
    if (log === undefined) return;
    log(request?.controls?.logLevel ?? level, message, fields);
  }

  private writeMetric(
    request: RuntimeRequest | undefined,
    name: string,
    value?: number,
    fields?: Readonly<Record<string, string>>,
  ): void {
    const metric = this.program.dependencies.observability?.metric;
    if (metric === undefined) return;
    const tag = request?.controls?.metricTag;
    metric(name, value, tag === undefined ? fields : { ...fields, [tag.key]: tag.value });
  }

  private async observeOrDeferRequestResponse(
    request: RuntimeRequest,
    result: RuntimeExecutionResult,
  ): Promise<void> {
    if (this.activeBatch !== undefined) {
      this.activeBatch.observations.push({ request, result });
      return;
    }
    await this.observeRequestResponse(request, result);
  }

  private errorResult(error: unknown, request: RuntimeRequest): RuntimeExecutionResult {
    const response =
      error instanceof RuntimeExecutionError
        ? {
            status: error.status,
            body: error.body,
            headers: error.headers,
            events: [],
            committed: false,
          }
        : (() => {
            const candidate = error as {
              readonly status?: unknown;
              readonly code?: unknown;
              readonly message?: unknown;
              readonly details?: unknown;
              readonly body?: unknown;
              readonly headers?: unknown;
            };
            const status = typeof candidate.status === "number" ? candidate.status : 500;
            const message =
              candidate.message === undefined ? String(error) : String(candidate.message);
            const detailObject =
              candidate.details !== null &&
              typeof candidate.details === "object" &&
              !Array.isArray(candidate.details)
                ? (candidate.details as JsonObject)
                : undefined;
            const body =
              candidate.body !== undefined &&
              candidate.body !== null &&
              typeof candidate.body === "object"
                ? (candidate.body as JsonValue)
                : ({
                    code:
                      typeof candidate.code === "string"
                        ? candidate.code
                        : "RUNTIME_EXECUTION_FAILED",
                    message,
                    ...(detailObject === undefined ? {} : { details: detailObject }),
                  } as JsonObject);
            const headers =
              candidate.headers !== null &&
              typeof candidate.headers === "object" &&
              !Array.isArray(candidate.headers)
                ? (candidate.headers as Readonly<Record<string, string>>)
                : {};
            return { status, body, headers, events: [], committed: false };
          })();
    return decorateStandaloneResponse(response, request, this.program.policies.securityHeaders);
  }

  private async executeInternal(request: RuntimeRequest): Promise<RuntimeExecutionResult> {
    await this.initializationPromise;
    const sessionResult = this.handleSessionEndpoint(request);
    if (sessionResult !== undefined) return sessionResult;
    const authenticated = this.authenticate(request);
    const effectiveActor = request.actor ?? request.identity?.effective ?? authenticated;
    const originalActor = request.identity?.original ?? authenticated ?? effectiveActor;
    const effectiveRequest: RuntimeRequest =
      effectiveActor === undefined && originalActor === undefined
        ? request
        : {
            ...request,
            ...(effectiveActor === undefined ? {} : { actor: effectiveActor }),
            identity: {
              ...(originalActor === undefined ? {} : { original: originalActor }),
              ...(effectiveActor === undefined ? {} : { effective: effectiveActor }),
            },
            command: {
              ...request.command,
              ...(effectiveActor === undefined ? {} : { actor: effectiveActor }),
            },
          };
    const boundary = this.program.byBoundaryName.get(effectiveRequest.command.boundary);
    if (boundary === undefined) {
      if (this.program.dependencies.forwarding !== undefined) {
        return this.program.dependencies.forwarding.forward(
          effectiveRequest,
        ) as Promise<RuntimeExecutionResult>;
      }
      return decorateStandaloneResponse(
        routeFallback(this.program.policies, effectiveRequest, false),
        effectiveRequest,
        this.program.policies.securityHeaders,
      );
    }

    const operationId =
      effectiveRequest.command.operationId ??
      this.program.dependencies.contract.operationIdFor(
        effectiveRequest.command.path,
        effectiveRequest.command.httpMethod,
      );
    const command =
      operationId === undefined
        ? effectiveRequest.command
        : commandWith(effectiveRequest.command, { operationId });
    const controls = normalizeRuntimeControls(effectiveRequest.controls);
    const normalizedRequest: RuntimeRequest = {
      ...effectiveRequest,
      command,
      ...(controls === undefined ? {} : { controls }),
      sideEffects: {
        ...effectiveRequest.sideEffects,
        ...(controls?.skipSagas === true ? { skipSagas: true } : {}),
        ...(controls?.skipWebhooks === true ? { skipWebhooks: true } : {}),
        ...(controls?.skipReactions === true ? { skipReactions: true } : {}),
        ...(controls?.skipProjections === true ? { skipProjections: true } : {}),
        ...(controls?.skipDispatch === true ? { skipDispatch: true } : {}),
      },
    };
    // Secondary commands are emitted by sagas, reactions, dispatch rules, and
    // projections. Their payloads are domain messages, not a second inbound
    // HTTP request, so validating them against the originating OpenAPI body
    // schema rejects legitimate internal messages (and prevents the side
    // effect from ever running).
    if (
      command.operationId !== undefined &&
      command.origin === "inbound" &&
      controls?.skipRequestValidation !== true
    ) {
      this.program.dependencies.contract.validateRequest?.(
        command.operationId,
        command.payload,
        normalizedRequest,
      );
    }
    const context = this.context(boundary, normalizedRequest, this.readState(command.targetId));
    this.writeLog(normalizedRequest, "debug", "Runtime request matched boundary", {
      boundary: boundary.boundary,
      operationId: command.operationId,
      commandId: command.commandId,
    });
    await this.runLifecycle("request", context);

    // Authorization for an already authenticated actor is a security gate, not
    // transport chaos. Resolve the selected behavior's authorization
    // requirement before a forced status, error class, or connection drop can
    // replace a 403. Missing authentication retains the established fault
    // precedence; JWT mode rejects a missing/invalid token in authenticate()
    // before this point. The behavior is still executed only once in the normal
    // query/mutation path below; this pass is limited to the read-only check.
    const authorizationBehavior = this.findBehavior(boundary, normalizedRequest, context);
    if (authorizationBehavior !== undefined && normalizedRequest.actor !== undefined)
      this.assertAuthorized(normalizedRequest, authorizationBehavior, context);

    const fault = this.findFault(boundary, normalizedRequest, context);
    if (fault !== undefined) {
      await this.delayForResponse(boundary, normalizedRequest, fault.delayMs ?? 0);
      return decorateStandaloneResponse(
        {
          status: fault.response.status,
          body: fault.response.body ?? null,
          headers: {
            ...fault.response.headers,
            ...(normalizedRequest.controls?.retryAfterSeconds === undefined
              ? {}
              : {
                  "Retry-After": String(Math.floor(normalizedRequest.controls.retryAfterSeconds)),
                }),
          },
          events: [],
          committed: false,
          ...(fault.name === "drop-connection" ? { connectionClosed: true } : {}),
        },
        normalizedRequest,
        this.program.policies.securityHeaders,
      );
    }

    const idempotencyKey = this.idempotencyKey(normalizedRequest);
    if (idempotencyKey !== undefined) {
      this.checkIdempotencyFingerprint(idempotencyKey, normalizedRequest);
      const cached = this.cachedIdempotency(idempotencyKey, normalizedRequest);
      if (cached !== undefined) {
        await this.delayForResponse(boundary, normalizedRequest);
        return {
          ...cached,
          committed: false,
          headers: { ...cached.headers, "X-Potemkin-Idempotency-Replay": "true" },
        };
      }
    }

    if (command.intent === "query") {
      const replayed = await this.replayEvent(boundary, normalizedRequest);
      if (replayed !== undefined) {
        if (
          idempotencyKey !== undefined &&
          replayed.status >= 200 &&
          replayed.status < 300 &&
          controls?.dryRun !== true
        ) {
          this.storeIdempotency(
            idempotencyKey,
            this.idempotencyFingerprint(normalizedRequest),
            replayed,
            this.program.policies.idempotency?.ttlSeconds ?? 86_400,
          );
        }
        return replayed;
      }
      const result = await this.executeQuery(boundary, normalizedRequest);
      return result;
    }

    const targetId = this.resolveIdentity(boundary, normalizedRequest);
    const withTarget = { ...normalizedRequest, command: commandWith(command, { targetId }) };
    const lockKeys = [targetId ?? GLOBAL_BOUNDARY];
    if (idempotencyKey !== undefined) lockKeys.push(`__idempotency__${idempotencyKey}`);
    // Secondary commands execute inside the owning mutation's cascade lock.
    // Re-acquiring that non-reentrant lock would deadlock sagas and dispatch
    // chains precisely when internal commands are allowed to run.
    if (this.canCascade() && request.command.origin !== "secondary") lockKeys.push("__cascade__");
    const lock = await this.acquireMany(lockKeys);
    try {
      if (idempotencyKey !== undefined) {
        this.checkIdempotencyFingerprint(idempotencyKey, normalizedRequest);
        const cached = this.cachedIdempotency(idempotencyKey, normalizedRequest);
        if (cached !== undefined) {
          await this.delayForResponse(boundary, normalizedRequest);
          return {
            ...cached,
            committed: false,
            headers: { ...cached.headers, "X-Potemkin-Idempotency-Replay": "true" },
          };
        }
      }
      const result = await this.executeMutation(boundary, withTarget, targetId);
      this.writeMetric(request, "runtime.commands.committed", 1, {
        boundary: boundary.boundary,
      });
      if (
        idempotencyKey !== undefined &&
        this.program.policies.idempotency?.enabled !== false &&
        controls?.dryRun !== true
      ) {
        this.storeIdempotency(
          idempotencyKey,
          this.idempotencyFingerprint(normalizedRequest),
          result,
          this.program.policies.idempotency?.ttlSeconds ?? 86_400,
        );
      }
      return result;
    } finally {
      lock();
    }
  }

  /** Run boot, validation, and initialization hooks for explicit startup management. */
  async start(): Promise<void> {
    await this.initializationPromise;
    await this.runLifecycle("boot", undefined);
    await this.runLifecycle("validation", undefined);
    await this.runLifecycle("initialization", undefined);
  }

  async reset(): Promise<void> {
    this.resetGeneration += 1;
    this.events.clear();
    this.state.clear();
    this.idempotency.clear();
    this.idempotencyFingerprints.clear();
    this.faults.clear();
    this.program.dependencies.sessions?.clear?.();
    this.program.dependencies.clock.reset();
    this.projections.clear();
    this.aggregateBoundaries.clear();
    for (const projection of this.program.policies.derivedProjections ?? [])
      await projection.reset?.();
    await this.runLifecycle("reset", undefined);
    this.initialized = false;
    this.initializationPromise = this.initialize();
    await this.initializationPromise;
  }

  /**
   * Atomically install a newly compiled runtime program while preserving the
   * event log. The new callbacks and policies are projected over that log
   * before the method returns, so requests never observe a half-reloaded
   * state graph. Source-specific parsing belongs to the caller; this method
   * accepts only the canonical RuntimeProgram.
   */
  async replaceProgram(
    next: RuntimeProgram,
    options: Readonly<{ preserveEvents?: boolean }> = {},
  ): Promise<void> {
    await this.initializationPromise;
    const release = await this.acquire("__runtime_batch__");
    const previous = this.program;
    if (options.preserveEvents === false) {
      try {
        this.program = next;
        this.helpers = next.dependencies.helpers ?? this.helpers;
        this.events.clear();
        this.state.clear();
        this.idempotency.clear();
        this.idempotencyFingerprints.clear();
        this.faults.clear();
        this.program.dependencies.sessions?.clear?.();
        this.program.dependencies.clock.reset();
        this.projections.clear();
        this.aggregateBoundaries.clear();
        this.resetGeneration += 1;
        await this.runLifecycle("reset", undefined);
        this.initialized = false;
        this.initializationPromise = this.initialize();
        await this.initializationPromise;
        return;
      } finally {
        release();
      }
    }
    const checkpoint = this.snapshot();
    const previousHelpers = this.helpers;
    try {
      for (const event of checkpoint.events) {
        if (event.boundary !== "__saga__" && !next.byBoundaryName.has(event.boundary)) {
          throw new Error(
            `Cannot reload runtime: event ${event.eventId} refers to unknown boundary "${event.boundary}"`,
          );
        }
      }

      this.program = next;
      this.helpers = next.dependencies.helpers ?? previousHelpers;
      this.state.clear();
      this.projections.clear();
      this.aggregateBoundaries.clear();

      const transaction: Transaction = {
        states: new Map(),
        events: [],
        reactionKeys: new Set(),
        reactionEvents: 0,
      };
      for (const event of checkpoint.events) {
        if (event.boundary === "__saga__") continue;
        const boundary = next.byBoundaryName.get(event.boundary);
        if (boundary === undefined) continue;
        const command: Command = {
          commandId: event.causedBy ?? event.eventId,
          boundary: event.boundary,
          intent: event.intent ?? "mutation",
          targetId: event.aggregateId,
          payload: event.payload,
          queryParams: event.request?.query ?? {},
          httpMethod: event.request?.method ?? "POST",
          path: event.request?.path ?? boundary.contractPath,
          origin: "secondary",
          depth: 0,
          ...(event.request?.actorId === undefined
            ? {}
            : { actor: { id: event.request.actorId, scopes: event.request.actorScopes ?? [] } }),
        };
        this.applyEvent(
          boundary,
          event,
          { command, request: { command, headers: event.request?.headers ?? {} } },
          transaction,
        );
        if (!this.aggregateBoundaries.has(event.aggregateId))
          this.aggregateBoundaries.set(event.aggregateId, event.boundary);
      }
      for (const [id, state] of transaction.states) this.state.set(id, state);

      const sourceEvent = checkpoint.events.find(
        (event) => event.boundary !== "__saga__" && next.byBoundaryName.has(event.boundary),
      );
      if (sourceEvent !== undefined && next.policies.derivedProjections !== undefined) {
        const boundary = next.byBoundaryName.get(sourceEvent.boundary);
        if (boundary !== undefined) {
          const source: PostCommitContext = {
            command: {
              commandId: "runtime-reload",
              boundary: boundary.boundary,
              intent: "mutation",
              targetId: null,
              payload: {},
              queryParams: {},
              httpMethod: "POST",
              path: boundary.contractPath,
              origin: "secondary",
              depth: 0,
            },
            request: { command: {} as Command, headers: {} },
            state: null,
            payload: {},
            helpers: this.helpers,
            committedEvents: checkpoint.events,
          };
          await this.runProjections(
            checkpoint.events.filter((event) => event.boundary !== "__saga__"),
            source,
          );
        }
      }
      await this.runLifecycle("validation", undefined);
      this.initialized = true;
      this.initializationPromise = Promise.resolve();
    } catch (error) {
      this.program = previous;
      this.helpers = previousHelpers;
      this.restore(checkpoint);
      throw error;
    } finally {
      release();
    }
  }

  async shutdown(): Promise<void> {
    await this.runLifecycle("shutdown", undefined);
  }

  snapshot(): Readonly<{
    state: readonly (readonly [string, JsonObject])[];
    events: readonly DomainEvent[];
    projections: Readonly<Record<string, readonly (readonly [string, JsonObject])[]>>;
  }> {
    return {
      state: this.state.entries(),
      events: this.events.events(),
      projections: Object.fromEntries(
        [...this.projections.entries()].map(([name, values]) => [name, [...values.entries()]]),
      ),
    };
  }

  /** Restore a previously captured in-memory checkpoint after a failed batch. */
  restore(
    snapshot: Readonly<{
      state: readonly (readonly [string, JsonObject])[];
      events: readonly DomainEvent[];
      projections: Readonly<Record<string, readonly (readonly [string, JsonObject])[]>>;
    }>,
  ): void {
    this.events.clear();
    this.events.append(snapshot.events);
    this.state.clear();
    for (const [id, value] of snapshot.state) this.state.set(id, value);
    this.projections.clear();
    for (const [name, entries] of Object.entries(snapshot.projections))
      this.projections.set(name, new Map(entries));
    this.aggregateBoundaries.clear();
    for (const event of snapshot.events)
      if (!this.aggregateBoundaries.has(event.aggregateId))
        this.aggregateBoundaries.set(event.aggregateId, event.boundary);
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const existingEvents = this.events.events();
    for (const event of existingEvents)
      if (!this.aggregateBoundaries.has(event.aggregateId))
        this.aggregateBoundaries.set(event.aggregateId, event.boundary);
    const baseline: DomainEvent[] = [];
    if (existingEvents.length === 0)
      for (const boundary of this.program.boundaries) {
        for (const [index, seed] of (boundary.initialization ?? []).entries()) {
          const state = seedState(seed);
          const id = seedId(seed, boundary.boundary, index);
          baseline.push({
            eventId: `baseline-${boundary.boundary}-${index}-event`,
            type:
              isRuntimeSeed(seed) && seed.eventType !== undefined
                ? seed.eventType
                : "BaselineEntityCreatedEvent",
            boundary: boundary.boundary,
            aggregateId: id,
            payload: state,
            timestamp:
              isRuntimeSeed(seed) && seed.timestamp !== undefined
                ? seed.timestamp
                : "1970-01-01T00:00:00.000Z",
            sequenceVersion: 1,
            causedBy: null,
          });
        }
      }
    if (baseline.length > 0) this.events.append(baseline);
    const history = existingEvents.length > 0 ? existingEvents : baseline;
    if (history.length > 0 && this.state.entries().length === 0) {
      const transaction: Transaction = {
        states: new Map(),
        events: [],
        reactionKeys: new Set(),
        reactionEvents: 0,
      };
      for (const event of history) {
        const boundary = this.program.byBoundaryName.get(event.boundary);
        if (boundary !== undefined)
          this.applyEvent(
            boundary,
            event,
            { command: {} as Command, request: { command: {} as Command, headers: {} } },
            transaction,
          );
      }
      for (const [id, state] of transaction.states) this.state.set(id, state);
    }
    for (const event of history)
      if (!this.aggregateBoundaries.has(event.aggregateId))
        this.aggregateBoundaries.set(event.aggregateId, event.boundary);
    if (history.length > 0 && this.program.policies.derivedProjections !== undefined) {
      const boundary = this.program.byBoundaryName.get(
        history.find((event) => this.program.byBoundaryName.has(event.boundary))?.boundary ??
          this.program.boundaries[0]?.boundary ??
          "",
      );
      if (boundary !== undefined) {
        const source: PostCommitContext = {
          command: {
            commandId: "baseline",
            boundary: boundary.boundary,
            intent: "creation",
            targetId: null,
            payload: {},
            queryParams: {},
            httpMethod: "POST",
            path: boundary.contractPath,
            origin: "inbound",
            depth: 0,
          },
          request: { command: {} as Command, headers: {} },
          state: null,
          payload: {},
          helpers: this.helpers,
          committedEvents: history,
        };
        await this.runProjections(
          history.filter((event) => event.boundary !== "__saga__"),
          source,
        );
      }
    }
    this.initialized = true;
  }

  private authenticate(request: RuntimeRequest): Actor | undefined {
    const auth = this.program.policies.auth;
    if (auth?.mode === "session") {
      const cookieName = auth.session?.cookieName ?? "sid";
      const sessionId = this.cookieValue(headerValue(request.headers, "cookie"), cookieName);
      if (sessionId !== undefined) {
        const session = this.program.dependencies.sessions?.get?.(
          sessionId,
          this.nowMsFor(request),
        );
        if (session !== undefined) {
          const csrfHeader = auth.session?.csrfHeader;
          const changing = new Set(["POST", "PUT", "PATCH", "DELETE"]).has(
            request.command.httpMethod.toUpperCase(),
          );
          if (
            auth.session?.csrf !== false &&
            csrfHeader !== undefined &&
            changing &&
            headerValue(request.headers, csrfHeader) !== session.csrfToken
          ) {
            throw new RuntimeExecutionError(403, "CSRF token missing or invalid", {
              code: "CSRF_TOKEN_INVALID",
              message: "CSRF token missing or invalid",
            });
          }
          return session.actor;
        }
      }
      return request.actor;
    }
    try {
      return auth?.authenticate?.(request) ?? request.actor;
    } catch (error) {
      const candidate = error as { readonly code?: unknown; readonly message?: unknown };
      throw new RuntimeExecutionError(
        401,
        candidate.message === undefined ? "Authentication failed" : String(candidate.message),
        {
          code: typeof candidate.code === "string" ? candidate.code : "AUTHENTICATION_FAILED",
          message:
            candidate.message === undefined ? "Authentication failed" : String(candidate.message),
          details: {
            code: typeof candidate.code === "string" ? candidate.code : "AUTHENTICATION_FAILED",
          },
        },
        { "WWW-Authenticate": "Bearer" },
      );
    }
  }

  private cookieValue(header: string | undefined, name: string): string | undefined {
    if (header === undefined) return undefined;
    const entry = header
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`));
    if (entry === undefined) return undefined;
    return decodeURIComponent(entry.slice(name.length + 1));
  }

  private handleSessionEndpoint(request: RuntimeRequest): RuntimeExecutionResult | undefined {
    const auth = this.program.policies.auth;
    const sessions = this.program.dependencies.sessions;
    if (auth?.mode !== "session" || sessions?.create === undefined) return undefined;
    const session = auth.session;
    const loginPath = session?.loginPath ?? "/sessions";
    const logoutPath = session?.logoutPath ?? "/sessions/current";
    if (request.command.httpMethod.toUpperCase() === "POST" && request.command.path === loginPath) {
      const actorId = request.command.payload.actorId;
      if (typeof actorId !== "string" || actorId.length === 0)
        throw new RuntimeExecutionError(400, "actorId is required", {
          code: "CONTRACT_VIOLATION",
          message: "actorId is required",
        });
      const scopes = Array.isArray(request.command.payload.scopes)
        ? request.command.payload.scopes.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const created = sessions.create({ id: actorId, scopes }, session?.ttlSeconds ?? 3_600);
      return this.sessionResult(created, session?.cookieName ?? "sid");
    }
    if (
      request.command.httpMethod.toUpperCase() === "DELETE" &&
      request.command.path === logoutPath
    ) {
      const cookieName = session?.cookieName ?? "sid";
      const sessionId = this.cookieValue(headerValue(request.headers, "cookie"), cookieName);
      if (sessionId !== undefined) sessions.destroy?.(sessionId);
      return {
        status: 204,
        body: null,
        headers: { "Set-Cookie": `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` },
        events: [],
        committed: false,
      };
    }
    return undefined;
  }

  private sessionResult(session: RuntimeSession, cookieName: string): RuntimeExecutionResult {
    return {
      status: 200,
      body: {
        sessionId: session.id,
        ...(session.csrfToken !== undefined ? { csrfToken: session.csrfToken } : {}),
        actor: { id: session.actor.id, scopes: [...session.actor.scopes] },
        ...(session.expiresAt !== undefined
          ? { expiresAt: new Date(session.expiresAt).toISOString() }
          : {}),
      },
      headers: {
        "Set-Cookie": `${cookieName}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${this.program.policies.auth?.session?.ttlSeconds ?? 3_600}`,
      },
      events: [],
      committed: false,
    };
  }

  private context(
    boundary: RuntimeBoundary,
    request: RuntimeRequest,
    state: JsonObject | null,
  ): MatchContext {
    void boundary;
    return {
      command: request.command,
      request,
      state,
      payload: request.command.payload,
      helpers: this.helpersFor(request),
    };
  }

  private readState(id: string | null): JsonObject | null {
    return id === null ? null : (this.state.get(id) ?? null);
  }

  private async replayEvent(
    boundary: RuntimeBoundary,
    request: RuntimeRequest,
  ): Promise<RuntimeExecutionResult | undefined> {
    const eventId = request.controls?.replayEvent;
    if (eventId === undefined) return undefined;
    const event = this.events.events().find((candidate) => candidate.eventId === eventId);
    if (event === undefined) {
      return decorateStandaloneResponse(
        {
          status: 404,
          body: { code: "EVENT_NOT_FOUND", message: `Event '${eventId}' was not found` },
          headers: {},
          events: [],
          committed: false,
        },
        request,
        this.program.policies.securityHeaders,
      );
    }
    const eventBoundary = this.program.byBoundaryName.get(event.boundary);
    if (eventBoundary === undefined) {
      return decorateStandaloneResponse(
        {
          status: 422,
          body: {
            code: "EVENT_REPLAY_UNSUPPORTED",
            message: `Event '${eventId}' cannot be replayed`,
          },
          headers: {},
          events: [],
          committed: false,
        },
        request,
        this.program.policies.securityHeaders,
      );
    }

    const replayCommand: Command = {
      ...request.command,
      boundary: eventBoundary.boundary,
      targetId: event.aggregateId,
      intent: "mutation",
      httpMethod: "PUT",
      path: eventBoundary.contractPath,
      operationId: request.command.operationId,
      origin: "inbound",
    };
    const replayRequest: RuntimeRequest = { ...request, command: replayCommand };
    const transaction: Transaction = {
      states: new Map(this.state.entries().map(([id, value]) => [id, value])),
      events: [],
      reactionKeys: new Set(),
      reactionEvents: 0,
    };
    const replayedEvent: DomainEvent = {
      ...clone(event),
      eventId: this.helpersFor(replayRequest).uuid(),
      timestamp: this.helpersFor(replayRequest).now(),
      sequenceVersion: this.nextSequence(event.aggregateId, transaction),
      causedBy: replayRequest.controls?.causedBy ?? replayCommand.commandId,
      intent: "mutation",
      request: {
        method: replayCommand.httpMethod,
        path: replayCommand.path,
        query: replayCommand.queryParams,
        headers: replayRequest.headers,
        payload: replayCommand.payload,
        actorId: replayRequest.actor?.id,
        actorScopes: replayRequest.actor?.scopes,
        originalActorId: replayRequest.identity?.original?.id,
        originalActorScopes: replayRequest.identity?.original?.scopes,
      },
    };
    this.applyEvent(
      eventBoundary,
      replayedEvent,
      { command: replayCommand, request: replayRequest },
      transaction,
    );
    const projectedState = transaction.states.get(event.aggregateId) ?? null;
    const response = await this.applyResponse(
      eventBoundary,
      replayRequest,
      {
        status: 200,
        body: projectedState,
        headers: { "X-Potemkin-Replayed-Event": eventId },
      },
      undefined,
      [replayedEvent],
      projectedState,
    );
    const commitContext: PostCommitContext = {
      command: replayCommand,
      request: replayRequest,
      state: projectedState,
      event: replayedEvent,
      payload: replayedEvent.payload,
      helpers: this.helpersFor(replayRequest),
      committedEvents: [replayedEvent],
      response: {
        status: response.status ?? 200,
        body: response.body ?? null,
        headers: response.headers ?? {},
      },
    };
    await this.runLifecycle("commit", commitContext);
    const committedEvent: DomainEvent = {
      ...replayedEvent,
      response: {
        status: response.status ?? 200,
        body: response.body ?? null,
        headers: response.headers ?? {},
      },
    };
    const dryRun = replayRequest.controls?.dryRun === true;
    if (!dryRun) {
      for (const [id, value] of transaction.states) this.state.set(id, value);
      this.events.append([committedEvent]);
      if (!this.aggregateBoundaries.has(committedEvent.aggregateId))
        this.aggregateBoundaries.set(committedEvent.aggregateId, committedEvent.boundary);
      const replayResponse: RuntimeExecutionResult = {
        status: response.status ?? 200,
        body: response.body ?? null,
        headers: response.headers ?? {},
        events: [committedEvent],
        committed: true,
      };
      const pending: PendingPostCommit = {
        boundary: eventBoundary,
        request: replayRequest,
        events: [committedEvent],
        response: replayResponse,
      };
      if (this.activeBatch === undefined)
        await this.runPostCommit(eventBoundary, replayRequest, [committedEvent], pending.response);
      else this.activeBatch.postCommits.push(pending);
    }
    return this.decorateResult(
      {
        status: response.status ?? 200,
        body: response.body ?? null,
        headers: response.headers ?? {},
        events: [committedEvent],
        committed: !dryRun,
      },
      eventBoundary,
      replayRequest,
      [committedEvent],
    );
  }

  private readStateAtVersion(
    boundary: RuntimeBoundary,
    aggregateId: string,
    version: number,
  ): JsonObject | null {
    const history = this.eventsAtVersion(boundary, aggregateId, version);
    if (history.length === 0) return null;
    const transaction: Transaction = {
      states: new Map(),
      events: [],
      reactionKeys: new Set(),
      reactionEvents: 0,
    };
    for (const event of history) {
      // A REST contract commonly has a collection boundary and a separate
      // `/resource/{id}` read boundary. Historical state belongs to the
      // aggregate's owning boundary, not to whichever boundary exposed the
      // read route, so replay each event through its declaring runtime model.
      const owner = this.program.byBoundaryName.get(event.boundary) ?? boundary;
      this.applyEvent(
        owner,
        event,
        {
          command: {
            commandId: event.causedBy ?? event.eventId,
            boundary: event.boundary,
            intent: "mutation",
            targetId: event.aggregateId,
            payload: event.payload,
            queryParams: {},
            httpMethod: "PUT",
            path: "",
            origin: "secondary",
            depth: 0,
          },
          request: { command: {} as Command, headers: {} },
        },
        transaction,
      );
    }
    return transaction.states.get(aggregateId) ?? null;
  }

  private eventsAtVersion(
    boundary: RuntimeBoundary,
    aggregateId: string,
    version: number,
  ): readonly DomainEvent[] {
    const owned = this.events
      .events(undefined, aggregateId)
      .filter((event) => this.program.byBoundaryName.has(event.boundary));
    const scoped = owned.length === 0 ? this.events.events(boundary.boundary, aggregateId) : owned;
    return scoped
      .filter((event) => event.sequenceVersion <= version)
      .sort((left, right) => left.sequenceVersion - right.sequenceVersion);
  }

  private resolveIdentity(boundary: RuntimeBoundary, request: RuntimeRequest): string {
    if (request.command.targetId !== null) return request.command.targetId;
    const identity = boundary.identity;
    if (identity?.generate !== undefined)
      return identity.generate({
        ...this.context(boundary, request, null),
        boundary: boundary.boundary,
      });
    const key = identity?.key;
    if (key !== undefined) {
      const source =
        key.from === "payload"
          ? request.command.payload
          : key.from === "query"
            ? request.command.queryParams
            : key.from === "header"
              ? request.headers
              : request.command.path;
      const value =
        key.from === "path"
          ? pathParameter(request.command.path, boundary.contractPath, key.name)
          : key.from === "header"
            ? headerValue(request.headers, key.name ?? key.pointer ?? "")
            : pointerRead(source as JsonValue, key.pointer ?? key.name);
      if (typeof value === "string" && value.length > 0) return value;
      if (typeof value === "number") return String(value);
    }
    return this.helpersFor(request).uuid();
  }

  private findFault(
    boundary: RuntimeBoundary,
    request: RuntimeRequest,
    context: MatchContext,
  ): RuntimeFault | undefined {
    const faults = [
      ...this.faults.all(this.nowMsFor(request)),
      ...(boundary.faults ?? []),
      ...(this.program.policies.faults ?? []),
    ];
    const faultContext: FaultContext = { ...context, headers: request.headers };
    const controls = request.controls;
    if (controls?.useFault !== undefined) {
      const named = faults.find((fault) => fault.name === controls.useFault);
      if (named !== undefined) return { ...named, matches: () => true };
    }
    // A declarative header rule owns the response shape for a matching chaos
    // header. This check must precede generic defaults so an authored rule can
    // override the body and headers without changing the core runtime model.
    const headerFault = faults.find((fault) => {
      if (fault.headers === undefined && fault.selectors === undefined) return false;
      if (!matchesFaultSelectors(fault.selectors, controls)) return false;
      if (fault.headers !== undefined && !matchesHeaders(request.headers, fault.headers))
        return false;
      if (!hasScopes(request.actor, fault.requiredScopes ?? [])) return false;
      if (fault.requires?.some((guard) => !guard.check(faultContext))) return false;
      if (fault.probability !== undefined && this.helpersFor(request).random() >= fault.probability)
        return false;
      try {
        return fault.matches(faultContext);
      } catch {
        return false;
      }
    });
    if (headerFault !== undefined) return headerFault;
    if (
      controls?.forceStatus !== undefined &&
      Number.isInteger(controls.forceStatus) &&
      controls.forceStatus >= 100 &&
      controls.forceStatus <= 599
    ) {
      return {
        name: "force-status",
        matches: () => true,
        response: {
          status: controls.forceStatus,
          body: { error: "FORCED_STATUS", status: controls.forceStatus },
          ...(controls.retryAfterSeconds === undefined
            ? {}
            : { headers: { "Retry-After": String(Math.floor(controls.retryAfterSeconds)) } }),
        },
      };
    }
    if (controls?.errorClass !== undefined) {
      const defaults: Readonly<
        Record<
          NonNullable<RuntimeControls["errorClass"]>,
          { status: number; error: string; message: string }
        >
      > = {
        timeout: { status: 504, error: "GATEWAY_TIMEOUT", message: "Upstream timed out (chaos)" },
        throttle: { status: 429, error: "TOO_MANY_REQUESTS", message: "Throttled (chaos)" },
        outage: { status: 503, error: "SERVICE_UNAVAILABLE", message: "Service outage (chaos)" },
        bad_gateway: { status: 502, error: "BAD_GATEWAY", message: "Upstream bad gateway (chaos)" },
        conflict: { status: 409, error: "CONFLICT", message: "Conflict (chaos)" },
        auth: { status: 401, error: "UNAUTHENTICATED", message: "Authentication required (chaos)" },
        forbidden: { status: 403, error: "FORBIDDEN", message: "Forbidden (chaos)" },
      };
      const selected = defaults[controls.errorClass];
      return {
        name: "error-class",
        matches: () => true,
        response: {
          status: selected.status,
          body: {
            error: selected.error,
            message: selected.message,
            errorClass: controls.errorClass,
          },
          ...(controls.retryAfterSeconds === undefined
            ? {}
            : { headers: { "Retry-After": String(Math.floor(controls.retryAfterSeconds)) } }),
        },
      };
    }
    if (
      controls?.dropConnectionMs !== undefined &&
      Number.isFinite(controls.dropConnectionMs) &&
      controls.dropConnectionMs >= 0
    ) {
      return {
        name: "drop-connection",
        matches: () => true,
        response: { status: 504, body: null, headers: { "x-potemkin-dropped": "true" } },
        delayMs: controls.dropConnectionMs,
      };
    }
    if (controls?.rateLimit === true || controls?.signal === "rate_limit") {
      return {
        name: "rate-limit",
        matches: () => true,
        response: {
          status: 429,
          body: { error: "TOO_MANY_REQUESTS", message: "Rate limit exceeded (chaos)" },
          ...(controls.retryAfterSeconds === undefined
            ? {}
            : { headers: { "Retry-After": String(Math.floor(controls.retryAfterSeconds)) } }),
        },
      };
    }
    if (
      controls?.successRate !== undefined &&
      this.helpersFor(request).random() >= controls.successRate
    ) {
      return {
        name: "success-rate",
        matches: () => true,
        response: {
          status: 503,
          body: { error: "SUCCESS_RATE_GATE", message: "Probabilistic chaos gate failed" },
        },
      };
    }
    return faults.find((fault) => {
      if (!matchesFaultSelectors(fault.selectors, controls)) return false;
      if (!hasScopes(request.actor, fault.requiredScopes ?? [])) return false;
      if (fault.headers !== undefined && !matchesHeaders(request.headers, fault.headers))
        return false;
      if (fault.requires?.some((guard) => !guard.check(faultContext))) return false;
      if (fault.probability !== undefined && this.helpersFor(request).random() >= fault.probability)
        return false;
      try {
        return fault.matches(faultContext);
      } catch {
        return false;
      }
    });
  }

  private async executeQuery(
    boundary: RuntimeBoundary,
    request: RuntimeRequest,
  ): Promise<RuntimeExecutionResult> {
    if (
      request.command.targetId !== null &&
      boundary.fallbackOverride === false &&
      boundary.behaviors.length > 0 &&
      !boundary.behaviors.some((behavior) => behavior.operationId === request.command.operationId)
    ) {
      throw new RuntimeExecutionError(
        422,
        `Operation ${request.command.operationId ?? request.command.path} is not valid for the current entity state`,
        {
          code: "INVALID_STATE_TRANSITION",
          message: `Operation ${request.command.operationId ?? request.command.path} is not valid for the current entity state`,
        },
      );
    }
    if (request.command.targetId !== null && request.controls?.readAtVersion !== undefined) {
      const historicalEvents = this.eventsAtVersion(
        boundary,
        request.command.targetId,
        request.controls.readAtVersion,
      );
      const historical = this.readStateAtVersion(
        boundary,
        request.command.targetId,
        request.controls.readAtVersion,
      );
      const response = await this.applyResponse(
        boundary,
        request,
        {
          status: historical === null ? 404 : 200,
          body: historical ?? {
            code: "ENTITY_ABSENCE",
            message: `Entity '${request.command.targetId}' not found`,
          },
          headers: {},
        },
        undefined,
        [],
        historical,
        historicalEvents,
      );
      return this.decorateResult(
        {
          status: response.status ?? 200,
          body: response.body ?? null,
          headers: {
            ...response.headers,
            "X-Potemkin-Read-At-Version": String(request.controls.readAtVersion),
          },
          events: [],
          committed: false,
          ...(response.unmaskedBody === undefined ? {} : { unmaskedBody: response.unmaskedBody }),
        },
        boundary,
        request,
        [],
      );
    }
    const queryContext = (state: JsonObject): QueryContext => ({
      command: request.command,
      request,
      state,
      query: request.command.queryParams,
      helpers: this.helpersFor(request),
    });
    const allowsGraphFallback =
      boundary.fallbackOverride === true && boundary.contractPath.includes("{");
    let entries = [...this.state.entries()].filter(
      ([id]) =>
        (request.command.targetId === null || id === request.command.targetId) &&
        // An identity fallback boundary deliberately reads the graph owned by
        // another boundary. Collection routes remain boundary-scoped: their
        // fallback flag controls an unhandled operation, not collection
        // ownership.
        (allowsGraphFallback || this.aggregateBoundaries.get(id) === boundary.boundary),
    );
    let rows = entries.map(([, value]) => value);
    const policy = boundary.query;
    if (policy?.filter !== undefined)
      rows = rows.filter((row) => policy.filter!(queryContext(row)));
    if (boundary.queryMapping !== undefined) {
      rows = rows.filter((row) =>
        Object.entries(boundary.queryMapping!).every(([name, predicate]) => {
          const requested = request.command.queryParams[name];
          return (
            requested === undefined ||
            Boolean(resolveValue(predicate, { ...queryContext(row), param: requested }))
          );
        }),
      );
      entries = entries.filter(([, value]) => rows.includes(value));
    }
    if (policy?.fields !== undefined) {
      rows = rows.filter((row) =>
        Object.entries(policy.fields!).every(([name, predicate]) => {
          return request.command.queryParams[name] === undefined || predicate(queryContext(row));
        }),
      );
      entries = entries.filter(([, value]) => rows.includes(value));
    }
    const includeDeleted =
      policy?.includeDeleted === true ||
      queryValue(request.command.queryParams.includeDeleted) === "true";
    if (!includeDeleted) {
      rows = rows.filter((row) => row["_deleted"] !== true);
      entries = entries.filter(([, value]) => rows.includes(value));
    }
    for (const [name, raw] of Object.entries(request.command.queryParams)) {
      const match = /^(.+):(gt|gte|lt|lte|ne|in|contains|arrayContains|startsWith|endsWith)$/.exec(
        name,
      );
      if (match === null) continue;
      const expected = queryValue(raw);
      if (expected === undefined) continue;
      rows = rows.filter((row) => queryOperator(readPath(row, match[1]!), match[2]!, expected));
    }
    entries = entries.filter(([, value]) => rows.includes(value));
    const q = queryValue(request.command.queryParams.q)?.toLowerCase();
    if (q !== undefined)
      rows = rows.filter((row) =>
        Object.values(row).some(
          (value) => typeof value === "string" && value.toLowerCase().includes(q),
        ),
      );
    entries = entries.filter(([, value]) => rows.includes(value));
    if (policy?.sort !== undefined)
      rows.sort((left, right) => policy.sort!(left, right, queryContext(left)));
    const sort = queryValue(request.command.queryParams.sort);
    if (sort !== undefined) {
      const sortItems = sort
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const keys = sortItems.map((item) => ({
        field: item.startsWith("-") ? item.slice(1) : item,
        direction: item.startsWith("-")
          ? -1
          : sortItems.length === 1 &&
              queryValue(request.command.queryParams.order)?.toLowerCase() === "desc"
            ? -1
            : 1,
      }));
      rows.sort((left, right) => {
        for (const key of keys) {
          const compared =
            key.direction *
            compareQueryValues(readPath(left, key.field), readPath(right, key.field));
          if (compared !== 0) return compared;
        }
        return 0;
      });
    }
    const requestedSize =
      policy?.pageSize === undefined
        ? Number(queryValue(request.command.queryParams.limit) ?? rows.length)
        : resolveValue(policy.pageSize, queryContext(rows[0] ?? {}));
    const maxSize = policy?.maxPageSize ?? requestedSize;
    const pageSize = Math.max(
      0,
      Math.min(Number.isFinite(requestedSize) ? requestedSize : rows.length, maxSize),
    );
    const offsetValue = Number(queryValue(request.command.queryParams.offset) ?? 0);
    const cursorValue =
      policy?.cursor === undefined
        ? queryValue(request.command.queryParams.cursor)
        : resolveValue(policy.cursor, queryContext(rows[0] ?? {}));
    const cursorId = cursorValue === undefined ? undefined : decodeCursor(cursorValue);
    const malformedCursor = cursorValue !== undefined && cursorId === undefined;
    const start = malformedCursor
      ? rows.length
      : cursorId === undefined
        ? Number.isFinite(offsetValue) && offsetValue >= 0
          ? offsetValue
          : 0
        : Math.max(
            0,
            rows.findIndex(
              (row) =>
                (typeof row.id === "string"
                  ? row.id
                  : entries.find(([, value]) => value === row)?.[0]) === cursorId,
            ) + 1,
          );
    const totalCount = rows.length;
    const selected = rows.slice(start, start + pageSize);
    const fields = (queryValue(request.command.queryParams.fields) ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const includes = [
      ...(policy?.expand ?? []),
      ...(queryValue(request.command.queryParams.include) ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ];
    const stateById = new Map(this.state.entries());
    const output = selected.map((row) =>
      selectFields(expandFields(row, includes, stateById), fields),
    );
    const fallback = output.length === 0 ? policy?.fallback?.(queryContext({})) : undefined;
    const shouldEnvelope =
      request.command.targetId === null &&
      (policy?.pagination === "envelope" || request.command.queryParams.limit !== undefined);
    const missingTarget =
      request.command.targetId !== null && output.length === 0 && fallback === undefined;
    const body =
      fallback ??
      (request.command.targetId === null
        ? shouldEnvelope
          ? {
              items: output,
              totalCount,
              offset: start,
              limit: pageSize,
              hasMore: !malformedCursor && start + output.length < totalCount,
              ...(!malformedCursor && start + output.length < totalCount && output.length > 0
                ? {
                    nextCursor: encodeCursor(
                      String(output.at(-1)?.id ?? entries[start + output.length - 1]?.[0] ?? ""),
                    ),
                  }
                : {}),
            }
          : output
        : (output[0] ?? null));
    const response = await this.applyResponse(
      boundary,
      request,
      {
        status: missingTarget ? 404 : 200,
        body: missingTarget
          ? { code: "ENTITY_ABSENCE", message: `Entity '${request.command.targetId}' not found` }
          : body,
        headers: {},
      },
      undefined,
      [],
    );
    return this.decorateResult(
      {
        status: response.status ?? 200,
        body: response.body ?? null,
        headers: response.headers ?? {},
        events: [],
        committed: false,
        ...(response.unmaskedBody === undefined ? {} : { unmaskedBody: response.unmaskedBody }),
      },
      boundary,
      request,
      [],
    );
  }

  private async executeMutation(
    boundary: RuntimeBoundary,
    request: RuntimeRequest,
    targetId: string,
  ): Promise<RuntimeExecutionResult> {
    const generation = this.resetGeneration;
    const existing = this.state.get(targetId);
    if (request.command.intent === "mutation" && existing === undefined) {
      throw new RuntimeExecutionError(
        404,
        `Entity '${targetId}' not found in boundary '${boundary.boundary}'`,
        {
          code: "ENTITY_ABSENCE",
          message: `Entity '${targetId}' not found in boundary '${boundary.boundary}'`,
        },
      );
    }
    if (request.command.intent === "creation" && existing !== undefined) {
      throw new RuntimeExecutionError(
        409,
        `Entity '${targetId}' already exists in boundary '${boundary.boundary}'`,
        {
          code: "ENTITY_CONFLICT",
          message: `Entity '${targetId}' already exists in boundary '${boundary.boundary}'`,
        },
      );
    }
    const sequence = this.events.currentSequenceVersion(targetId);
    const required =
      request.command.operationId !== undefined &&
      this.program.dependencies.contract.requiresPrecondition?.(request.command.operationId) ===
        true;
    if (required && request.command.sequenceVersion === undefined)
      throw new RuntimeExecutionError(428, "If-Match is required");
    if (
      request.command.sequenceVersion !== undefined &&
      request.command.sequenceVersion !== sequence
    ) {
      throw new RuntimeExecutionError(
        412,
        "Sequence version does not match the current aggregate",
        {
          code: "CONCURRENCY_CONFLICT",
          message: "Sequence version does not match the current aggregate",
        },
      );
    }

    const tx: Transaction = {
      states: new Map(this.state.entries().map(([id, value]) => [id, value])),
      events: [],
      reactionKeys: new Set(),
      reactionEvents: 0,
    };
    const command = request.command;
    const response = await this.runCommands([{ command, request }], boundary, tx, 0);
    if (response === undefined)
      throw new RuntimeExecutionError(404, "No behavior matched the command");
    const commitContext: PostCommitContext = {
      command: request.command,
      request,
      state: targetId === null ? null : (tx.states.get(targetId) ?? null),
      event: tx.events.at(-1),
      payload: tx.events.at(-1)?.payload ?? request.command.payload,
      helpers: this.helpersFor(request),
      committedEvents: tx.events,
      response: { status: response.status, body: response.body, headers: response.headers ?? {} },
    };
    await this.runLifecycle("commit", commitContext);
    const committedEvents = tx.events.map((event) => ({
      ...event,
      response: { status: response.status, body: response.body, headers: response.headers ?? {} },
    }));
    const dryRun = request.controls?.dryRun === true;
    if (!dryRun) {
      for (const [id, value] of tx.states) {
        const previous = this.state.get(id);
        if (JSON.stringify(previous) !== JSON.stringify(value)) this.state.set(id, value);
        const event = committedEvents.find((candidate) => candidate.aggregateId === id);
        if (event !== undefined && !this.aggregateBoundaries.has(id))
          this.aggregateBoundaries.set(id, event.boundary);
      }
      for (const [id] of this.state.entries()) if (!tx.states.has(id)) this.state.delete(id);
      this.events.append(committedEvents);
      if (generation === this.resetGeneration) {
        const pending: PendingPostCommit = { boundary, request, events: committedEvents, response };
        if (this.activeBatch === undefined)
          await this.runPostCommit(boundary, request, committedEvents, response);
        else this.activeBatch.postCommits.push(pending);
      }
    }
    return this.decorateResult(
      { ...response, events: committedEvents, committed: !dryRun },
      boundary,
      request,
      committedEvents,
    );
  }

  private pathForOperation(operationId: string, targetId: string | null, fallback: string): string {
    return this.program.dependencies.contract.pathForOperation?.(operationId, targetId) ?? fallback;
  }

  private async runCommands(
    pending: readonly Pending[],
    root: RuntimeBoundary,
    tx: Transaction,
    depth: number,
  ): Promise<RuntimeExecutionResult | undefined> {
    const maxDepth = pending[0]?.request.controls?.maxCascadeDepth ?? MAX_DEPTH;
    if (depth > maxDepth)
      throw new RuntimeExecutionError(508, "Cascade depth exceeded", {
        code: "INFINITE_LOOP",
        message: "Cascade depth exceeded",
      });
    let firstResponse: RuntimeExecutionResult | undefined;
    const queue = [...pending];
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.command.depth > maxDepth) {
        throw new RuntimeExecutionError(508, "Cascade depth exceeded", {
          code: "INFINITE_LOOP",
          message: "Cascade depth exceeded",
        });
      }
      const boundary = this.program.byBoundaryName.get(item.command.boundary);
      if (boundary === undefined)
        throw new RuntimeExecutionError(500, `Unknown boundary ${item.command.boundary}`);
      const currentState =
        item.command.targetId === null ? null : (tx.states.get(item.command.targetId) ?? null);
      const context: MatchContext = {
        command: item.command,
        request: item.request,
        state: currentState,
        payload: item.command.payload,
        helpers: this.helpersFor(item.request),
      };
      if (item.command.targetId !== null) {
        if (item.command.intent === "mutation" && currentState === null) {
          throw new RuntimeExecutionError(
            404,
            `Entity '${item.command.targetId}' not found in boundary '${boundary.boundary}'`,
            { code: "ENTITY_ABSENCE", message: `Entity '${item.command.targetId}' not found` },
          );
        }
        if (item.command.intent === "creation" && currentState !== null) {
          throw new RuntimeExecutionError(
            409,
            `Entity '${item.command.targetId}' already exists in boundary '${boundary.boundary}'`,
            {
              code: "ENTITY_CONFLICT",
              message: `Entity '${item.command.targetId}' already exists`,
            },
          );
        }
      }
      const behavior = this.findBehavior(boundary, item.request, context);
      if (behavior === undefined) {
        if (boundary.fallbackOverride === true) {
          const fallbackBehavior: RuntimeBehavior = {
            name: "fallback",
            operationId: item.command.operationId ?? "fallback",
            emit: "System.GenericUpdateEvent",
          };
          const event = this.createEvent(boundary, fallbackBehavior.emit!, context, tx);
          this.applyEvent(boundary, event, item, tx);
          if (item.request.sideEffects?.skipReactions !== true)
            this.enqueueReactions(event, item, tx, queue);
          if (firstResponse === undefined)
            firstResponse = {
              status: 200,
              body: tx.states.get(event.aggregateId) ?? event.payload,
              headers: {},
              events: [],
              committed: false,
            };
          continue;
        }
        if (item.command.origin === "inbound") {
          // A routed boundary with declared behavior is implemented, even if
          // this particular operation has no matching behavior (for example a
          // WidgetById boundary that only implements PATCH while the contract
          // also exposes GET). Report an implemented-but-unhandled operation as
          // 422; reserve 404 for a boundary with no behavior at all.
          const operationDeclared = boundary.behaviors.length > 0;
          throw new RuntimeExecutionError(
            operationDeclared ? 422 : 404,
            operationDeclared
              ? `Operation ${item.command.operationId ?? item.command.path} is not valid for the current entity state`
              : `No behavior matched ${item.command.operationId ?? item.command.path}`,
            {
              code: operationDeclared ? "INVALID_STATE_TRANSITION" : "NO_BEHAVIOR",
              message: operationDeclared
                ? `Operation ${item.command.operationId ?? item.command.path} is not valid for the current entity state`
                : `No behavior matched ${item.command.operationId ?? item.command.path}`,
            },
          );
        }
        throw new RuntimeExecutionError(
          422,
          `No secondary behavior matched ${item.command.operationId ?? item.command.path}`,
        );
      }
      this.assertAuthorized(item.request, behavior, context);
      for (const guard of behavior.requires ?? []) {
        if (!guard.check(context))
          throw new RuntimeExecutionError(guard.errorStatus ?? 422, guard.errorMessage, {
            code: guard.errorCode,
            message: guard.errorMessage,
          });
      }

      const emitted = this.eventsForBehavior(boundary, behavior, context);
      for (const eventName of emitted) {
        const event = this.createEvent(boundary, eventName, context, tx);
        this.applyEvent(boundary, event, item, tx);
        if (item.request.sideEffects?.skipReactions !== true)
          this.enqueueReactions(event, item, tx, queue);
      }
      if (item.request.sideEffects?.skipDispatch !== true)
        for (const secondary of behavior.dispatchCommands ?? []) {
          if (secondary.condition !== undefined && !secondary.condition(context)) continue;
          const targetId =
            secondary.targetId === undefined ? null : resolveValue(secondary.targetId, context);
          const payload = Object.fromEntries(
            Object.entries(secondary.payload ?? {}).map(([key, value]) => [
              key,
              resolveValue(value, context),
            ]),
          );
          const targetBoundary = this.program.byBoundaryName.get(secondary.boundary);
          const secondaryPath = this.pathForOperation(
            secondary.operationId,
            targetId,
            targetBoundary?.contractPath ?? item.command.path,
          );
          queue.push({
            request: {
              ...item.request,
              command: commandWith(item.command, {
                boundary: secondary.boundary,
                intent: secondary.intent,
                operationId: secondary.operationId,
                targetId,
                payload: asObject(payload),
                origin: "secondary",
                depth: item.command.depth + 1,
                path: secondaryPath,
                httpMethod: secondary.intent === "creation" ? "POST" : "PUT",
              }),
            },
            command: commandWith(item.command, {
              boundary: secondary.boundary,
              intent: secondary.intent,
              operationId: secondary.operationId,
              targetId,
              payload: asObject(payload),
              origin: "secondary",
              depth: item.command.depth + 1,
              path: secondaryPath,
              httpMethod: secondary.intent === "creation" ? "POST" : "PUT",
            }),
          });
        }
      const state =
        item.command.targetId === null ? null : (tx.states.get(item.command.targetId) ?? null);
      const result = await this.applyResponse(
        boundary,
        item.request,
        {
          status:
            behavior.responseStatus ??
            this.program.dependencies.contract.responseStatusFor?.(
              item.command.operationId ?? behavior.operationId,
              item.command.intent,
            ) ??
            (item.command.intent === "creation" ? 201 : 200),
          body: state ?? (emitted.length > 0 ? (tx.events.at(-1)?.payload ?? null) : null),
          headers: {},
        },
        behavior,
        emitted.length > 0 ? tx.events.slice(-emitted.length) : [],
        state,
      );
      const postContext: PostCommitContext = {
        ...context,
        state,
        committedEvents: tx.events,
        response: {
          status: result.status ?? 200,
          body: result.body ?? null,
          headers: result.headers ?? {},
        },
        payload: item.command.payload,
      };
      if (behavior.postcondition !== undefined && !behavior.postcondition(postContext))
        throw new RuntimeExecutionError(422, "Behavior postcondition failed");
      if (firstResponse === undefined)
        firstResponse = {
          status: result.status ?? 200,
          body: result.body ?? null,
          headers: result.headers ?? {},
          events: [],
          committed: false,
          ...(result.unmaskedBody === undefined ? {} : { unmaskedBody: result.unmaskedBody }),
        };
    }
    return firstResponse;
  }

  private findBehavior(
    boundary: RuntimeBoundary,
    request: RuntimeRequest,
    context: MatchContext,
  ): RuntimeBehavior | undefined {
    return boundary.behaviors.find((behavior) => {
      if (behavior.operationId !== request.command.operationId) return false;
      if (
        request.command.origin === "inbound" &&
        behavior.method !== undefined &&
        behavior.method.toUpperCase() !== request.command.httpMethod.toUpperCase()
      )
        return false;
      if (behavior.headers !== undefined && !matchesHeaders(request.headers, behavior.headers))
        return false;
      try {
        if (!(behavior.condition?.(context) ?? true)) return false;
        // Prefer a branch that can emit, but retain a behavior whose guard is
        // already failing so the caller receives the authored guard error
        // instead of a generic invalid-transition response. This also lets a
        // more specific sibling handle internal messages whose emit_when
        // branches intentionally do not match.
        if (
          behavior.emitWhen === undefined ||
          behavior.emitWhen.some((entry) => entry.when(context))
        )
          return true;
        return behavior.requires?.some((guard) => !guard.check(context)) ?? false;
      } catch {
        return false;
      }
    });
  }

  private assertAuthorized(
    request: RuntimeRequest,
    behavior: RuntimeBehavior,
    context: MatchContext,
  ): void {
    const authorized = this.program.policies.auth?.authorize?.(
      context,
      behavior.requiredScopes ?? [],
    );
    if ((behavior.requiredScopes?.length ?? 0) > 0 && request.actor === undefined) {
      throw new RuntimeExecutionError(
        401,
        "Authentication is required for this operation",
        {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required for this operation",
        },
        { "WWW-Authenticate": "Bearer" },
      );
    }
    if (!hasScopes(request.actor, behavior.requiredScopes ?? []) || authorized === false) {
      throw new RuntimeExecutionError(403, "The actor is not authorized for this operation", {
        code: "AUTHORIZATION_DENIED",
        message: "The actor is not authorized for this operation",
      });
    }
  }

  private eventsForBehavior(
    boundary: RuntimeBoundary,
    behavior: RuntimeBehavior,
    context: MatchContext,
  ): string[] {
    if (behavior.emitWhen !== undefined) {
      return behavior.emitWhen.filter((entry) => entry.when(context)).map((entry) => entry.event);
    }
    return behavior.emit === undefined ? [] : [behavior.emit];
  }

  private createEvent(
    boundary: RuntimeBoundary,
    type: string,
    context: MatchContext,
    tx: Transaction,
    sourceEvent?: DomainEvent,
  ): DomainEvent {
    const catalog = boundary.eventCatalog.find((event) => event.type === type);
    if (catalog === undefined && type !== "System.GenericUpdateEvent")
      throw new RuntimeExecutionError(500, `Event ${type} is not declared by ${boundary.boundary}`);
    const aggregateId = context.command.targetId ?? context.helpers.uuid();
    const provisional: DomainEvent = {
      eventId: context.helpers.uuid(),
      boundary: boundary.boundary,
      aggregateId,
      type,
      payload: {},
      timestamp: context.helpers.now(),
      sequenceVersion: this.nextSequence(aggregateId, tx),
      causedBy: context.request.controls?.causedBy ?? context.command.commandId,
      intent: context.command.intent,
      request: {
        method: context.command.httpMethod,
        path: context.command.path,
        query: context.command.queryParams,
        headers: context.request.headers,
        payload: context.command.payload,
        actorId: context.request.actor?.id,
        actorScopes: context.request.actor?.scopes,
        originalActorId: context.request.identity?.original?.id,
        originalActorScopes: context.request.identity?.original?.scopes,
      },
    };
    const eventContext: EventContext = {
      ...context,
      event: sourceEvent ?? provisional,
      payload: context.command.payload,
    };
    const payload =
      catalog === undefined
        ? context.command.payload
        : Object.fromEntries(
            Object.entries(catalog.payload).map(([key, value]) => [
              key,
              resolveValue(value, eventContext),
            ]),
          );
    const hydrated = asObject(payload);
    this.program.dependencies.contract.validateEvent?.(
      boundary.boundary,
      type,
      hydrated,
      catalog?.schemaRef,
    );
    return { ...provisional, payload: hydrated };
  }

  private applyEvent(
    boundary: RuntimeBoundary,
    event: DomainEvent,
    item: Pending,
    tx: Transaction,
  ): void {
    const reducers = boundary.reducers.filter((candidate) => candidate.on === event.type);
    const existing = tx.states.get(event.aggregateId) ?? {};
    let next =
      event.type === "BaselineEntityCreatedEvent"
        ? clone(event.payload)
        : reducers.some((reducer) => reducer.replaceState === true)
          ? clone(event.payload)
          : existing;
    if (event.type === "System.GenericUpdateEvent") next = { ...existing, ...clone(event.payload) };
    if (event.type !== "BaselineEntityCreatedEvent") {
      for (const reducer of reducers) {
        const reducerContext: RuntimeReducerContext = {
          boundary: boundary.boundary,
          state: asObject(next),
          event,
          payload: event.payload,
          helpers: this.helpersFor(item.request),
        };
        if (reducer.reduce !== undefined) {
          next = clone(reducer.reduce(reducerContext));
        } else if (reducer.apply !== undefined) {
          next = asObject(
            applyPatches(next, reducer.apply(reducerContext), "reducer", { autoVivify: true })
              .newState,
          );
        }
      }
    }
    const computed = boundary.state?.computed ?? [];
    for (const field of computed) {
      const value = resolveValue(field.formula, {
        boundary: boundary.boundary,
        state: next,
        event,
        payload: event.payload,
        helpers: this.helpersFor(item.request),
      });
      next[field.name] = value;
    }
    if (boundary.auditFields === true && event.type !== "BaselineEntityCreatedEvent") {
      next.updatedAt = event.timestamp;
      next.updatedBy = event.request?.actorId ?? null;
    }
    boundary.state?.validate?.(next);
    this.program.dependencies.contract.validateEntity?.(boundary.schema ?? boundary.boundary, next);
    tx.states.set(event.aggregateId, next);
    tx.events.push(event);
    void item;
  }

  private enqueueReactions(
    event: DomainEvent,
    source: Pending,
    tx: Transaction,
    queue: Pending[],
  ): void {
    if (source.request.sideEffects?.skipReactions === true) return;
    const reactions = [
      ...(this.program.policies.reactions ?? []),
      ...(this.program.byBoundaryName.get(event.boundary)?.reactions ?? []),
    ];
    const matching = reactions
      .filter((reaction) => reaction.on === event.type || reaction.on === eventKey(event))
      .sort((left, right) => left.boundary.localeCompare(right.boundary));
    for (const reaction of matching) {
      if (tx.reactionEvents >= MAX_REACTION_EVENTS)
        throw new RuntimeExecutionError(508, "Reaction event budget exceeded");
      const postContext: PostCommitContext = {
        command: source.command,
        request: source.request,
        state: tx.states.get(event.aggregateId) ?? null,
        payload: event.payload,
        event,
        helpers: this.helpersFor(source.request),
        committedEvents: tx.events,
      };
      if (reaction.when !== undefined && !reaction.when(postContext)) continue;
      const reactingBoundary = this.program.byBoundaryName.get(reaction.boundary);
      if (reactingBoundary === undefined)
        throw new RuntimeExecutionError(500, `Unknown reaction boundary ${reaction.boundary}`);
      const intent = reaction.intent ?? "mutation";
      const target =
        reaction.target === undefined
          ? intent === "creation"
            ? (reactingBoundary.identity?.generate?.({
                ...postContext,
                boundary: reactingBoundary.boundary,
              }) ?? postContext.helpers.uuid())
            : (() => {
                throw new RuntimeExecutionError(
                  500,
                  `Reaction ${reaction.name ?? reaction.on} requires a target for mutation`,
                );
              })()
          : resolveValue(reaction.target, postContext);
      if (target === null || target === "")
        throw new RuntimeExecutionError(
          500,
          `Reaction ${reaction.name ?? reaction.on} did not resolve a target`,
        );
      const targetState = tx.states.get(target);
      if (intent === "mutation" && targetState === undefined) {
        throw new RuntimeExecutionError(
          404,
          `Reaction ${reaction.name ?? reaction.on} target '${target}' does not exist`,
          { code: "ENTITY_ABSENCE", message: `Reaction target '${target}' does not exist` },
        );
      }
      if (intent === "creation" && targetState !== undefined) {
        throw new RuntimeExecutionError(
          409,
          `Reaction ${reaction.name ?? reaction.on} target '${target}' already exists`,
          { code: "ENTITY_CONFLICT", message: `Reaction target '${target}' already exists` },
        );
      }
      const key = `${reactingBoundary.boundary}:${reaction.on}:${reaction.emit}:${target}`;
      if (tx.reactionKeys.has(key)) continue;
      tx.reactionKeys.add(key);
      tx.reactionEvents += 1;
      const payload = Object.fromEntries(
        Object.entries(reaction.payload ?? {}).map(([field, value]) => [
          field,
          resolveValue(value, postContext),
        ]),
      );
      const command: Command = {
        commandId: postContext.helpers.uuid(),
        boundary: reaction.boundary,
        intent,
        targetId: target,
        payload: asObject(payload),
        queryParams: {},
        httpMethod: intent === "creation" ? "POST" : "PUT",
        path: "",
        operationId: reaction.emit,
        origin: "secondary",
        depth: source.command.depth,
        actor: source.request.actor,
      };
      const reactionPending: Pending = { command, request: { ...source.request, command } };
      const reactionContext: MatchContext = {
        command,
        request: reactionPending.request,
        state: tx.states.get(target ?? "") ?? null,
        payload: asObject(payload),
        helpers: postContext.helpers,
      };
      const reactionEvent = this.createEvent(
        reactingBoundary,
        reaction.emit,
        reactionContext,
        tx,
        event,
      );
      const hydrated: DomainEvent = {
        ...reactionEvent,
        payload: { ...reactionEvent.payload, ...asObject(payload) },
      };
      this.applyEvent(reactingBoundary, hydrated, reactionPending, tx);
      if (reactionPending.request.sideEffects?.skipReactions !== true)
        this.enqueueReactions(hydrated, reactionPending, tx, queue);
    }
  }

  private async runPostCommit(
    boundary: RuntimeBoundary,
    request: RuntimeRequest,
    events: readonly DomainEvent[],
    response: RuntimeExecutionResult,
  ): Promise<void> {
    const last = events.at(-1);
    const context: PostCommitContext = {
      command: request.command,
      request,
      state:
        request.command.targetId === null
          ? null
          : (this.state.get(request.command.targetId) ?? null),
      event: last,
      payload: last?.payload ?? request.command.payload,
      helpers: this.helpersFor(request),
      response: { status: response.status, body: response.body, headers: response.headers ?? {} },
      committedEvents: events,
    };
    await this.runLifecycle("postCommit", context);
    if (request.sideEffects?.skipProjections !== true) await this.runProjections(events, context);
    if (request.sideEffects?.skipWebhooks !== true) await this.runWebhooks(events, context);
    if (request.sideEffects?.skipSagas !== true && this.program.policies.sagas !== undefined)
      await this.runSagas(this.program.policies.sagas, events, request, context);
  }

  private async runProjections(
    events: readonly DomainEvent[],
    source: PostCommitContext,
  ): Promise<void> {
    for (const projection of this.program.policies.derivedProjections ?? []) {
      for (const event of events) {
        if (!projection.subscribe.some((subscription) => matchesSubscription(subscription, event)))
          continue;
        const stateMap = this.projections.get(projection.name) ?? new Map<string, JsonObject>();
        this.projections.set(projection.name, stateMap);
        try {
          const context: ProjectionContext = {
            ...source,
            event,
            payload: event.payload,
            projection: projection.name,
            state:
              stateMap.get(
                resolveValue(projection.key, {
                  ...source,
                  event,
                  payload: event.payload,
                  projection: projection.name,
                }),
              ) ?? null,
          };
          await this.runLifecycle("projection", context);
          const key = resolveValue(projection.key, context);
          const current = stateMap.get(key) ?? {};
          const reducers = projection.reduce.filter(
            (candidate) => candidate.on === event.type || candidate.on === eventKey(event),
          );
          let next = reducers.some((reducer) => reducer.replaceState === true)
            ? clone(event.payload)
            : current;
          for (const reducer of reducers) {
            const reducerContext: RuntimeReducerContext = {
              boundary: event.boundary,
              state: asObject(next),
              event,
              payload: event.payload,
              helpers: source.helpers,
            };
            if (reducer.reduce !== undefined) {
              next = clone(reducer.reduce(reducerContext));
            } else if (reducer.apply !== undefined) {
              next = asObject(
                applyPatches(next, reducer.apply(reducerContext), "projection", {
                  autoVivify: true,
                }).newState,
              );
            }
          }
          stateMap.set(key, next);
          this.writeLog(source.request, "debug", "Runtime derived projection applied", {
            projection: projection.name,
            eventType: event.type,
            key,
          });
          this.writeMetric(source.request, "runtime.projections.applied", 1, {
            projection: projection.name,
          });
        } catch (error) {
          this.writeLog(source.request, "warn", "Runtime derived projection failed", {
            projection: projection.name,
            eventType: event.type,
            error: String(error),
          });
          this.writeMetric(source.request, "runtime.projections.failed", 1, {
            projection: projection.name,
          });
        }
      }
    }
  }

  private async runWebhooks(
    events: readonly DomainEvent[],
    source: PostCommitContext,
  ): Promise<void> {
    const transport = this.program.dependencies.webhooks;
    if (transport === undefined) return;
    for (const webhook of this.program.policies.webhooks ?? []) {
      for (const event of events) {
        const context: WebhookContext = {
          ...source,
          event,
          payload: event.payload,
          headers: source.request.headers,
        };
        if (!webhook.trigger(context)) continue;
        const url = resolveValue(webhook.url, context);
        const payload = Object.fromEntries(
          Object.entries(webhook.payload ?? {}).map(([key, value]) => [
            key,
            resolveValue(value, context),
          ]),
        );
        const body = JSON.stringify(payload);
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (webhook.secret !== undefined)
          headers["x-potemkin-signature"] =
            `sha256=${createHmac("sha256", webhook.secret).update(body).digest("hex")}`;
        const attempts = Math.max(1, webhook.retry?.maxAttempts ?? 3);
        let delivered = false;
        let lastError: unknown;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try {
            await transport.deliver({ url, body, headers, attempts: attempt });
            delivered = true;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < attempts)
              await this.delay((webhook.retry?.delayMs ?? 1_000) * 2 ** (attempt - 1));
          }
        }
        if (!delivered) {
          this.writeLog(source.request, "warn", `Webhook ${webhook.name} delivery failed`, {
            error: String(lastError),
            eventId: event.eventId,
            attempts,
          });
          this.writeMetric(source.request, "runtime.webhooks.failed", 1, {
            webhook: webhook.name,
          });
        } else {
          this.writeMetric(source.request, "runtime.webhooks.delivered", 1, {
            webhook: webhook.name,
          });
        }
      }
    }
  }

  private async runSagas(
    sagas: readonly RuntimeSaga[],
    events: readonly DomainEvent[],
    request: RuntimeRequest,
    source: PostCommitContext,
  ): Promise<void> {
    for (const saga of sagas) {
      const trigger = events.find(
        (event) =>
          event.boundary === saga.trigger.boundary &&
          (event.intent ??
            (event.boundary === request.command.boundary ? request.command.intent : "mutation")) ===
            saga.trigger.intent,
      );
      if (trigger === undefined) continue;
      const steps: Record<string, { status: number; body: JsonValue | null }> = {};
      const completed: Array<{
        readonly step: RuntimeSagaStep;
        readonly index: number;
        readonly target: string | null;
      }> = [];
      const sagaInstanceId = `${request.command.commandId}:${saga.name}`;
      let previousStep: { status: number; body: JsonValue | null } | undefined;
      let activeStepIndex = -1;
      const sagaContext = (): SagaContext => ({
        ...source,
        event: trigger,
        payload: trigger.payload,
        steps,
        ...(previousStep === undefined ? {} : { prevStep: previousStep }),
        committedEvents: events,
      });
      if (saga.trigger.condition !== undefined && !saga.trigger.condition(sagaContext())) continue;
      this.appendSagaEvent(
        sagaInstanceId,
        "SagaStarted",
        { saga: saga.name, sagaName: saga.name, triggerEventId: trigger.eventId },
        source.helpers,
      );
      try {
        for (const [stepIndex, step] of saga.steps.entries()) {
          activeStepIndex = stepIndex;
          const stepContext = sagaContext();
          const target =
            step.targetId === undefined ? null : resolveValue(step.targetId, stepContext);
          const payload = Object.fromEntries(
            Object.entries(step.payload ?? {}).map(([key, value]) => [
              key,
              resolveValue(value, stepContext),
            ]),
          );
          const targetBoundary = this.program.byBoundaryName.get(step.boundary);
          const stepPath = this.pathForOperation(
            step.operationId,
            target,
            targetBoundary?.contractPath ?? request.command.path,
          );
          const command: Command = {
            ...request.command,
            commandId: source.helpers.uuid(),
            boundary: step.boundary,
            intent: step.intent,
            operationId: step.operationId,
            targetId: target,
            payload: asObject(payload),
            origin: "secondary",
            depth: request.command.depth + 1,
            path: stepPath,
            httpMethod: step.intent === "creation" ? "POST" : "PUT",
          };
          const result = await this.executeUnlocked({
            ...request,
            command,
            sideEffects: { ...request.sideEffects, skipSagas: true },
          });
          steps[step.name] = { status: result.status, body: result.body };
          previousStep = steps[step.name];
          completed.push({ step, index: stepIndex, target });
          this.appendSagaEvent(
            sagaInstanceId,
            "SagaStepCompleted",
            {
              saga: saga.name,
              step: step.name,
              stepName: step.name,
              stepIndex,
              status: result.status,
            },
            source.helpers,
          );
        }
        this.appendSagaEvent(
          sagaInstanceId,
          "SagaCompleted",
          { saga: saga.name, steps: Object.keys(steps) },
          source.helpers,
        );
      } catch (error) {
        this.appendSagaEvent(
          sagaInstanceId,
          "SagaStepFailed",
          {
            saga: saga.name,
            stepName: saga.steps[activeStepIndex]?.name ?? "",
            stepIndex: activeStepIndex,
            completed: completed.map((entry) => entry.step.name),
            error: String(error),
          },
          source.helpers,
        );
        for (const entry of completed.reverse()) {
          const step = entry.step;
          if (step.compensation === undefined) continue;
          const compensation = step.compensation;
          const stepContext = sagaContext();
          const target =
            compensation.targetId === undefined
              ? entry.target
              : resolveValue(compensation.targetId, stepContext);
          const payload = Object.fromEntries(
            Object.entries(compensation.payload ?? {}).map(([key, value]) => [
              key,
              resolveValue(value, stepContext),
            ]),
          );
          const targetBoundary = this.program.byBoundaryName.get(step.boundary);
          const compensationPath = this.pathForOperation(
            compensation.operationId,
            target,
            targetBoundary?.contractPath ?? request.command.path,
          );
          const command: Command = {
            ...request.command,
            commandId: source.helpers.uuid(),
            boundary: step.boundary,
            intent: compensation.intent,
            operationId: compensation.operationId,
            targetId: target,
            payload: asObject(payload),
            origin: "secondary",
            depth: request.command.depth + 1,
            path: compensationPath,
            httpMethod: compensation.intent === "creation" ? "POST" : "PUT",
          };
          try {
            await this.executeUnlocked({
              ...request,
              command,
              sideEffects: { ...request.sideEffects, skipSagas: true },
            });
            this.appendSagaEvent(
              sagaInstanceId,
              "SagaCompensated",
              {
                saga: saga.name,
                step: step.name,
                compensatedStepName: step.name,
                compensatedStepIndex: entry.index,
              },
              source.helpers,
            );
          } catch (compensationError) {
            this.appendSagaEvent(
              sagaInstanceId,
              "SagaCompensationFailed",
              { saga: saga.name, step: step.name, error: String(compensationError) },
              source.helpers,
            );
          }
        }
        this.appendSagaEvent(
          sagaInstanceId,
          "SagaFailed",
          {
            saga: saga.name,
            sagaName: saga.name,
            failedAtStep: activeStepIndex,
            error: String(error),
          },
          source.helpers,
        );
        this.writeLog(request, "error", `Saga ${saga.name} failed`, {
          error: String(error),
        });
      }
    }
  }

  private appendSagaEvent(
    aggregateId: string,
    type: string,
    payload: JsonObject,
    helpers = this.helpers,
  ): void {
    this.events.append([
      {
        eventId: helpers.uuid(),
        boundary: "__saga__",
        aggregateId,
        type,
        payload,
        timestamp: helpers.now(),
        sequenceVersion: this.events.currentSequenceVersion(aggregateId) + 1,
        causedBy: null,
        intent: "mutation",
      },
    ]);
  }

  /** Add links declared by the global HATEOAS policy after contract shaping. */
  private applyGlobalHateoas(
    body: JsonValue,
    boundary: RuntimeBoundary,
    request: RuntimeRequest,
  ): JsonValue {
    const policy = this.program.policies.hateoas;
    if (
      !policy?.enabled ||
      request.command.queryParams.fields !== undefined ||
      body === null ||
      typeof body !== "object"
    )
      return body;

    const entityPathTemplate = boundary.contractPath.includes("{id}")
      ? boundary.contractPath
      : this.program.boundaries.find(
          (candidate) => candidate.contractPath === `${boundary.contractPath}/{id}`,
        )?.contractPath;
    const baseUrl =
      policy.baseUrl?.endsWith("/") === true ? policy.baseUrl.slice(0, -1) : (policy.baseUrl ?? "");
    const attach = (value: JsonValue): JsonValue => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      const entity = value as JsonObject;
      const id = typeof entity.id === "string" && entity.id.length > 0 ? entity.id : undefined;
      if (id === undefined || entityPathTemplate === undefined) return value;
      const expand = (path: string): string =>
        `${baseUrl}${path.replace(/\{id\}/g, encodeURIComponent(id))}`;
      const links: JsonObject =
        policy.selfLinks === false
          ? {}
          : {
              self: { href: expand(entityPathTemplate), method: "GET" },
            };
      const prefix = entityPathTemplate.endsWith("/")
        ? entityPathTemplate
        : `${entityPathTemplate}/`;
      for (const candidate of this.program.boundaries) {
        if (candidate.boundary === boundary.boundary || !candidate.contractPath.startsWith(prefix))
          continue;
        for (const behavior of candidate.behaviors) {
          if (behavior.linkName === undefined || links[behavior.linkName] !== undefined) continue;
          const predicate = behavior.linkCondition ?? behavior.condition;
          if (predicate !== undefined) {
            try {
              if (!predicate(this.context(candidate, request, entity))) continue;
            } catch {
              continue;
            }
          }
          links[behavior.linkName] = {
            href: expand(candidate.contractPath),
            method: behavior.method ?? "GET",
          };
          break;
        }
      }
      return { ...entity, _links: links };
    };

    if (Array.isArray(body)) return body.map(attach) as JsonValue;
    const object = body as JsonObject;
    if (Array.isArray(object.items)) return { ...object, items: object.items.map(attach) };
    return attach(body);
  }

  private async applyResponse(
    boundary: RuntimeBoundary,
    request: RuntimeRequest,
    response: RuntimeResponse,
    behavior: RuntimeBehavior | undefined,
    events: readonly DomainEvent[],
    stateOverride?: JsonObject | null,
    versionEvents?: readonly DomainEvent[],
  ): Promise<RuntimeResponse & { readonly unmaskedBody?: JsonValue | null }> {
    const policy = boundary.response;
    let current = {
      status: response.status ?? 200,
      body: response.body ?? null,
      headers: { ...response.headers },
    };
    const postContext: PostCommitContext = {
      command: request.command,
      request,
      state:
        request.command.targetId === null
          ? null
          : (stateOverride ?? this.readState(request.command.targetId)),
      event: events.at(-1),
      payload: events.at(-1)?.payload ?? request.command.payload,
      helpers: this.helpersFor(request),
      committedEvents: events,
    };
    const context = {
      ...postContext,
      operationId: request.command.operationId,
      response: {
        status: current.status ?? 200,
        body: current.body ?? null,
        headers: current.headers ?? {},
      },
    };
    const transformed = policy?.transform?.(context);
    if (transformed !== undefined && transformed !== null)
      current = {
        ...current,
        ...transformed,
        headers: { ...current.headers, ...transformed.headers },
      };
    if (policy?.status !== undefined)
      current = { ...current, status: resolveValue(policy.status, context) };
    if (policy?.headers !== undefined) {
      current = {
        ...current,
        headers: {
          ...current.headers,
          ...Object.fromEntries(
            Object.entries(policy.headers).map(([key, value]) => [
              key,
              resolveValue(value, context),
            ]),
          ),
        },
      };
    }
    if (boundary.deprecated !== undefined || policy?.deprecated !== undefined) {
      const deprecation = boundary.deprecated ?? policy!.deprecated!;
      const httpDate = (value: string): string => {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? value : parsed.toUTCString();
      };
      const deprecationDate = (deprecation as { readonly date?: string }).date;
      const isEpochSentinel =
        deprecationDate !== undefined &&
        Number.isFinite(new Date(deprecationDate).getTime()) &&
        new Date(deprecationDate).getTime() === 0;
      current = {
        ...current,
        headers: {
          ...current.headers,
          Deprecation:
            deprecationDate === undefined || isEpochSentinel ? "true" : httpDate(deprecationDate),
          ...(deprecation.sunset ? { Sunset: httpDate(deprecation.sunset) } : {}),
          ...(deprecation.replacement
            ? { Link: `<${deprecation.replacement}>; rel="successor-version"` }
            : {}),
        },
      };
    }
    addSecurityHeaders(current, this.program.policies.securityHeaders);
    if (request.command.targetId !== null) {
      const entityEvents =
        versionEvents ??
        (events.length > 0 ? events : this.events.events(undefined, request.command.targetId));
      const sequence = entityEvents.reduce(
        (highest, event) => Math.max(highest, event.sequenceVersion),
        0,
      );
      if (sequence > 0) {
        const lastEvent = entityEvents.at(-1);
        current = {
          ...current,
          headers: {
            ...current.headers,
            ETag: `"${sequence}"`,
            ...(lastEvent?.timestamp === undefined
              ? {}
              : { "Last-Modified": new Date(lastEvent.timestamp).toUTCString() }),
          },
        };
        if (request.command.intent === "query") {
          const ifNoneMatch = headerValue(request.headers, "if-none-match");
          const ifModifiedSince = headerValue(request.headers, "if-modified-since");
          const notModifiedByTag =
            ifNoneMatch === "*" ||
            ifNoneMatch?.split(",").some((candidate) => {
              const normalized = candidate.trim().replace(/^W\//, "");
              return normalized === `"${sequence}"` || normalized === String(sequence);
            }) === true;
          const notModifiedByDate =
            lastEvent?.timestamp !== undefined &&
            ifModifiedSince !== undefined &&
            Number.isFinite(Date.parse(ifModifiedSince)) &&
            Date.parse(ifModifiedSince) >= Date.parse(lastEvent.timestamp);
          if (notModifiedByTag || notModifiedByDate)
            current = { ...current, status: 304, body: null };
        }
      }
    }
    // Validate the contract-shaped body before serving response masks, links,
    // pagination envelopes, or alternate representations. These are transport
    // shaping operations; masking a required field must not make an otherwise
    // valid domain response fail validation.
    if (request.command.operationId !== undefined && current.status >= 400) {
      const shaped = this.program.dependencies.contract.shapeError?.(
        request.command.operationId,
        current.status,
        current.body ?? null,
      );
      if (shaped !== undefined) current = { ...current, body: shaped };
    }
    const sparseFieldset =
      request.command.intent === "query" && request.command.queryParams.fields !== undefined;
    if (
      request.command.operationId !== undefined &&
      current.body !== null &&
      request.controls?.skipResponseValidation !== true &&
      !sparseFieldset
    ) {
      this.program.dependencies.contract.validateResponse?.(
        request.command.operationId,
        current.status,
        current.body,
        request,
        { allowAdditionalProperties: request.controls?.allowAdditionalProperties },
      );
    }

    const boundaryMasks = [...(boundary.mask ?? []), ...(policy?.mask ?? [])];
    const unmaskedBody = current.body;
    current = { ...current, body: maskBody(current.body ?? null, boundaryMasks) };
    if (request.controls?.maskFields !== undefined)
      current = { ...current, body: maskValues(current.body ?? null, request.controls.maskFields) };
    const successfulResponse = current.status >= 200 && current.status < 300;
    const supportsHateoas =
      successfulResponse &&
      (request.command.operationId === undefined ||
        this.program.dependencies.contract.responseSupportsHateoas?.(
          request.command.operationId,
          current.status,
          current.body ?? null,
        ) !== false);
    if (
      supportsHateoas &&
      policy?.hateoas !== undefined &&
      current.body !== null &&
      typeof current.body === "object" &&
      !Array.isArray(current.body)
    ) {
      const links = Object.fromEntries(
        policy.hateoas
          .filter((link) => link.condition?.(context) ?? true)
          .map((link) => [link.rel, { href: resolveValue(link.href, context) }]),
      );
      current = { ...current, body: { ...(current.body as JsonObject), _links: links } };
    }
    if (
      successfulResponse &&
      behavior?.linkName !== undefined &&
      (behavior.linkCondition?.(context) ?? true) &&
      current.body !== null &&
      typeof current.body === "object" &&
      !Array.isArray(current.body)
    ) {
      const existing = (current.body as JsonObject)._links;
      current = {
        ...current,
        body: {
          ...(current.body as JsonObject),
          _links: {
            ...(existing && typeof existing === "object" && !Array.isArray(existing)
              ? existing
              : {}),
            [behavior.linkName]: {
              href: request.command.path,
              method: behavior.method ?? request.command.httpMethod,
            },
          },
        },
      };
    }
    if (supportsHateoas && request.command.intent === "query") {
      current = { ...current, body: this.applyGlobalHateoas(current.body, boundary, request) };
    }
    await this.delayForResponse(boundary, request);
    // Alternate representations are a transport control. Validate the normal
    // contract-shaped body first; otherwise HAL/JSON:API envelopes would make
    // a valid response fail the OpenAPI response schema.
    if (current.status >= 200 && current.status < 300) {
      if (request.controls?.paginationStyle !== undefined) {
        const transformed = applyPaginationControl(
          current.body,
          request.controls.paginationStyle,
          request,
        );
        current = {
          ...current,
          body: transformed.body,
          headers: { ...current.headers, ...transformed.headers },
        };
      }
      if (request.controls?.responseFormat !== undefined) {
        current = {
          ...current,
          body: applyResponseFormat(
            current.body,
            request.controls.responseFormat,
            boundary.boundary,
            request.command.path,
          ),
          headers: {
            ...current.headers,
            "X-Potemkin-Response-Format": request.controls.responseFormat,
          },
        };
      }
    }
    return { ...current, unmaskedBody };
  }

  private decorateResult(
    result: RuntimeExecutionResult,
    boundary: RuntimeBoundary,
    request: RuntimeRequest,
    events: readonly DomainEvent[],
  ): RuntimeExecutionResult {
    const carrier = { headers: { ...result.headers } };
    addSecurityHeaders(carrier, this.program.policies.securityHeaders);
    if (request.controls?.dryRun === true) carrier.headers["X-Potemkin-Dry-Run"] = "true";
    if (request.controls?.traceId !== undefined)
      carrier.headers["X-Potemkin-Trace-Id"] = request.controls.traceId;
    if (request.controls?.spanName !== undefined)
      carrier.headers["X-Potemkin-Span-Name"] = request.controls.spanName;
    let body =
      result.status >= 200 && result.status < 300
        ? applyDebugEnvelope(result.body, request, boundary, events)
        : result.body;
    if (
      request.controls?.bodyTruncateBytes !== undefined &&
      request.controls.bodyTruncateBytes >= 0
    ) {
      body = truncateSerializedBody(body, request.controls.bodyTruncateBytes);
    }
    return { ...result, body, headers: carrier.headers };
  }

  private async runLifecycle(
    phase: keyof RuntimeLifecycle,
    input: MatchContext | PostCommitContext | undefined,
  ): Promise<void> {
    const hook = this.program.policies.lifecycle?.[phase];
    if (hook === undefined) return;
    await hook(input as never);
  }

  private async delay(milliseconds: number | undefined): Promise<void> {
    if (milliseconds === undefined || milliseconds <= 0) return;
    if (this.program.dependencies.sleep !== undefined)
      await this.program.dependencies.sleep(milliseconds);
    else await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  private async delayForResponse(
    boundary: RuntimeBoundary,
    request: RuntimeRequest,
    additionalFixedMs = 0,
  ): Promise<void> {
    const policy = boundary.response?.latency;
    const fixed =
      (boundary.latency?.fixedMs ?? 0) +
      (policy?.fixedMs ?? 0) +
      (request.controls?.forceLatencyMs ?? 0) +
      additionalFixedMs;
    await this.delay(fixed);
    const randomDelay = (min: number, max: number): number => {
      const sample = this.helpersFor(request).random();
      const bounded = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
      return min + Math.min(max - min, Math.floor(bounded * (max - min + 1)));
    };
    for (const delayRange of [boundary.latency, policy]) {
      if (delayRange?.minMs === undefined && delayRange?.maxMs === undefined) continue;
      const min = Math.max(0, delayRange.minMs ?? 0);
      const max = Math.max(min, delayRange.maxMs ?? min);
      await this.delay(randomDelay(min, max));
    }
    if (request.controls?.jitterMs !== undefined) {
      const min = Math.max(0, request.controls.jitterMs.min);
      const max = Math.max(min, request.controls.jitterMs.max);
      await this.delay(randomDelay(min, max));
    }
  }

  private nextSequence(aggregateId: string, tx: Transaction): number {
    return (
      this.events.currentSequenceVersion(aggregateId) +
      tx.events.filter((event) => event.aggregateId === aggregateId).length +
      1
    );
  }

  private idempotencyKey(request: RuntimeRequest): string | undefined {
    if (this.program.policies.idempotency?.enabled !== true) return undefined;
    if (request.command.intent === "query" && request.controls?.replayEvent === undefined)
      return undefined;
    const key = headerValue(request.headers, "idempotency-key");
    if (key === undefined) return undefined;
    return `${request.actor?.id ?? "anonymous"}:${request.command.boundary}:${request.command.operationId ?? request.command.path}:${key}`;
  }

  private idempotencyFingerprint(request: RuntimeRequest): string {
    return `${request.command.httpMethod.toUpperCase()}:${request.command.path}:${request.controls?.replayEvent ?? ""}:${serialise(request.command.payload)}`;
  }

  private cachedIdempotency(key: string, request?: RuntimeRequest): ExecutionResult | undefined {
    return (
      this.activeBatch?.idempotency.get(key)?.result ??
      this.idempotency.get(key, this.nowMsFor(request))
    );
  }

  private storeIdempotency(
    key: string,
    fingerprint: string,
    result: ExecutionResult,
    ttlSeconds: number,
  ): void {
    if (this.activeBatch !== undefined) {
      this.activeBatch.idempotency.set(key, { fingerprint, result: clone(result), ttlSeconds });
      return;
    }
    this.idempotencyFingerprints.set(key, fingerprint);
    this.idempotency.set(key, result, ttlSeconds);
  }

  private flushBatchIdempotency(batch: ActiveBatch | undefined): void {
    if (batch === undefined) return;
    for (const [key, pending] of batch.idempotency) {
      this.idempotencyFingerprints.set(key, pending.fingerprint);
      this.idempotency.set(key, pending.result, pending.ttlSeconds);
    }
  }

  private checkIdempotencyFingerprint(key: string, request: RuntimeRequest): void {
    if (this.program.policies.idempotency?.hashIncludesBody !== true) return;
    const pending = this.activeBatch?.idempotency.get(key);
    const previous = pending?.fingerprint ?? this.idempotencyFingerprints.get(key);
    if (previous === undefined) return;
    if (pending === undefined && this.idempotency.get(key, this.nowMsFor(request)) === undefined) {
      this.idempotencyFingerprints.delete(key);
      return;
    }
    if (previous !== this.idempotencyFingerprint(request)) {
      throw new RuntimeExecutionError(
        409,
        "The idempotency key was reused with a different request",
        {
          code: "IDEMPOTENCY_KEY_CONFLICT",
          message: "The idempotency key was reused with a different request",
        },
      );
    }
  }

  private canCascade(): boolean {
    return (
      (this.program.policies.reactions?.length ?? 0) > 0 ||
      this.program.boundaries.some((boundary) => (boundary.reactions?.length ?? 0) > 0) ||
      this.program.boundaries.some((boundary) =>
        boundary.behaviors.some((behavior) => (behavior.dispatchCommands?.length ?? 0) > 0),
      )
    );
  }

  private async acquireMany(keys: readonly string[]): Promise<() => void> {
    const releases: Array<() => void> = [];
    for (const key of [...new Set(keys)].sort()) releases.push(await this.acquire(key));
    return () => {
      for (const release of releases.reverse()) release();
    };
  }

  private async acquire(key: string): Promise<() => void> {
    let releaseSlot!: () => void;
    const slot = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    const previous = this.locks.get(key) ?? Promise.resolve();
    const chained = previous.then(() => slot);
    this.locks.set(key, chained);
    await previous;
    return () => {
      releaseSlot();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    };
  }
}

export function createRuntimeEngine(program: RuntimeProgram): RuntimeEngine {
  return new RuntimeEngine(program);
}
