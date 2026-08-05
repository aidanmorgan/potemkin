/**
 * Source-independent runtime model contract.
 *
 * YAML parsing and TypeScript factories are producers of this shape. Once a
 * value crosses this boundary the runtime has no knowledge of which producer
 * created it.
 */
import type {
  RuntimeBoundary,
  RuntimeHelperDefinition,
  RuntimePolicies,
  RuntimeProgram,
} from './runtime.js';
import type { RuntimeDependencies } from './runtime.js';

export type RuntimeModel = RuntimeProgram;

export interface RuntimeDefinition {
  readonly boundaries: readonly RuntimeBoundary[];
  readonly policies?: RuntimePolicies;
  readonly helpers?: readonly RuntimeHelperDefinition[];
}

export interface RuntimeModelCompiler {
  compile(definition: RuntimeDefinition, dependencies: RuntimeDependencies): RuntimeModel;
}
