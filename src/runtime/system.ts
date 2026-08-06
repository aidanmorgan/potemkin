import type { OpenApiDoc } from '../contract/loader.js';
import { createContractValidator, type ContractValidator } from '../contract/validator.js';
import type { PotemkinConfiguration } from '../contracts/config.js';
import { createRuntimeEngine, type RuntimeEngine } from '../core/engine.js';
import type {
  CompiledRuntimeProgram,
  RuntimeDependencies,
  RuntimeContract,
  RuntimeProgram,
  RuntimeFaultStore,
  RuntimeHelpers,
} from '../model/runtime.js';
import { compileRuntimeMetadata } from '../model/runtime.js';
import type {
  RuntimeClock,
  RuntimeForwardingPort,
  RuntimeSessionStore,
  RuntimeWebhookTransport,
} from '../contracts/ports.js';
import { createRuntimeFaultStore } from '../core/faults.js';
import {
  createMemoryEventStore,
  createMemoryIdempotencyStore,
  createMemoryStateStore,
} from '../core/storage.js';
import { createRuntimeAuthenticationPort } from '../identity/actorResolver.js';
import { createSessionStore, type SessionStore } from '../identity/sessionStore.js';
import type { Actor } from '../contracts/identity.js';
import { ConfigurationError } from '../errors.js';

import type { PluginControlClient } from '../contracts/lifecycle.js';
import { createHash } from 'node:crypto';
import type { RuntimeHostServices } from './host.js';
import type { RuntimeTimerScheduler } from './ports.js';
import { createRuntimeContract } from './contract.js';
import { lintOrThrow } from '../lint/runner.js';
import type { TransitionModel } from '../model/transitionModel.js';

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
  return createRuntimeContract(doc, validator, options);
}

export interface RuntimeSystemDependencies {
  readonly events?: RuntimeDependencies['events'];
  readonly state?: RuntimeDependencies['state'];
  readonly idempotency?: RuntimeDependencies['idempotency'];
  readonly faults?: RuntimeFaultStore;
  readonly webhooks?: RuntimeWebhookTransport;
  readonly forwarding?: RuntimeForwardingPort;
  readonly observability?: RuntimeDependencies['observability'];
  readonly sleep?: RuntimeDependencies['sleep'];
  readonly helpers?: RuntimeDependencies['helpers'];
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
  program: CompiledRuntimeProgram;
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
    events: NonNullable<RuntimeDependencies['events']>;
    state: NonNullable<RuntimeDependencies['state']>;
    idempotency: NonNullable<RuntimeDependencies['idempotency']>;
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

function baselineEvents(engine: RuntimeEngine) {
  return engine
    .snapshot()
    .events.filter((event) => event.eventId.startsWith('baseline-'))
    .map((event) => ({
      boundary: event.boundary,
      aggregateId: event.aggregateId,
      payload: event.payload,
    }));
}

function baselineFixturesChecksum(engine: RuntimeEngine): string {
  return createHash('sha256')
    .update(JSON.stringify(baselineEvents(engine)))
    .digest('hex');
}

/**
 * Boot the source-independent runtime. Source compilers supply a
 * `programFactory` when they need the runtime dependencies while compiling
 * their own representation.
 */
export async function bootRuntime(input: RuntimeBootInput): Promise<RuntimeSystem> {
  if ([input.program, input.programFactory].filter((value) => value !== undefined).length !== 1) {
    throw new ConfigurationError('bootRuntime requires exactly one of program or programFactory', {
      field: 'bootRuntime.source',
    });
  }
  const validator = createContractValidator(input.openapi, []);
  const runtimeVersion = input.version ?? '0.1.0';
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
  let sourceProgram: RuntimeProgram;
  if (input.program !== undefined) {
    sourceProgram = input.program;
  } else {
    const programFactory = input.programFactory;
    if (programFactory === undefined) {
      throw new ConfigurationError('bootRuntime requires a program or programFactory', {
        field: 'programFactory',
      });
    }
    sourceProgram = await programFactory({
      openapi: input.openapi,
      dependencies,
    });
  }
  const sourceWithDependencies =
    input.program === undefined
      ? sourceProgram
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
  const program = compileRuntimeMetadata(sourceWithDependencies);
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
  const routesChecksum = createHash('sha256').update(contractPaths.join('\n')).digest('hex');
  const fixturesChecksum = baselineFixturesChecksum(engine);
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
        throw new ConfigurationError('Cannot reload a disposed runtime', {
          field: 'runtime.reload',
        });
      const nextValidator =
        options.openapi === undefined ? undefined : createContractValidator(options.openapi, []);
      const nextWithContract =
        options.openapi === undefined
          ? nextProgram
          : (() => {
              if (nextValidator === undefined) {
                throw new ConfigurationError('Reload validator was not initialized', {
                  field: 'reload.openapi',
                });
              }
              return {
                ...nextProgram,
                dependencies: {
                  ...nextProgram.dependencies,
                  contract: runtimeContract(options.openapi, nextValidator, {
                    now: helpers.now,
                    codeMap: options.openapi.errorCodeMap,
                  }),
                },
              } satisfies RuntimeProgram;
            })();
      const nextProgramWithMetadata = compileRuntimeMetadata(nextWithContract);
      lintOrThrow({
        program: nextProgramWithMetadata,
        openapi: options.openapi ?? system.openapi,
        sourceByBoundary: options.sourceByBoundary,
        transitionModel: options.transitionModel ?? system.transitionModel,
      });
      if (options.openapi !== undefined) {
        if (nextValidator === undefined) {
          throw new ConfigurationError('Reload validator was not initialized', {
            field: 'reload.openapi',
          });
        }
        system.openapi = options.openapi;
        system.validator = nextValidator;
      }
      await engine.replaceProgram(nextProgramWithMetadata, {
        preserveEvents: options.clear !== true,
      });
      system.program = nextProgramWithMetadata;
      if (options.transitionModel !== undefined) system.transitionModel = options.transitionModel;
      if (input.pluginControl !== undefined) {
        const nextContractPaths = [...engine.program.byContractPath.keys()].sort();
        await input.pluginControl.notifyReady({
          engine: 'potemkin-stateful',
          version: runtimeVersion,
          startedAt: helpers.now(),
          contractPaths: nextContractPaths,
          routesChecksum: createHash('sha256').update(nextContractPaths.join('\n')).digest('hex'),
          fixturesChecksum: baselineFixturesChecksum(engine),
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
          engine: 'potemkin-stateful',
          version: runtimeVersion,
          reason: 'manual',
          stoppedAt: helpers.now(),
        });
      }
      await engine.shutdown();
      sessions.dispose();
    },
  };
  if (input.pluginControl !== undefined) {
    void input.pluginControl.notifyReady({
      engine: 'potemkin-stateful',
      version: runtimeVersion,
      startedAt,
      contractPaths,
      routesChecksum,
      fixturesChecksum,
    });
  }
  return system;
}
