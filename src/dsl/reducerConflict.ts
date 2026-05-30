// Cross-checks YAML boundary modules against TS-registered reducers.
// Errors: BOOT_ERR_REDUCER_CONFLICT (both YAML+TS define the same key),
// BOOT_ERR_UNKNOWN_BOUNDARY/_EVENT (TS reducer points at nothing real),
// BOOT_ERR_REDUCER_MISSING (yaml flagged implementation:typescript but no
// TS handler is registered).

import { BootError } from '../errors.js';
import type { BoundaryModule } from './configSchema.js';
import type { CompiledDsl } from './types.js';
import type { RegisteredReducer } from '../sdk/index.js';

export interface ReducerConflictInput {
  readonly modules: readonly { path: string; boundary: BoundaryModule }[];
  readonly tsReducers: readonly RegisteredReducer[];
}

export interface DslReducerConflictInput {
  readonly dsl: CompiledDsl;
  /** Maps each boundary name to its declaring source file (for error locations). */
  readonly boundarySourcePaths: Readonly<Record<string, string>>;
  readonly tsReducers: readonly RegisteredReducer[];
}

/**
 * Cross-check a compiled snake_case DSL against TS-registered reducers. This is
 * the boot-path entry point: it reuses the same rules as validateReducerConflicts
 * but reads the canonical CompiledDsl shape (eventCatalog[].type, reducers[].on,
 * reducers[].patches) directly.
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
    }
  }
}

export function validateReducerConflicts(input: ReducerConflictInput): void {
  const boundaryByName = new Map<string, { path: string; boundary: BoundaryModule }>();
  for (const m of input.modules) boundaryByName.set(m.boundary.boundary, m);

  // ── Cross-reference validation ──
  for (const tsR of input.tsReducers) {
    const target = boundaryByName.get(tsR.boundary);
    if (!target) {
      throw new BootError(
        'BOOT_ERR_UNKNOWN_BOUNDARY',
        `TS reducer (${tsR.source}) targets boundary "${tsR.boundary}" which is not declared in any module`,
        { source: tsR.source, boundary: tsR.boundary },
      );
    }
    const eventExists = target.boundary.events.some((e) => e.name === tsR.event);
    if (!eventExists) {
      throw new BootError(
        'BOOT_ERR_UNKNOWN_EVENT',
        `TS reducer (${tsR.source}) targets event "${tsR.boundary}:${tsR.event}" — event not declared in boundary`,
        { source: tsR.source, boundary: tsR.boundary, event: tsR.event },
      );
    }
  }

  // ── Conflict detection: YAML vs TS for the same (boundary, event) ──
  for (const m of input.modules) {
    const yamlReducers = m.boundary.reducers ?? [];
    for (const yamlR of yamlReducers) {
      const tsR = input.tsReducers.find(
        (r) => r.boundary === m.boundary.boundary && r.event === yamlR.on,
      );
      const hasYamlPatches = Array.isArray(yamlR.patches) && yamlR.patches.length > 0;
      if (tsR && hasYamlPatches) {
        throw new BootError(
          'BOOT_ERR_REDUCER_CONFLICT',
          `Reducer (${m.boundary.boundary}:${yamlR.on}) is declared by both YAML (${m.path}) and TS (${tsR.source})`,
          {
            boundary: m.boundary.boundary,
            event: yamlR.on,
            yamlSource: m.path,
            tsSource: tsR.source,
          },
        );
      }
      // YAML `implementation: typescript` requires a matching TS reducer.
      if (yamlR.implementation === 'typescript' && !tsR) {
        throw new BootError(
          'BOOT_ERR_REDUCER_MISSING',
          `Reducer (${m.boundary.boundary}:${yamlR.on}) is marked implementation: typescript but no TS reducer is registered`,
          { boundary: m.boundary.boundary, event: yamlR.on, yamlSource: m.path },
        );
      }
    }
  }
}
