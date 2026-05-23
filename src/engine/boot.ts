import type { CompiledDsl } from '../dsl/types.js';
import type { OpenApiDoc } from '../contract/loader.js';
import type { EventStore } from '../eventstore/store.js';
import type { StateGraph } from '../stategraph/graph.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { ContractValidator } from '../contract/validator.js';
import type { DomainEvent } from '../types.js';
import type { Logger } from '../observability/logger.js';
import type { Tracer } from '../observability/tracing.js';
import type { EngineMetrics } from '../observability/metrics.js';
import type { ObjectGraphSchemaRegistry } from '../schema/types.js';

export interface BootInput {
  readonly openapi: OpenApiDoc;
  readonly dslModules: readonly { name: string; yaml: string }[];
  /** Optional logger; boot creates a root logger if absent. */
  readonly logger?: Logger;
  /** Optional tracer; boot obtains the default tracer if absent. */
  readonly tracer?: Tracer;
  /** Optional pre-built metrics instance; boot creates one if absent. */
  readonly metrics?: EngineMetrics;
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
}

/**
 * Execute the full boot sequence:
 *  1. Compile DSL modules.
 *  2. Bind DSL to OpenAPI contract paths (validates contract coverage).
 *  3. Generate baseline (FrozenBaseline) events from `initialization` data.
 *  4. Hydrate the EventStore and StateGraph from the FrozenBaseline.
 *
 * @throws {BootError} BOOT_ERR_DSL_SYNTAX        — DSL parse/validation failure.
 * @throws {BootError} BOOT_ERR_CONTRACT_BIND      — contract path mapping failure.
 * @throws {BootError} BOOT_ERR_CONTRACT_LOAD      — OpenAPI load failure.
 * @throws {BootError} BOOT_ERR_BASELINE_HYDRATION — baseline projection failure.
 */
export async function bootSystem(input: BootInput): Promise<BootedSystem> {
  throw new Error('NotImplemented: engine/boot.bootSystem');
}
