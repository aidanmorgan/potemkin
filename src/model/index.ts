/**
 * Source-independent runtime model contract.
 *
 * YAML parsing and TypeScript factories are producers of this shape. Once a
 * value crosses this boundary the runtime has no knowledge of which producer
 * created it.
 */
import type {
  CompiledRuntimeProgram,
  RuntimeBoundary,
  RuntimeHelperDefinition,
  RuntimePolicies,
} from './runtime.js';
import type { RuntimeDependencies } from './runtime.js';

/** RuntimeModel is the branded, compiled form; RuntimeProgram is its producer input. */
export type RuntimeModel = CompiledRuntimeProgram;

export interface RuntimeDefinition {
  readonly boundaries: readonly RuntimeBoundary[];
  readonly policies?: RuntimePolicies;
  readonly helpers?: readonly RuntimeHelperDefinition[];
}

export interface RuntimeModelCompiler {
  compile(definition: RuntimeDefinition, dependencies: RuntimeDependencies): RuntimeModel;
}
