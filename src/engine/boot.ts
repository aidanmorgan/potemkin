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

import { compileDsl } from '../dsl/parser.js';
import { validateBehaviorOperationIds } from '../dsl/behaviorValidation.js';
import { BootError } from '../errors.js';
import { createCelEvaluator } from '../cel/evaluator.js';
import { createEventStore } from '../eventstore/store.js';
import { createStateGraph, deepFreeze } from '../stategraph/graph.js';
import { createContractValidator } from '../contract/validator.js';
import { createIdempotencyStore, type IdempotencyStore } from '../idempotency/store.js';
import { projectEvent } from './projection.js';
import { epochAnchoredUuidv7 } from '../ids/uuidv7.js';
import { rootLogger, childLogger } from '../observability/logger.js';
import { getTracer, withSpan, createEngineMetrics } from '../observability/index.js';
import { deriveSchemasFromOpenApi } from '../schema/fromOpenApi.js';
import { staticCheckDsl } from '../schema/dslStaticChecker.js';
import { createDerivedProjectionRegistry, applyEventToDerivedProjections } from '../projections/engine.js';
import { createPluginControlClient } from '../lifecycle/pluginControlClient.js';
import { scanTypescriptReducers, type TypescriptConfig } from '../dsl/typescriptScanner.js';
import { validateReducerConflictsFromDsl } from '../dsl/reducerConflict.js';
import { createTsReducerRegistry, type TsReducerRegistry } from './tsReducerRegistry.js';
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
  readonly typescript?: import('../dsl/typescriptScanner.js').TypescriptConfig;
  /** Working directory for resolving `typescript.scan[]` globs on the in-memory path. */
  readonly typescriptCwd?: string;
}

export interface BootedSystem {
  readonly dsl: CompiledDsl;
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
   * as a required header parameter (REQ-29). Used by the UoW precondition check.
   */
  readonly requiresPrecondition: (boundary: string, method: string) => boolean;
  /**
   * REQ-88/90: Derived projection registry — keyed by projection name.
   * Populated by applyEventToDerivedProjections after each committed event.
   */
  readonly derivedProjections: DerivedProjectionRegistry;
  /** Per-system idempotency store (instance, not a shared singleton). */
  readonly idempotencyStore: IdempotencyStore;
  /** Per-system aggregate lock map (serializes concurrent same-aggregate UoWs). */
  readonly aggregateLocks: Map<string, Promise<void>>;
  /**
   * Plugin control client, present when `BootInput.pluginControl` was supplied.
   * Used by the graceful-shutdown wrapper to send a /shutdown notification.
   */
  readonly pluginControl?: PluginControlClient;
  /**
   * TypeScript-reducer registry. Projection consults this FIRST for a
   * (boundary, event) before falling back to YAML patches (C3). Empty when no
   * typescript: block was configured. Atomic-swapped by the watcher (C6).
   */
  readonly tsReducerRegistry: TsReducerRegistry;
  /**
   * C4: per-boundary inferred state schema (keyed by boundary name). Carries
   * the computed-field topological order + paths used by recomputeComputedFields
   * (C5) and the computedFields surfaced on GET /_engine/state.
   */
  readonly inferredSchemas: Readonly<Record<string, BoundaryInferenceResult>>;
}

/** Header names that indicate an optimistic-concurrency precondition. */
const IF_MATCH_HEADER_NAMES = new Set(['if-match', 'If-Match']);

/**
 * Walk the OpenAPI paths for each boundary's contractPath and record which
 * (boundary, HTTP-method-uppercase) pairs declare If-Match as a required
 * header parameter (REQ-29).
 *
 * Returns a callback suitable for `BootedSystem.requiresPrecondition`.
 */
function buildPreconditionMap(
  openapi: OpenApiDoc,
  boundaries: readonly BoundaryConfig[],
): (boundary: string, method: string) => boolean {
  // key: `${boundary}:${METHOD_UPPERCASE}` → true
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
  let schema = schemas?.[boundary.boundary] as Record<string, unknown> | undefined;
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
    let loadedConfig: import('../dsl/configLoader.js').LoadedConfig | undefined;
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
      loadedConfig = await loadPotemkinConfig(input.potemkinConfigPath);
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

    // ── Step 2b: TypeScript reducer scan + conflict check (C2) ───────────────
    // When potemkin.yaml declares a typescript: block, scan + transpile every
    // reducer file into the SDK registry, then cross-check the registered
    // reducers against the compiled YAML BEFORE binding any routes. A YAML
    // reducer and a TS reducer that target the same (boundary, event) are a
    // BOOT_ERR_REDUCER_CONFLICT (with both source locations).
    const tsReducerRegistry: TsReducerRegistry = createTsReducerRegistry();
    const tsConfig: TypescriptConfig | undefined = loadedConfig?.typescript
      ? (loadedConfig.typescript as unknown as TypescriptConfig)
      : input.typescript;
    const tsScanCwd = configDir ?? input.typescriptCwd;
    if (tsConfig && tsScanCwd) {
      const phaseStart2b = Date.now();
      bootLog.info({ step: 'ts_scan' }, 'Boot: scanning TypeScript reducers');
      const scan = await scanTypescriptReducers(tsConfig, { cwd: tsScanCwd });
      validateReducerConflictsFromDsl({
        dsl,
        boundarySourcePaths: loadedConfig?.boundarySourcePaths ?? {},
        tsReducers: scan.registered,
      });
      tsReducerRegistry.swap(scan.registered);
      bootLog.info(
        { step: 'ts_scan', files: scan.files.length, reducers: scan.registered.length, durationMs: Date.now() - phaseStart2b },
        'Boot: TypeScript reducers scanned and registered',
      );
    }

    // ── Step 2c: Per-boundary schema inference + computed-field lint (C4/C5) ──
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
      // C5: WARN on computed fields that are declared but never read on the
      // documented state surface. The state surface is every property name the
      // boundary's reducers/events touch plus the computed names themselves.
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

      // REQ-65: Boot-time resolution of schema_ref fields in event_catalog
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
        { violations: violations as unknown as import('../types.js').JsonObject[] },
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

    // ── Step 8: Build requiresPrecondition callback (REQ-29) ─────────────────
    // Walk OpenAPI paths to discover operations that declare If-Match as a
    // required header parameter; encode as a (boundary, method) → boolean map.
    const preconditionRequired = buildPreconditionMap(input.openapi, dsl.boundaries);

    // ── Step 9: Derived projection registry (REQ-88) ─────────────────────────
    const derivedProjections = createDerivedProjectionRegistry();

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

    const bootedSystem = {
      dsl,
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
      idempotencyStore: createIdempotencyStore(),
      aggregateLocks: new Map<string, Promise<void>>(),
      tsReducerRegistry,
      inferredSchemas,
      ...(pluginControlClient !== undefined ? { pluginControl: pluginControlClient } : {}),
    };

    // Fire-and-forget /ready notification — must not block boot completion.
    if (pluginControlClient) {
      const sortedPaths = Object.keys(dsl.byContractPath).sort();
      const { createHash } = await import('node:crypto');
      const routesChecksum = createHash('sha256').update(sortedPaths.join('\n')).digest('hex');
      const fixturesChecksum = createHash('sha256').update(String(frozenBaseline.length)).digest('hex');
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
