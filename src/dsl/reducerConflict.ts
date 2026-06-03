// Cross-checks the compiled snake_case DSL against TS-registered reducers.
// Emits BOOT_ERR_REDUCER_CONFLICT, BOOT_ERR_UNKNOWN_BOUNDARY/EVENT,
// and BOOT_ERR_REDUCER_MISSING as appropriate.

import { BootError } from '../errors.js';
import type { CompiledDsl } from './types.js';
import type { RegisteredReducer } from '../sdk/index.js';

export interface DslReducerConflictInput {
  readonly dsl: CompiledDsl;
  /** Maps each boundary name to its declaring source file (for error locations). */
  readonly boundarySourcePaths: Readonly<Record<string, string>>;
  readonly tsReducers: readonly RegisteredReducer[];
}

/**
 * Cross-check a compiled snake_case DSL against TS-registered reducers.
 *
 * - A TS reducer that targets an unknown boundary → BOOT_ERR_UNKNOWN_BOUNDARY.
 * - A TS reducer that targets an undeclared event → BOOT_ERR_UNKNOWN_EVENT.
 * - A (boundary, event) defined by BOTH a YAML reducer with patches AND a TS
 *   reducer → BOOT_ERR_REDUCER_CONFLICT, naming both source locations.
 */
export function validateReducerConflictsFromDsl(input: DslReducerConflictInput): void {
  const boundaryByName = new Map(input.dsl.boundaries.map((b) => [b.boundary, b]));

  for (const tsR of input.tsReducers) {
    const target = boundaryByName.get(tsR.boundary);
    if (!target) {
      throw new BootError(
        'BOOT_ERR_UNKNOWN_BOUNDARY',
        `TS reducer (${tsR.source}) targets boundary "${tsR.boundary}" which is not declared in any module`,
        { source: tsR.source, boundary: tsR.boundary },
      );
    }
    const eventExists = target.eventCatalog.some((e) => e.type === tsR.event);
    if (!eventExists) {
      throw new BootError(
        'BOOT_ERR_UNKNOWN_EVENT',
        `TS reducer (${tsR.source}) targets event "${tsR.boundary}:${tsR.event}" — event not declared in boundary`,
        { source: tsR.source, boundary: tsR.boundary, event: tsR.event },
      );
    }
  }

  for (const b of input.dsl.boundaries) {
    const yamlSource = input.boundarySourcePaths[b.boundary] ?? `<boundary:${b.boundary}>`;
    for (const yamlR of b.reducers) {
      const tsR = input.tsReducers.find(
        (r) => r.boundary === b.boundary && r.event === yamlR.on,
      );
      const hasYamlPatches = Array.isArray(yamlR.patches) && yamlR.patches.length > 0;
      if (tsR && hasYamlPatches) {
        throw new BootError(
          'BOOT_ERR_REDUCER_CONFLICT',
          `Reducer (${b.boundary}:${yamlR.on}) is declared by both YAML (${yamlSource}) and TS (${tsR.source})`,
          {
            boundary: b.boundary,
            event: yamlR.on,
            yamlSource,
            tsSource: tsR.source,
          },
        );
      }
      if (yamlR.implementation === 'typescript' && !tsR) {
        throw new BootError(
          'BOOT_ERR_REDUCER_MISSING',
          `Reducer (${b.boundary}:${yamlR.on}) is marked implementation: typescript but no TS reducer is registered`,
          { boundary: b.boundary, event: yamlR.on, yamlSource },
        );
      }
    }
  }
}

