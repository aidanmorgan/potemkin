/**
 * Reducer conflict + cross-reference validator (REQ-TS-005).
 *
 * Given a set of boundary modules and the SDK registry's TS-registered
 * reducers, verifies:
 *   - No (boundary, event) pair has both a YAML `reducers[]` entry AND a
 *     TS-registered reducer. Conflict → BOOT_ERR_REDUCER_CONFLICT.
 *   - Every TS reducer references a boundary that exists in some module.
 *     Unknown boundary → BOOT_ERR_UNKNOWN_BOUNDARY.
 *   - Every TS reducer references an event declared on the target boundary.
 *     Unknown event → BOOT_ERR_UNKNOWN_EVENT.
 *   - A YAML reducer with `implementation: typescript` must have a matching
 *     TS-registered reducer. Missing → BOOT_ERR_REDUCER_MISSING.
 */

import { BootError } from '../errors.js';
import type { BoundaryModule } from './configSchema.js';
import type { RegisteredReducer } from '../sdk/index.js';

export interface ReducerConflictInput {
  readonly modules: readonly { path: string; boundary: BoundaryModule }[];
  readonly tsReducers: readonly RegisteredReducer[];
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
