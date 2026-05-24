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
import type { ExpectationStore } from '../specmatic/types.js';
import type { DerivedProjectionRegistry } from '../projections/types.js';

import { compileDsl } from '../dsl/parser.js';
import { BootError } from '../errors.js';
import { createCelEvaluator } from '../cel/evaluator.js';
import { createEventStore } from '../eventstore/store.js';
import { createStateGraph, deepFreeze } from '../stategraph/graph.js';
import { createContractValidator } from '../contract/validator.js';
import { projectEvent } from './projection.js';
import { epochAnchoredUuidv7 } from '../ids/uuidv7.js';
import { rootLogger, childLogger } from '../observability/logger.js';
import { getTracer, withSpan, createEngineMetrics } from '../observability/index.js';
import { deriveSchemasFromOpenApi } from '../schema/fromOpenApi.js';
import { staticCheckDsl } from '../schema/dslStaticChecker.js';
import { createExpectationStore } from '../specmatic/expectationStore.js';
import { loadExpectationsFromDirectory } from '../specmatic/loader.js';
import { createDerivedProjectionRegistry, applyEventToDerivedProjections } from '../projections/engine.js';

export interface BootInput {
  readonly openapi: OpenApiDoc;
  readonly dslModules: readonly { name: string; yaml: string }[];
  /** Optional logger; boot creates a root logger if absent. */
  readonly logger?: Logger;
  /** Optional tracer; boot obtains the default tracer if absent. */
  readonly tracer?: Tracer;
  /** Optional pre-built metrics instance; boot creates one if absent. */
  readonly metrics?: EngineMetrics;
  /**
   * Optional directory to pre-populate the expectation store from Specmatic stub files.
   * Every *.json file matching the Specmatic externalised stub format will be loaded.
   * T1+: if absent, the expectation store starts empty.
   */
  readonly specmaticStubDir?: string;
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
   * In-memory expectation store for Specmatic stub/service-virtualisation support.
   * The gateway consults this before dispatching to the CQRS pipeline.
   */
  readonly expectations: ExpectationStore;
  /**
   * REQ-88/90: Derived projection registry — keyed by projection name.
   * Populated by applyEventToDerivedProjections after each committed event.
   */
  readonly derivedProjections: DerivedProjectionRegistry;
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
    bootLog.info({ step: 'dsl_compile', moduleCount: input.dslModules.length }, 'Boot: compiling DSL modules');

    // compileDsl is async; throws BootError on failure (req 23)
    const dsl: CompiledDsl = await compileDsl(input.dslModules);

    bootLog.info(
      { step: 'dsl_compile', boundaryCount: dsl.boundaries.length, durationMs: Date.now() - phaseStart2 },
      'Boot: DSL compilation complete',
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

    // ── Step 10: Expectation store (Specmatic stub support) ──────────────────
    const expectations = createExpectationStore();

    if (input.specmaticStubDir) {
      bootLog.info({ step: 'stub_load', dir: input.specmaticStubDir }, 'Boot: loading Specmatic stub files');
      try {
        const stubs = await loadExpectationsFromDirectory(input.specmaticStubDir);
        for (const stub of stubs) {
          expectations.add(stub.request, stub.response, { source: 'file', filePath: stub.filePath });
        }
        bootLog.info(
          { step: 'stub_load', loaded: stubs.length },
          'Boot: Specmatic stubs loaded',
        );
      } catch (err) {
        // Non-fatal: log warning but don't abort boot
        bootLog.warn({ step: 'stub_load', err: err instanceof Error ? err.message : String(err) }, 'Boot: failed to load Specmatic stub files');
      }
    }

    return {
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
      expectations,
      derivedProjections,
    };
  });
}
