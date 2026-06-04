import type { CompiledDsl, BoundaryConfig } from '../dsl/types.js';
import type { OpenApiDoc } from '../contract/loader.js';
import type { EventStore } from '../eventstore/store.js';
import type { StateGraph } from '../stategraph/graph.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { ContractValidator } from '../contract/validator.js';
import type { DomainEvent, JsonObject } from '../types.js';
import type { Logger } from '../observability/logger.js';
import type { Tracer } from '../observability/tracing.js';
import type { EngineMetrics } from '../observability/metrics.js';
import type { ObjectGraphSchemaRegistry } from '../schema/types.js';
import type { DerivedProjectionRegistry } from '../projections/types.js';
import type { PluginControlClient } from '../lifecycle/types.js';
import type { FetchLike } from '../webhooks/dispatcher.js';
import type { LoadedConfig } from '../dsl/configLoader.js';

import { validateBehaviorOperationIds } from '../dsl/behaviorValidation.js';
import { BootError } from '../errors.js';
import { createCelEvaluator } from '../cel/evaluator.js';
import { createEventStore } from '../eventstore/store.js';
import { createStateGraph, deepFreeze } from '../stategraph/graph.js';
import { createContractValidator } from '../contract/validator.js';
import { createIdempotencyStore, type IdempotencyStore } from '../idempotency/store.js';
import { createSessionStore, type SessionStore } from '../identity/sessionStore.js';
import { createFaultStore, type FaultStore } from '../faults/store.js';
import { projectEvent } from './projection.js';
import { epochAnchoredUuidv7 } from '../ids/uuidv7.js';
import { rootLogger, childLogger } from '../observability/logger.js';
import { getTracer, withSpan, createEngineMetrics } from '../observability/index.js';
import { deriveSchemasFromOpenApi } from '../schema/fromOpenApi.js';
import { lintOrThrow } from '../lint/runner.js';
import { ALL_CHECKS } from '../lint/checks/index.js';
import { staticCheckDsl } from '../schema/dslStaticChecker.js';
import { createDerivedProjectionRegistry, applyEventToDerivedProjections } from '../projections/engine.js';
import { createPluginControlClient } from '../lifecycle/pluginControlClient.js';
import { scanTypescriptReducers, type TypescriptConfig } from '../dsl/typescriptScanner.js';
import { validateReducerConflictsFromDsl } from '../dsl/reducerConflict.js';
import { validateBoundaryTsRefs } from '../dsl/schema.js';
import { buildCompositeScriptRegistry } from '../scripts/registry.js';
import type { RegisteredScript } from '../sdk/index.js';
import { createTsReducerRegistry, type TsReducerRegistry } from './tsReducerRegistry.js';
import { createTsScriptRegistry } from './tsScriptRegistry.js';
import { createFetchWebhookTransport } from '../webhooks/transport.js';
import { createResetEpoch, type ResetEpoch } from './sideEffects.js';
import { deriveFixtures } from '../forwarding/fixtures.js';
import {
  buildInferredSchema,
  boundaryConfigToInferenceInput,
  lintUnusedComputed,
  type BoundaryInferenceResult,
} from '../dsl/schemaInference.js';

export interface BootInput {
  readonly openapi: OpenApiDoc;
  // Pre-compiled DSL. Mutually exclusive with potemkinConfigPath. If
  // neither is supplied, boot enters wait-for-DSL-push mode (empty DSL,
  // contract-path requests return 503 with Retry-After:1).
  readonly compiledDsl?: CompiledDsl;
  // Path to a potemkin.yaml. When supplied, boot calls loadPotemkinConfig
  // synchronously and installs the result before binding endpoints.
  readonly potemkinConfigPath?: string;
  /** Optional logger; boot creates a root logger if absent. */
  readonly logger?: Logger;
  /** Optional tracer; boot obtains the default tracer if absent. */
  readonly tracer?: Tracer;
  /** Optional pre-built metrics instance; boot creates one if absent. */
  readonly metrics?: EngineMetrics;
  /**
   * Optional plugin control configuration.  When set, the engine sends a
   * POST /ready notification to the configured URL after a successful boot,
   * and attaches the client to BootedSystem for use during shutdown.
   */
  readonly pluginControl?: {
    readonly url: string;
    readonly timeoutMs?: number;
  };
  /**
   * Optional TypeScript-reducer scan config for the in-memory boot path
   * (when `compiledDsl` is supplied directly rather than a potemkin.yaml).
   * The on-disk path reads this from potemkin.yaml's typescript: block.
   */
  readonly typescript?: TypescriptConfig;
  /** Working directory for resolving `typescript.scan[]` globs on the in-memory path. */
  readonly typescriptCwd?: string;
  /**
   * Optional override for the outbound-webhook transport. When omitted, boot
   * wires a `fetch`-backed transport. Tests inject a fake to assert webhook
   * deliveries without performing real HTTP.
   */
  readonly webhookTransport?: FetchLike;
}

export interface BootedSystem {
  readonly dsl: CompiledDsl;
  /** Global ids of scripts discovered by the @Script scanner, for ts:<id> validation on hot DSL push. */
  readonly scannedScriptIds: ReadonlySet<string>;
  readonly openapi: OpenApiDoc;
  readonly events: EventStore;
  readonly graph: StateGraph;
  readonly cel: CelEvaluator;
  readonly validator: ContractValidator;
  /** Immutable copy of baseline events used for deterministic reset. */
  readonly frozenBaseline: readonly DomainEvent[];
  /** Active logger for the running system. */
  readonly logger: Logger;
  /** Active tracer for the running system. */
  readonly tracer: Tracer;
  /** Active engine metrics for the running system. */
  readonly metrics: EngineMetrics;
  /** Object-graph schema registry derived from OpenAPI component schemas at boot. */
  readonly schemaRegistry: ObjectGraphSchemaRegistry;
  /**
   * Returns true when the OpenAPI operation for (boundary, method) declares If-Match
   * as a required header parameter. Used by the UoW precondition check.
   */
  readonly requiresPrecondition: (boundary: string, method: string) => boolean;
  /**
   * Derived projection registry — keyed by projection name.
   * Populated by applyEventToDerivedProjections after each committed event.
   */
  readonly derivedProjections: DerivedProjectionRegistry;
  /** Per-system idempotency store (instance, not a shared singleton). */
  readonly idempotencyStore: IdempotencyStore;
  /**
   * Per-system session store backing session/cookie auth. Its clock is wired to
   * the CEL clock offset so /_admin/clock/advance expires sessions deterministically.
   */
  readonly sessionStore: SessionStore;
  /**
   * Per-system dynamic fault store backing the runtime fault-injection admin
   * API (POST/GET/DELETE /_admin/faults). Holds fault rules registered at
   * runtime; the forwarding handler reads its rules when evaluating faults.
   * Cleared on /_admin/reset. Created per system (instance, not a singleton)
   * so dynamic faults never leak across booted systems.
   */
  readonly faultStore: FaultStore;
  /** Per-system aggregate lock map (serializes concurrent same-aggregate UoWs). */
  readonly aggregateLocks: Map<string, Promise<void>>;
  /**
   * Monotonic reset epoch. resetSystem increments it; post-commit side-effects
   * (sagas, webhooks) capture the value in force when scheduled and no-op if it
   * has advanced by the time they run, so a side-effect scheduled before a reset
   * cannot append orphan events into the freshly-reset store.
   */
  readonly resetEpoch: ResetEpoch;
  /**
   * Plugin control client, present when `BootInput.pluginControl` was supplied.
   * Used by the graceful-shutdown wrapper to send a /shutdown notification.
   */
  readonly pluginControl?: PluginControlClient;
  /**
   * TypeScript-reducer registry. Projection consults this FIRST for a
   * (boundary, event) before falling back to YAML patches. Empty when no
   * typescript: block was configured. Atomic-swapped by the watcher on hot reload.
   */
  readonly tsReducerRegistry: TsReducerRegistry;
  /**
   * Per-boundary inferred state schema (keyed by boundary name). Carries
   * the computed-field topological order + paths used by recomputeComputedFields
   * and the computedFields surfaced on GET /_engine/state.
   */
  readonly inferredSchemas: Readonly<Record<string, BoundaryInferenceResult>>;
  /**
   * Injectable webhook transport used by the UoW to deliver outbound webhooks
   * when `dsl.webhooks` is non-empty. Defaults to a `fetch`-backed transport;
   * tests may override it (via BootInput.webhookTransport) to assert deliveries
   * without real HTTP.
   */
  readonly webhookTransport: FetchLike;
  /**
   * Active TypeScript watcher when typescript.watch was enabled (and
   * NODE_ENV !== 'production'). Its onSwap atomic-replaces tsReducerRegistry on
   * a hot reload; the StateGraph survives. Callers (and tests) must stop() it
   * during teardown. Absent when watch is off.
   */
  readonly tsWatcher?: { stop(): Promise<void> };
}

/** Header names that indicate an optimistic-concurrency precondition. */
const IF_MATCH_HEADER_NAMES = new Set(['if-match', 'If-Match']);

/**
 * Validate the shape of a `typescript:` config block loaded from potemkin.yaml
 * before trusting it as a TypescriptConfig. YAML is untyped, so a malformed
 * block (missing/empty scan, non-array include) must fail loudly here at boot
 * rather than as an opaque error deep in the reducer scan.
 */
function assertTypescriptConfig(raw: unknown): TypescriptConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new BootError(
      'BOOT_ERR_TYPESCRIPT_CONFIG',
      'typescript: must be a mapping',
      { received: typeof raw },
    );
  }
  const block = raw as Record<string, unknown>;
  if (!Array.isArray(block['scan']) || block['scan'].length === 0) {
    throw new BootError(
      'BOOT_ERR_TYPESCRIPT_CONFIG',
      'typescript.scan: must be a non-empty array of { include } entries',
      { scan: JSON.stringify(block['scan']) ?? null },
    );
  }
  for (const [i, entry] of block['scan'].entries()) {
    const include = (entry as Record<string, unknown> | null)?.['include'];
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !Array.isArray(include) ||
      include.length === 0 ||
      include.some((g) => typeof g !== 'string')
    ) {
      throw new BootError(
        'BOOT_ERR_TYPESCRIPT_CONFIG',
        `typescript.scan[${i}].include: must be a non-empty array of glob strings`,
        { entry },
      );
    }
  }
  if (block['watch'] !== undefined && typeof block['watch'] !== 'boolean') {
    throw new BootError(
      'BOOT_ERR_TYPESCRIPT_CONFIG',
      'typescript.watch: must be a boolean',
      { watch: JSON.stringify(block['watch']) ?? null },
    );
  }
  return raw as TypescriptConfig;
}

/**
 * Build the If-Match precondition lookup for a boundary set. Exported so the hot
 * DSL-push path (engineDslRoutes) can rebuild it from the merged DSL, keeping it
 * consistent with `sys.dsl` after a push (mirrors the boot-time derivation).
 */
export function buildPreconditionMap(
  openapi: OpenApiDoc,
  boundaries: readonly BoundaryConfig[],
): (boundary: string, method: string) => boolean {
  const required = new Set<string>();

  for (const bc of boundaries) {
    const pathItem = openapi.paths[bc.contractPath];
    if (!pathItem) continue;

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!operation?.parameters) continue;
      for (const param of operation.parameters) {
        if (
          IF_MATCH_HEADER_NAMES.has(param.name) &&
          param.in === 'header' &&
          param.required === true
        ) {
          required.add(`${bc.boundary}:${method.toUpperCase()}`);
        }
      }
    }
  }

  return (boundary: string, method: string): boolean =>
    required.has(`${boundary}:${method.toUpperCase()}`);
}

/**
 * Names that count as "reading" a computed field for the unused-computed lint:
 * every property declared on the boundary's OpenAPI entity schema (so a
 * computed field surfaced in the documented response is considered used) plus
 * any state.X referenced by another computed formula.
 */
function collectStateSurfaceNames(
  boundary: BoundaryConfig,
  openapi: OpenApiDoc,
): string[] {
  const names = new Set<string>();

  // OpenAPI entity schema property names (resolved $ref to a sibling schema).
  const rawDoc = openapi.raw as Record<string, unknown>;
  const components = rawDoc['components'] as Record<string, unknown> | undefined;
  const schemas = components?.['schemas'] as Record<string, unknown> | undefined;
  let schema = schemas?.[boundary.schema ?? boundary.boundary] as Record<string, unknown> | undefined;
  // Follow one level of local $ref (sub-path boundaries mirror their parent).
  const ref = schema?.['$ref'];
  if (typeof ref === 'string') {
    const m = /^#\/components\/schemas\/(.+)$/.exec(ref);
    if (m && schemas) schema = schemas[m[1]] as Record<string, unknown> | undefined;
  }
  const props = schema?.['properties'] as Record<string, unknown> | undefined;
  if (props) for (const k of Object.keys(props)) names.add(k);

  // Names referenced by sibling computed formulas.
  for (const cf of boundary.state?.computed ?? []) {
    for (const dep of cf.dependsOn) names.add(dep);
  }

  return [...names];
}

/**
 * Execute the full boot sequence:
 *  1. Compile DSL modules.
 *  2. Bind DSL to OpenAPI contract paths (validates contract coverage).
 *  3. Derive object-graph schema registry and run static DSL check.
 *  4. Initialise subsystems (CEL, EventStore, StateGraph, ContractValidator).
 *  5. Generate baseline (FrozenBaseline) events from `initialization` data.
 *  6. Hydrate the EventStore and StateGraph from the FrozenBaseline.
 *
 * @throws {BootError} BOOT_ERR_DSL_SYNTAX        — DSL parse/validation failure.
 * @throws {BootError} BOOT_ERR_CONTRACT_BIND      — contract path mapping failure.
 * @throws {BootError} BOOT_ERR_CONTRACT_LOAD      — OpenAPI load failure.
 * @throws {BootError} BOOT_ERR_BASELINE_HYDRATION — baseline projection failure.
 * @throws {BootError} BOOT_ERR_DSL_SCHEMA_VIOLATION — static schema violations.
 */
export async function bootSystem(input: BootInput): Promise<BootedSystem> {
  // ── Step 1: Initialise observability ─────────────────────────────────────────
  const logger: Logger = input.logger ?? rootLogger();
  const tracer: Tracer = input.tracer ?? getTracer('boot');
  const metrics: EngineMetrics = input.metrics ?? createEngineMetrics();

  return withSpan(tracer, 'engine.boot', async () => {
    const bootLog = childLogger(logger, { phase: 'boot' });

    // ── Step 2: DSL Compilation ───────────────────────────────────────────────
    const phaseStart2 = Date.now();

    let dsl: CompiledDsl;
    // Captured from the on-disk loader path for the TypeScript-reducer scan
    // (Step 2b) and the optional watcher (Step 11).
    let loadedConfig: LoadedConfig | undefined;
    let configDir: string | undefined;
    if (input.compiledDsl) {
      bootLog.info(
        { step: 'dsl_compile', source: 'compiledDsl', boundaryCount: input.compiledDsl.boundaries.length },
        'Boot: using pre-compiled DSL',
      );
      dsl = input.compiledDsl;
    } else if (input.potemkinConfigPath) {
      bootLog.info(
        { step: 'dsl_compile', source: 'potemkinConfigPath', path: input.potemkinConfigPath },
        'Boot: loading potemkin.yaml',
      );
      // Lazy import to keep the loader's tinyglobby/fs deps off the cold path
      // when callers supply `compiledDsl` directly.
      const { loadPotemkinConfig } = await import('../dsl/configLoader.js');
      loadedConfig = await loadPotemkinConfig(input.potemkinConfigPath, { openapi: input.openapi });
      const pathMod = await import('node:path');
      configDir = pathMod.dirname(pathMod.resolve(input.potemkinConfigPath));
      // The loader compiles the resolved DSL modules through the SAME
      // snake_case compiler the inline path uses, so this CompiledDsl is
      // identical to one produced by compileDsl over the same modules.
      dsl = loadedConfig.compiledDsl;
    } else {
      // No DSL supplied — boot in wait-for-DSL-push mode with an empty DSL.
      bootLog.info(
        { step: 'dsl_compile', source: 'wait-for-push' },
        'Boot: no DSL supplied; entering wait-for-DSL-push mode',
      );
      dsl = {
        boundaries: [],
        byContractPath: {},
        byBoundaryName: {},
      };
    }

    bootLog.info(
      { step: 'dsl_compile', boundaryCount: dsl.boundaries.length, durationMs: Date.now() - phaseStart2 },
      'Boot: DSL compilation complete',
    );

    // ── Step 2b: TypeScript reducer scan + conflict check ────────────────────
    // When potemkin.yaml declares a typescript: block, scan + transpile every
    // reducer file into the SDK registry, then cross-check the registered
    // reducers against the compiled YAML BEFORE binding any routes. A YAML
    // reducer and a TS reducer that target the same (boundary, event) are a
    // BOOT_ERR_REDUCER_CONFLICT (with both source locations).
    const tsReducerRegistry: TsReducerRegistry = createTsReducerRegistry();
    const tsConfig: TypescriptConfig | undefined = loadedConfig?.typescript
      ? assertTypescriptConfig(loadedConfig.typescript)
      : input.typescript;
    const tsScanCwd = configDir ?? input.typescriptCwd;
    // Watch mode is a development-only feature. Fail fast at boot if it is
    // requested in production rather than silently ignoring it.
    if (tsConfig?.watch === true && process.env['NODE_ENV'] === 'production') {
      throw new BootError(
        'BOOT_ERR_WATCH_IN_PRODUCTION',
        'typescript.watch: true is disabled when NODE_ENV=production',
        { nodeEnv: 'production' },
      );
    }
    let scannedScripts: RegisteredScript[] = [];
    if (tsConfig && tsScanCwd) {
      const phaseStart2b = Date.now();
      bootLog.info({ step: 'ts_scan' }, 'Boot: scanning TypeScript reducers and scripts');
      const scan = await scanTypescriptReducers(tsConfig, { cwd: tsScanCwd });
      validateReducerConflictsFromDsl({
        dsl,
        boundarySourcePaths: loadedConfig?.boundarySourcePaths ?? {},
        tsReducers: scan.registered,
      });
      tsReducerRegistry.swap(scan.registered);
      scannedScripts = [...scan.scripts];
      bootLog.info(
        { step: 'ts_scan', files: scan.files.length, reducers: scan.registered.length, scripts: scan.scripts.length, durationMs: Date.now() - phaseStart2b },
        'Boot: TypeScript reducers and scripts scanned and registered',
      );
    }

    // ── Step 2b-ii: Validate ts: script references against scanned @Script ids ─
    // After B3, all ts:<id> refs must resolve to a scanned @Script. An id that
    // resolves to no scanned script halts boot with BOOT_ERR_DSL_REFERENCE.
    const scannedScriptIds = new Set(scannedScripts.map((s) => s.id));
    for (const boundary of dsl.boundaries) {
      validateBoundaryTsRefs(boundary, scannedScriptIds);
    }

    // ── Step 2b-iii: Build composite script registry ──────────────────────────
    // Scanned @Script functions execute as direct host calls (no sandbox).
    // After B3 the inline scripts[].code form is removed; dsl.scriptRegistry
    // will always be undefined here, but buildCompositeScriptRegistry handles
    // undefined gracefully so the branch is retained for scanned-only usage.
    //
    // When watch mode is active the composite registry is wrapped in a
    // TsScriptRegistry mutable holder (same pattern as TsReducerRegistry) so
    // the onSwap callback below can rebuild it from the new @Script snapshot
    // without touching any UoW call site.  The holder itself is placed into
    // dsl.scriptRegistry, so all existing reads of input.dsl.scriptRegistry
    // automatically see the latest functions after each hot reload.
    let tsScriptRegistry: ReturnType<typeof createTsScriptRegistry> | undefined;
    if (scannedScripts.length > 0 || dsl.scriptRegistry) {
      if (tsConfig?.watch === true) {
        tsScriptRegistry = createTsScriptRegistry(dsl.scriptRegistry, scannedScripts);
        dsl = { ...dsl, scriptRegistry: tsScriptRegistry };
      } else {
        const compositeRegistry = buildCompositeScriptRegistry(dsl.scriptRegistry, scannedScripts);
        dsl = { ...dsl, scriptRegistry: compositeRegistry };
      }
    }

    // ── Step 2c: Per-boundary schema inference + computed-field lint ──────────
    // For every boundary, run the fixed-point inference over event templates +
    // reducer patches and merge declared computed/internal fields. Divergence
    // past the 4-iteration cap surfaces BOOT_ERR_SCHEMA_INFERENCE_DIVERGENT.
    // Unused computed declarations are linted to a WARN (file:line where known).
    const phaseStart2c = Date.now();
    const inferredSchemas: Record<string, BoundaryInferenceResult> = {};
    for (const boundary of dsl.boundaries) {
      const result = buildInferredSchema(boundaryConfigToInferenceInput(boundary));
      inferredSchemas[boundary.boundary] = result;
      for (const w of result.warnings) {
        bootLog.warn({ step: 'schema_inference', boundary: boundary.boundary }, `Boot: ${w}`);
      }
      // Warn on computed fields declared but never read on the documented state
      // surface. The state surface is every property name the boundary's
      // reducers/events touch plus the computed names themselves.
      const declaredComputed = boundary.state?.computed ?? [];
      if (declaredComputed.length > 0) {
        const surfaceNames = collectStateSurfaceNames(boundary, input.openapi);
        const unused = lintUnusedComputed(declaredComputed, { stateSurfaceNames: surfaceNames });
        for (const u of unused) {
          const src = loadedConfig?.boundarySourcePaths?.[boundary.boundary] ?? `<boundary:${boundary.boundary}>`;
          bootLog.warn({ step: 'computed_lint', boundary: boundary.boundary, source: src }, `Boot: ${u} (${src})`);
        }
      }
    }
    bootLog.info(
      { step: 'schema_inference', boundaries: Object.keys(inferredSchemas).length, durationMs: Date.now() - phaseStart2c },
      'Boot: per-boundary schema inference complete',
    );

    // ── Step 3: Contract Binding ──────────────────────────────────────────────
    const phaseStart3 = Date.now();
    bootLog.info({ step: 'contract_bind', boundaryCount: dsl.boundaries.length }, 'Boot: binding DSL to OpenAPI paths');

    for (const boundary of dsl.boundaries) {
      const contractPath = boundary.contractPath;
      if (!Object.prototype.hasOwnProperty.call(input.openapi.paths, contractPath)) {
        throw new BootError(
          'BOOT_ERR_DSL_REFERENCE',
          `Boundary '${boundary.boundary}' references contractPath '${contractPath}' which is not declared in the OpenAPI spec`,
          { boundary: boundary.boundary, path: contractPath },
        );
      }

      // Boot-time resolution of schema_ref fields in event_catalog
      const rawDoc = input.openapi.raw as Record<string, unknown>;
      const components = rawDoc['components'] as Record<string, unknown> | undefined;
      const schemas = components?.['schemas'] as Record<string, unknown> | undefined;

      for (const entry of boundary.eventCatalog) {
        if (entry.schemaRef) {
          const match = /^#\/components\/schemas\/(.+)$/.exec(entry.schemaRef);
          if (!match) {
            throw new BootError(
              'BOOT_ERR_DSL_SCHEMA_VIOLATION',
              `Boundary '${boundary.boundary}': event_catalog entry '${entry.type}' has invalid schema_ref format "${entry.schemaRef}" — expected "#/components/schemas/SchemaName"`,
              { boundary: boundary.boundary, eventType: entry.type, schemaRef: entry.schemaRef },
            );
          }
          const schemaName = match[1];
          if (!schemas || !Object.prototype.hasOwnProperty.call(schemas, schemaName)) {
            throw new BootError(
              'BOOT_ERR_DSL_SCHEMA_VIOLATION',
              `Boundary '${boundary.boundary}': event_catalog entry '${entry.type}' schema_ref "${entry.schemaRef}" cannot be resolved — schema "${schemaName}" not found in OpenAPI components/schemas`,
              { boundary: boundary.boundary, eventType: entry.type, schemaRef: entry.schemaRef },
            );
          }
          bootLog.debug({ boundary: boundary.boundary, eventType: entry.type, schemaRef: entry.schemaRef }, 'Boot: schema_ref resolved');
        }
      }
    }

    validateBehaviorOperationIds(dsl, input.openapi);

    // Strict lint of the fully-composed model: abort boot on any ERROR finding
    // with a located report; log WARNING findings (e.g. un-bounded operations).
    const lintWarnings = lintOrThrow(
      {
        dsl,
        openapi: input.openapi,
        ...(loadedConfig?.boundarySourcePaths ? { boundarySourcePaths: loadedConfig.boundarySourcePaths } : {}),
      },
      ALL_CHECKS,
    );
    for (const w of lintWarnings) {
      bootLog.warn({ step: 'lint', code: w.code, ...w.location }, `Lint: ${w.message}`);
    }

    bootLog.info(
      { step: 'contract_bind', durationMs: Date.now() - phaseStart3 },
      'Boot: contract binding complete',
    );

    // ── Step 4: Schema Registry + Static DSL Check ────────────────────────────
    const phaseStart4 = Date.now();
    bootLog.info({ step: 'schema_derive' }, 'Boot: deriving object-graph schema registry');

    // May throw BootError(BOOT_ERR_SCHEMA_MISSING | BOOT_ERR_SCHEMA_UNSUPPORTED)
    const schemaRegistry: ObjectGraphSchemaRegistry = deriveSchemasFromOpenApi(input.openapi, dsl.boundaries);

    bootLog.info(
      { step: 'schema_derive', durationMs: Date.now() - phaseStart4 },
      'Boot: schema registry derived',
    );

    const phaseStart4b = Date.now();
    bootLog.info({ step: 'dsl_static_check' }, 'Boot: running static DSL schema check');

    const violations = await staticCheckDsl(dsl, schemaRegistry);
    if (violations.length > 0) {
      throw new BootError(
        'BOOT_ERR_DSL_SCHEMA_VIOLATION',
        `Static DSL schema check found ${violations.length} violation(s)`,
        { violations: violations as unknown as JsonObject[] },
      );
    }

    bootLog.info(
      { step: 'dsl_static_check', durationMs: Date.now() - phaseStart4b },
      'Boot: static DSL check passed',
    );

    // ── Step 5: Subsystem Init ────────────────────────────────────────────────
    const phaseStart5 = Date.now();
    bootLog.info({ step: 'subsystem_init' }, 'Boot: initialising subsystems');

    const cel: CelEvaluator = createCelEvaluator();
    const events: EventStore = createEventStore();
    const graph: StateGraph = createStateGraph();
    const validator: ContractValidator = createContractValidator(input.openapi, dsl.boundaries);

    bootLog.info(
      { step: 'subsystem_init', durationMs: Date.now() - phaseStart5 },
      'Boot: subsystems initialised',
    );

    // ── Step 6: Baseline Generation (Frozen Image) ────────────────────────────
    const phaseStart6 = Date.now();
    bootLog.info({ step: 'baseline_gen' }, 'Boot: generating frozen baseline events');

    const baseline: DomainEvent[] = [];
    let globalIdx = 0;

    for (const boundary of dsl.boundaries) {
      if (!boundary.initialization || boundary.initialization.length === 0) {
        continue;
      }

      for (let i = 0; i < boundary.initialization.length; i++) {
        const record = boundary.initialization[i] as JsonObject;
        const aggregateId =
          typeof record['id'] === 'string' ? record['id'] : epochAnchoredUuidv7(globalIdx);

        // Deep-freeze: Object.freeze is shallow; deepFreeze ensures payload is also immutable
        // so that baseline state cannot be silently corrupted between boot and reset cycles.
        const event: DomainEvent = deepFreeze({
          eventId: epochAnchoredUuidv7(globalIdx),
          type: 'BaselineEntityCreatedEvent',
          boundary: boundary.boundary,
          aggregateId,
          payload: record,
          timestamp: '1970-01-01T00:00:00.000Z',
          sequenceVersion: 1,
          causedBy: null,
        });

        baseline.push(event);
        globalIdx++;
      }
    }

    const frozenBaseline: readonly DomainEvent[] = Object.freeze([...baseline]);

    bootLog.info(
      { step: 'baseline_gen', eventCount: frozenBaseline.length, durationMs: Date.now() - phaseStart6 },
      'Boot: frozen baseline generated',
    );

    // ── Step 7: Graph Hydration ───────────────────────────────────────────────
    const phaseStart7 = Date.now();
    bootLog.info({ step: 'graph_hydrate', eventCount: frozenBaseline.length }, 'Boot: hydrating event store and state graph from baseline');

    try {
      events.append(frozenBaseline);

      for (const event of frozenBaseline) {
        const boundaryConfig = dsl.byBoundaryName[event.boundary];
        if (!boundaryConfig) {
          throw new BootError(
            'BOOT_ERR_BASELINE_HYDRATION',
            `No boundary config found for baseline event boundary '${event.boundary}'`,
            { boundary: event.boundary, eventId: event.eventId },
          );
        }

        projectEvent({
          event,
          boundary: boundaryConfig,
          graph,
          cel,
          logger: bootLog,
          schemaRegistry,
        });
      }
    } catch (err) {
      if (err instanceof BootError) {
        throw err;
      }
      throw new BootError(
        'BOOT_ERR_BASELINE_HYDRATION',
        `Baseline hydration failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }

    bootLog.info(
      { step: 'graph_hydrate', entityCount: graph.size(), durationMs: Date.now() - phaseStart7 },
      'Boot: graph hydration complete',
    );

    bootLog.info(
      {
        step: 'boot_complete',
        boundaries: dsl.boundaries.length,
        baselineEvents: frozenBaseline.length,
        entities: graph.size(),
      },
      'Boot: system boot complete',
    );

    // ── Security warnings (informational — do not block boot) ─────────────────

    // ADMIN_TOKEN unset: admin endpoints are open without authentication.
    if (!process.env['ADMIN_TOKEN']) {
      bootLog.warn(
        { step: 'security_check', setting: 'ADMIN_TOKEN' },
        'Boot: ADMIN_TOKEN is not set — /_admin/* endpoints are unauthenticated. Set ADMIN_TOKEN to require Bearer auth.',
      );
    }

    // Scoped behaviors (requiredScopes) exist but auth.mode is not jwt: scope
    // checks are bypassable because simple/session/no-auth modes trust the
    // client-declared id:scopes token (Bearer alice:admin).
    const authMode = dsl.auth?.mode;
    if (authMode !== 'jwt') {
      const hasScopedBehavior = dsl.boundaries.some((b) =>
        b.behaviors.some((beh) => beh.match.requiredScopes && beh.match.requiredScopes.length > 0),
      );
      const hasScopedFault = dsl.boundaries.some((b) =>
        (b.faults ?? []).some((f) => f.match.requiredScopes && f.match.requiredScopes.length > 0),
      );
      const globalScopedFault = (dsl.faults ?? []).some(
        (f) => f.match.requiredScopes && f.match.requiredScopes.length > 0,
      );
      if (hasScopedBehavior || hasScopedFault || globalScopedFault) {
        bootLog.warn(
          { step: 'security_check', authMode: authMode ?? 'none', setting: 'auth.mode' },
          `Boot: auth.mode is "${authMode ?? 'none'}" but scoped behaviors/faults are configured — scope checks are bypassable via client-declared Bearer tokens. Set auth.mode: jwt to enforce real scope validation.`,
        );
      }
    }

    // ── Step 8: Build requiresPrecondition callback ───────────────────────────
    // Walk OpenAPI paths to discover operations that declare If-Match as a
    // required header parameter; encode as a (boundary, method) → boolean map.
    const preconditionRequired = buildPreconditionMap(input.openapi, dsl.boundaries);

    // ── Step 9: Derived projection registry ───────────────────────────────────
    const derivedProjections = createDerivedProjectionRegistry();

    // Pre-register every declared projection with an empty map so that
    // GET /_admin/derived/<name> returns 200 {} for a declared-but-empty
    // projection rather than 404 (which is reserved for unknown names).
    if (dsl.derivedProjections) {
      for (const proj of dsl.derivedProjections) {
        if (!derivedProjections.has(proj.name)) {
          derivedProjections.set(proj.name, new Map());
        }
      }
    }

    // Hydrate derived projections from baseline
    if (dsl.derivedProjections && dsl.derivedProjections.length > 0) {
      for (const event of frozenBaseline) {
        applyEventToDerivedProjections(
          event,
          dsl.derivedProjections,
          derivedProjections,
          cel,
          bootLog,
        );
      }
    }

    // ── Step 10: Plugin control client (optional) ─────────────────────────────
    // Build a PluginControlClient when a URL is configured, attach it to the
    // BootedSystem so the graceful-shutdown wrapper can call notifyShutdown.
    let pluginControlClient: PluginControlClient | undefined;
    if (input.pluginControl?.url) {
      pluginControlClient = createPluginControlClient({
        url: input.pluginControl.url,
        timeoutMs: input.pluginControl.timeoutMs,
        logger,
      });
    }

    // ── Step 11: TypeScript watcher ───────────────────────────────────────────
    // When typescript.watch is enabled (and NODE_ENV !== 'production'; the
    // production case already failed fast above), start a watcher whose onSwap
    // atomic-replaces the SDK reducer registry on the BootedSystem. The
    // StateGraph is untouched, so projected state survives a hot reload.
    let tsWatcher: { stop(): Promise<void> } | undefined;
    if (tsConfig?.watch === true && tsScanCwd) {
      const { startTypescriptWatcher } = await import('../dsl/typescriptWatcher.js');
      tsWatcher = await startTypescriptWatcher({
        config: tsConfig,
        cwd: tsScanCwd,
        onSwap: (result) => {
          tsReducerRegistry.swap(result.registered);
          tsScriptRegistry?.swap(result.scripts);
          bootLog.info(
            { step: 'ts_watch_swap', reducers: result.registered.length, scripts: result.scripts.length },
            'Boot: TypeScript reducer and script registries hot-swapped',
          );
        },
        onError: (err) => {
          bootLog.warn({ step: 'ts_watch', err }, 'Boot: TypeScript watcher rescan failed');
        },
      });
    }

    const bootedSystem = {
      dsl,
      scannedScriptIds,
      openapi: input.openapi,
      events,
      graph,
      cel,
      validator,
      frozenBaseline,
      logger,
      tracer,
      metrics,
      schemaRegistry,
      requiresPrecondition: preconditionRequired,
      derivedProjections,
      idempotencyStore: createIdempotencyStore({ nowMs: () => Date.now() + cel.getClockOffset() }),
      // Session expiry tracks the CEL virtual clock so admin clock-advance can
      // expire live sessions (and clock-reset restores them within TTL).
      sessionStore: createSessionStore({ nowMs: () => Date.now() + cel.getClockOffset() }),
      faultStore: createFaultStore({ nowMs: () => Date.now() + cel.getClockOffset() }),
      aggregateLocks: new Map<string, Promise<void>>(),
      resetEpoch: createResetEpoch(),
      tsReducerRegistry,
      inferredSchemas,
      webhookTransport: input.webhookTransport ?? createFetchWebhookTransport(),
      ...(tsWatcher !== undefined ? { tsWatcher } : {}),
      ...(pluginControlClient !== undefined ? { pluginControl: pluginControlClient } : {}),
    };

    // Fire-and-forget /ready notification — must not block boot completion.
    if (pluginControlClient) {
      const sortedPaths = Object.keys(dsl.byContractPath).sort();
      const { createHash } = await import('node:crypto');
      const routesChecksum = createHash('sha256').update(sortedPaths.join('\n')).digest('hex');
      // Must match the ETag of GET /_engine/fixtures so the plugin's conditional
      // refresh sees an unchanged fixture set. Formula mirrors computeFixturesChecksum
      // in src/forwarding/handler.ts: derive the stubs, sort by bound path, sha256
      // over the JSON serialisation.
      const fixtureStubs = deriveFixtures(bootedSystem);
      const sortedStubs = [...fixtureStubs].sort((a, b) =>
        a.httpRequest.path.localeCompare(b.httpRequest.path),
      );
      const fixturesChecksum = createHash('sha256').update(JSON.stringify(sortedStubs)).digest('hex');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkgVersion: string = (require('../../package.json') as { version: string }).version;

      const readyPayload = {
        engine: 'potemkin-stateful',
        version: pkgVersion,
        startedAt: new Date().toISOString(),
        contractPaths: sortedPaths,
        routesChecksum,
        fixturesChecksum,
      };

      // Spawn as a microtask so the BootedSystem is returned first.
      void Promise.resolve().then(async () => {
        const result = await pluginControlClient!.notifyReady(readyPayload);
        if (result.ok) {
          bootLog.info({ attempts: result.attempts, durationMs: result.durationMs }, 'Boot: plugin /ready notification sent');
        } else {
          bootLog.warn({ attempts: result.attempts, error: result.error }, 'Boot: plugin /ready notification failed (non-fatal)');
        }
      });
    }

    return bootedSystem;
  });
}
