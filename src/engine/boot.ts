import type { CompiledDsl } from '../dsl/types.js';
import type { OpenApiDoc } from '../contract/loader.js';
import type { EventStore } from '../eventstore/store.js';
import type { StateGraph } from '../stategraph/graph.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { ContractValidator } from '../contract/validator.js';
import type { DomainEvent } from '../types.js';

export interface BootInput {
  readonly openapi: OpenApiDoc;
  readonly dslModules: readonly { name: string; yaml: string }[];
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
