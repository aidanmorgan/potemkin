import type { OpenApiDoc } from "../contract/loader.js";
import { lookupOperationId } from "../contract/loader.js";
import { matchRoute } from "../contract/router.js";
import { createContractValidator, type ContractValidator } from "../contract/validator.js";
import type { PotemkinConfiguration } from "../config.js";
import { createRuntimeEngine, type RuntimeEngine } from "../core/engine.js";
import type {
  RuntimeDependencies,
  RuntimeClock,
  RuntimeContract,
  RuntimeForwardingPort,
  RuntimeProgram,
  RuntimeRequest,
  RuntimeSessionStore,
  RuntimeWebhookTransport,
  RuntimeFaultStore,
  RuntimeHelpers,
} from "../model/runtime.js";
import { createRuntimeFaultStore } from "../core/faults.js";
import {
  createMemoryEventStore,
  createMemoryIdempotencyStore,
  createMemoryStateStore,
} from "../core/storage.js";
import { responseSupportsHateoas } from "../contract/hateoas.js";
import { buildContractErrorBody, validateContractErrorBody } from "../contract/errorBody.js";
import { createRuntimeAuthenticationPort } from "../identity/actorResolver.js";
import { createSessionStore, type SessionStore } from "../identity/sessionStore.js";
import type { Actor, JsonObject, JsonValue } from "../types.js";
import { ConfigurationError, InternalExecutionError } from "../errors.js";
import type { PluginControlClient } from "../lifecycle/types.js";
import { createHash } from "node:crypto";
import type { RuntimeHostServices } from "./host.js";
import type { RuntimeTimerScheduler } from "./ports.js";
import { lintOrThrow } from "../lint/runner.js";
import type { TransitionModel } from "../model/transitionModel.js";

/** A contract binding used by the source-independent engine. */
export interface RuntimeContractOptions {
  /** Runtime-owned clock used for contract-shaped date/time error fields. */
  readonly now?: () => string;
  /** Optional per-contract mapping for constrained error-code fields. */
  readonly codeMap?: Readonly<Record<string, string>>;
}

export function runtimeContract(
  doc: OpenApiDoc,
  validator: ContractValidator,
  options: RuntimeContractOptions = {},
): RuntimeContract {
  const operationRoutes = new Map<string, { method: string; path: string }>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (operation?.operationId !== undefined)
        operationRoutes.set(operation.operationId, { method, path });
    }
  }

  const requestRoute = (operationId: string, request?: Readonly<RuntimeRequest>) => {
    const route = operationRoutes.get(operationId);
    if (route === undefined) return undefined;
    const requestMatch =
      request === undefined
        ? null
        : matchRoute(doc, request.command.httpMethod, request.command.path);
    const matched =
      request === undefined
        ? matchRoute(doc, route.method, route.path)
        : (requestMatch ?? matchRoute(doc, route.method, request.command.path));
    return {
      method:
        matched === null || requestMatch === null
          ? route.method
          : (request?.command.httpMethod ?? route.method),
      path: matched === null ? route.path : (request?.command.path ?? route.path),
      pathParams: matched?.pathParams ?? {},
    };
  };

  return {
    operationIdFor: (path: string, method: string) => {
      const matched = matchRoute(doc, method, path);
      return matched?.operation.operationId ?? lookupOperationId(doc, path, method);
    },
    responseStatusFor: (operationId: string, intent: RuntimeRequest["command"]["intent"]) => {
      const route = operationRoutes.get(operationId);
      if (route === undefined) return undefined;
      const operation = inputOperation(doc, route.path, route.method);
      const statuses = Object.keys(operation?.responseSchemas ?? {})
        .map(Number)
        .filter((status) => Number.isInteger(status) && status >= 200 && status < 300)
        .sort((left, right) => left - right);
      if (statuses.length === 0) return undefined;
      if (intent === "creation" && statuses.includes(201)) return 201;
      if (statuses.includes(200)) return 200;
      return statuses[0];
    },
    pathForOperation: (operationId: string, targetId?: string | null) => {
      const route = operationRoutes.get(operationId);
      if (route === undefined) return undefined;
      if (targetId === undefined || targetId === null) return route.path;
      return route.path.replace(/\{[^}]+\}/g, encodeURIComponent(targetId));
    },
    validateRequest: (
      operationId: string,
      payload: JsonObject,
      request?: Readonly<RuntimeRequest>,
    ) => {
      const resolved = requestRoute(operationId, request);
      if (resolved === undefined) return;
      // Secondary commands use the authored boundary path, which may be a
      // resource identity path rather than the OpenAPI operation's route. The
      // resolved route falls back to the operation route when needed.
      const validate =
        request?.batchItem === undefined
          ? validator.validateRequest
          : validator.validateRequestItem;
      validate(
        resolved.method,
        resolved.path,
        payload,
        request?.command.queryParams ?? {},
        resolved.pathParams,
        request?.headers,
      );
    },
    validateBatchRequest: (
      operationId: string,
      payload: JsonValue,
      request?: Readonly<RuntimeRequest>,
    ) => {
      const resolved = requestRoute(operationId, request);
      if (resolved === undefined) return;
      validator.validateRequestBatch(
        resolved.method,
        resolved.path,
        payload,
        request?.command.queryParams ?? {},
        resolved.pathParams,
        request?.headers,
      );
    },
    validateResponse: (
      operationId: string,
      status: number,
      body: JsonValue,
      request?: Readonly<RuntimeRequest>,
      options?: Readonly<{ allowAdditionalProperties?: boolean }>,
    ) => {
      const resolved = requestRoute(operationId, request);
      if (resolved === undefined) return;
      const validate =
        request?.batchItem === undefined
          ? validator.validateResponse
          : validator.validateResponseItem;
      validate(resolved.method, resolved.path, status, body, options);
    },
    validateBatchResponse: (
      operationId: string,
      status: number,
      body: JsonValue,
      request?: Readonly<RuntimeRequest>,
      options?: Readonly<{ allowAdditionalProperties?: boolean }>,
    ) => {
      const resolved = requestRoute(operationId, request);
      if (resolved === undefined) return;
      validator.validateResponseBatch(resolved.method, resolved.path, status, body, options);
    },
    shapeError: (operationId: string, status: number, body: JsonValue) => {
      const route = operationRoutes.get(operationId);
      if (route === undefined) return undefined;
      const candidate =
        body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
      if (validateContractErrorBody(doc, route.method, route.path, status, body).valid) return body;
      const code =
        typeof candidate["code"] === "string"
          ? candidate["code"]
          : typeof candidate["error"] === "string"
            ? candidate["error"]
            : undefined;
      return buildContractErrorBody(
        doc,
        route.method,
        route.path,
        status,
        {
          code,
          message: typeof candidate["message"] === "string" ? candidate["message"] : undefined,
          details:
            candidate["details"] ??
            (code === undefined
              ? undefined
              : {
                  code,
                }),
        },
        {
          ...(options.codeMap === undefined ? {} : { codeMap: options.codeMap }),
          ...(options.now === undefined ? {} : { now: options.now }),
        },
      );
    },
    requiresPrecondition: (operationId: string) => {
      const route = operationRoutes.get(operationId);
      if (route === undefined) return false;
      return (
        doc.paths[route.path]?.[route.method]?.parameters?.some(
          (parameter) =>
            parameter.in === "header" &&
            parameter.name.toLowerCase() === "if-match" &&
            parameter.required === true,
        ) ?? false
      );
    },
    validateEvent: (
      _boundary: string,
      _eventType: string,
      payload: JsonObject,
      schemaRef?: string,
    ) => {
      if (schemaRef === undefined) return;
      try {
        validator.validateSchema(schemaRef, payload);
      } catch (error) {
        if (error instanceof InternalExecutionError) throw error;
        throw new InternalExecutionError("Event payload failed schema validation", {
          code: "SCHEMA_TYPE_MISMATCH",
          error: String(error),
        });
      }
    },
    validateEntity: (boundary: string, entity: JsonObject) => {
      try {
        validator.validateEntity(boundary, entity);
      } catch (error) {
        // A runtime boundary may intentionally omit a state schema when its
        // OpenAPI response schema already validates the wire representation.
        // In that case there is no entity-level schema to apply. Preserve all
        // actual validation failures, including malformed entities.
        const details = error instanceof InternalExecutionError ? error.details : undefined;
        const errors =
          details !== null && typeof details === "object" && !Array.isArray(details)
            ? details.errors
            : undefined;
        if (errors === `No schema found for boundary '${boundary}'`) return;
        throw error;
      }
    },
    responseSupportsHateoas: (operationId: string, status: number, body: JsonValue) => {
      const route = operationRoutes.get(operationId);
      const operation =
        route === undefined ? undefined : inputOperation(doc, route.path, route.method);
      return responseSupportsHateoas(operation, status, body);
    },
    responseAllowsPaginationEnvelope: () => true,
  };
}

function inputOperation(doc: OpenApiDoc, path: string, method: string) {
  return doc.paths[path]?.[method];
}

export interface RuntimeSystemDependencies {
  readonly events?: RuntimeDependencies["events"];
  readonly state?: RuntimeDependencies["state"];
  readonly idempotency?: RuntimeDependencies["idempotency"];
  readonly faults?: RuntimeFaultStore;
  readonly webhooks?: RuntimeWebhookTransport;
  readonly forwarding?: RuntimeForwardingPort;
  readonly observability?: RuntimeDependencies["observability"];
  readonly sleep?: RuntimeDependencies["sleep"];
  readonly helpers?: RuntimeDependencies["helpers"];
  readonly clock?: RuntimeClock;
  /** Timer port for runtime-owned stores and background maintenance. */
  readonly timers?: RuntimeTimerScheduler;
  /** CSRF/session token factory owned by the host composition root. */
  readonly sessionToken?: () => string;
}

export interface RuntimeBootInput extends RuntimeSystemDependencies {
  readonly openapi: OpenApiDoc;
  /** Host-owned runtime services are mandatory at the lowest boot boundary. */
  readonly host: RuntimeHostServices;
  /** Runtime metadata supplied by the host instead of read from process state. */
  readonly version?: string;
  /** Optional typed top-level discovery/configuration metadata. */
  readonly configuration?: PotemkinConfiguration;
  /** Optional source locations used by the common static error-body lint. */
  readonly sourceByBoundary?: Readonly<Record<string, string>>;
  /** A fully normalized program supplied by callers that need direct runtime control. */
  readonly program?: RuntimeProgram;
  /** Optional static model emitted by the authoring composition boundary. */
  readonly transitionModel?: TransitionModel;
  /** Compile an external source into the canonical RuntimeProgram. */
  readonly programFactory?: (
    context: RuntimeCompilationContext,
  ) => RuntimeProgram | Promise<RuntimeProgram>;
  /** Optional Specmatic plugin callback used for ready/shutdown lifecycle signals. */
  readonly pluginControl?: PluginControlClient;
}

export interface RuntimeCompilationContext {
  readonly openapi: OpenApiDoc;
  readonly dependencies: RuntimeDependencies;
}

export interface RuntimeSystem {
  openapi: OpenApiDoc;
  validator: ContractValidator;
  /** Active canonical runtime program. Updated after an atomic reload. */
  program: RuntimeProgram;
  /** Source-independent static model exposed by the read-only admin surface. */
  transitionModel?: TransitionModel;
  readonly engine: RuntimeEngine;
  readonly sessions: SessionStore;
  readonly clock: RuntimeClock;
  readonly faults: RuntimeFaultStore;
  /** Configuration metadata exposed to Specmatic discovery when supplied. */
  /** Current typed configuration. Updated after a successful file reload. */
  configuration?: PotemkinConfiguration;
  /** Reload the configuration-backed source graph, when this is a configured runtime. */
  reloadConfiguration?: () => Promise<unknown>;
  /** Install a newly compiled source-independent program without losing events. */
  readonly reload: (
    program: RuntimeProgram,
    options?: Readonly<{
      clear?: boolean;
      openapi?: OpenApiDoc;
      sourceByBoundary?: Readonly<Record<string, string>>;
      transitionModel?: TransitionModel;
    }>,
  ) => Promise<void>;
  /** Register resources (file watchers, transports) that must stop on dispose. */
  readonly addDisposeHook: (hook: () => Promise<void> | void) => void;
  readonly dispose: () => Promise<void>;
}

function runtimeSessions(store: SessionStore): RuntimeSessionStore {
  return {
    create: (actor: Readonly<Actor>, ttlSeconds: number) => {
      const session = store.create({ id: actor.id, scopes: [...actor.scopes] }, ttlSeconds * 1_000);
      return {
        id: session.id,
        actor: session.actor,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      };
    },
    get: (id, at) => {
      const session = store.get(id, at);
      return session === null
        ? undefined
        : {
            id: session.id,
            actor: session.actor,
            csrfToken: session.csrfToken,
            expiresAt: session.expiresAt,
          };
    },
    destroy: (id) => {
      store.destroy(id);
    },
    clear: () => {
      store.reset();
    },
  };
}

function buildDependencies(
  input: RuntimeBootInput,
  validator: ContractValidator,
  sessions: SessionStore,
  clock: RuntimeClock,
  helpers: RuntimeHelpers,
  stores: Readonly<{
    events: NonNullable<RuntimeDependencies["events"]>;
    state: NonNullable<RuntimeDependencies["state"]>;
    idempotency: NonNullable<RuntimeDependencies["idempotency"]>;
  }>,
): RuntimeDependencies {
  return {
    contract: runtimeContract(input.openapi, validator, {
      now: helpers.now,
      codeMap: input.openapi.errorCodeMap,
    }),
    helpers,
    events: stores.events,
    state: stores.state,
    idempotency: stores.idempotency,
    ...(input.faults === undefined ? {} : { faults: input.faults }),
    ...(input.webhooks === undefined ? {} : { webhooks: input.webhooks }),
    ...(input.forwarding === undefined ? {} : { forwarding: input.forwarding }),
    ...(input.observability === undefined ? {} : { observability: input.observability }),
    sleep: input.sleep,
    sessions: runtimeSessions(sessions),
    authentication: createRuntimeAuthenticationPort(),
    clock,
  };
}

/**
 * Boot the source-independent runtime. Source compilers supply a
 * `programFactory` when they need the runtime dependencies while compiling
 * their own representation.
 */
export async function bootRuntime(input: RuntimeBootInput): Promise<RuntimeSystem> {
  if ([input.program, input.programFactory].filter((value) => value !== undefined).length !== 1) {
    throw new ConfigurationError("bootRuntime requires exactly one of program or programFactory", {
      field: "bootRuntime.source",
    });
  }
  const validator = createContractValidator(input.openapi, []);
  const runtimeVersion = input.version ?? "0.1.0";
  const host = input.host;
  const clock = input.clock ?? input.program?.dependencies.clock ?? host.clock;
  const helpers = input.helpers ?? input.program?.dependencies.helpers ?? host.helpers;
  const sleep = input.sleep ?? input.program?.dependencies.sleep ?? host.sleep;
  const faults =
    input.faults ??
    input.program?.dependencies.faults ??
    createRuntimeFaultStore(clock.nowMs, helpers.uuid);
  const stores = {
    events: input.events ?? input.program?.dependencies.events ?? createMemoryEventStore(),
    state: input.state ?? input.program?.dependencies.state ?? createMemoryStateStore(),
    idempotency:
      input.idempotency ??
      input.program?.dependencies.idempotency ??
      createMemoryIdempotencyStore(clock.nowMs),
  } as const;
  const sessions = createSessionStore({
    nowMs: clock.nowMs,
    uuid: helpers.uuid,
    csrfToken: input.sessionToken ?? host.sessionToken,
    scheduler: input.timers ?? host.timers,
  });
  const dependencies = buildDependencies(
    { ...input, helpers, faults, sleep },
    validator,
    sessions,
    clock,
    helpers,
    stores,
  );
  const compiledProgram =
    input.program ??
    (await input.programFactory!({
      openapi: input.openapi,
      dependencies,
    }));
  const program =
    input.program === undefined
      ? compiledProgram
      : ({
          ...input.program,
          dependencies: {
            ...input.program.dependencies,
            ...dependencies,
            // A fully supplied program may carry externally managed stores. Keep
            // them unless the boot input explicitly replaces them.
            ...(input.events === undefined && input.program.dependencies.events !== undefined
              ? { events: input.program.dependencies.events }
              : {}),
            ...(input.state === undefined && input.program.dependencies.state !== undefined
              ? { state: input.program.dependencies.state }
              : {}),
            ...(input.idempotency === undefined &&
            input.program.dependencies.idempotency !== undefined
              ? { idempotency: input.program.dependencies.idempotency }
              : {}),
          },
        } satisfies RuntimeProgram);
  lintOrThrow({
    program,
    openapi: input.openapi,
    sourceByBoundary: input.sourceByBoundary,
    transitionModel: input.transitionModel,
  });
  const engine = createRuntimeEngine(program);
  await engine.start();
  const startedAt = helpers.now();
  const contractPaths = [...program.byContractPath.keys()].sort();
  const routesChecksum = createHash("sha256").update(contractPaths.join("\n")).digest("hex");
  const baselineEvents = engine
    .snapshot()
    .events.filter((event) => event.eventId.startsWith("baseline-"))
    .map((event) => ({
      boundary: event.boundary,
      aggregateId: event.aggregateId,
      payload: event.payload,
    }));
  const fixturesChecksum = createHash("sha256")
    .update(JSON.stringify(baselineEvents))
    .digest("hex");
  const disposeHooks = new Set<() => Promise<void> | void>();
  let disposed = false;
  const system: RuntimeSystem = {
    openapi: input.openapi,
    validator,
    program,
    engine,
    sessions,
    clock,
    faults,
    ...(input.configuration === undefined ? {} : { configuration: input.configuration }),
    ...(input.transitionModel === undefined ? {} : { transitionModel: input.transitionModel }),
    reload: async (nextProgram, options = {}) => {
      if (disposed)
        throw new ConfigurationError("Cannot reload a disposed runtime", {
          field: "runtime.reload",
        });
      const nextValidator =
        options.openapi === undefined ? undefined : createContractValidator(options.openapi, []);
      const nextWithContract =
        options.openapi === undefined
          ? nextProgram
          : ({
              ...nextProgram,
              dependencies: {
                ...nextProgram.dependencies,
                contract: runtimeContract(options.openapi, nextValidator!, {
                  now: helpers.now,
                  codeMap: options.openapi.errorCodeMap,
                }),
              },
            } satisfies RuntimeProgram);
      lintOrThrow({
        program: nextWithContract,
        openapi: options.openapi ?? system.openapi,
        sourceByBoundary: options.sourceByBoundary,
        transitionModel: options.transitionModel ?? system.transitionModel,
      });
      if (options.openapi !== undefined) {
        system.openapi = options.openapi;
        system.validator = nextValidator!;
      }
      await engine.replaceProgram(nextWithContract, { preserveEvents: options.clear !== true });
      system.program = engine.program;
      if (options.transitionModel !== undefined) system.transitionModel = options.transitionModel;
      if (input.pluginControl !== undefined) {
        const nextContractPaths = [...engine.program.byContractPath.keys()].sort();
        const nextBaselineEvents = engine
          .snapshot()
          .events.filter((event) => event.eventId.startsWith("baseline-"))
          .map((event) => ({
            boundary: event.boundary,
            aggregateId: event.aggregateId,
            payload: event.payload,
          }));
        await input.pluginControl.notifyReady({
          engine: "potemkin-stateful",
          version: runtimeVersion,
          startedAt: helpers.now(),
          contractPaths: nextContractPaths,
          routesChecksum: createHash("sha256").update(nextContractPaths.join("\n")).digest("hex"),
          fixturesChecksum: createHash("sha256")
            .update(JSON.stringify(nextBaselineEvents))
            .digest("hex"),
        });
      }
    },
    addDisposeHook: (hook) => {
      if (disposed) {
        void hook();
        return;
      }
      disposeHooks.add(hook);
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      for (const hook of disposeHooks) await hook();
      disposeHooks.clear();
      if (input.pluginControl !== undefined) {
        await input.pluginControl.notifyShutdown({
          engine: "potemkin-stateful",
          version: runtimeVersion,
          reason: "manual",
          stoppedAt: helpers.now(),
        });
      }
      await engine.shutdown();
      sessions.dispose();
    },
  };
  if (input.pluginControl !== undefined) {
    void input.pluginControl.notifyReady({
      engine: "potemkin-stateful",
      version: runtimeVersion,
      startedAt,
      contractPaths,
      routesChecksum,
      fixturesChecksum,
    });
  }
  return system;
}
