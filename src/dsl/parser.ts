import type { BoundaryConfig, CompiledDsl } from './types.js';

/**
 * Parse a single YAML module string into a BoundaryConfig.
 * Delegates shape validation to `validateBoundaryConfig`.
 * @throws {BootError} with code `BOOT_ERR_DSL_SYNTAX` on parse or validation failure.
 */
export function parseDslYaml(text: string): BoundaryConfig {
  throw new Error('NotImplemented: dsl/parser.parseDslYaml');
}

/**
 * Compile multiple named YAML modules into a unified, indexed CompiledDsl.
 * @throws {BootError} with code `BOOT_ERR_DSL_SYNTAX` on any parse or validation failure.
 */
export function compileDsl(
  modules: readonly { name: string; yaml: string }[],
): CompiledDsl {
  throw new Error('NotImplemented: dsl/parser.compileDsl');
}
