/**
 * C3: Whole-boundary instantiation linker.
 *
 * Turns each `use:` entry into a concrete live BoundaryConfig by:
 *  1. Looking up the component by name in the compiled component catalog.
 *  2. Calling substituteParameters (C2) to apply parameter bindings.
 *  3. Constructing a BoundaryConfig with boundary = use.as and contractPath
 *     = use.contractPath, populated from the substituted component fields.
 *  4. Detecting collisions: a `use.as` name or `use.contractPath` that clashes
 *     with an existing boundary name or path (from file boundaries or a prior
 *     use: entry) throws BOOT_ERR_DSL_DUPLICATE_BOUNDARY.
 *
 * Multiple use: entries referencing the same component each produce a DISTINCT
 * concrete boundary — different `as`/`contractPath` is what makes them distinct.
 *
 * Reference rewriting (self via `as`, siblings via `bind`) is C5 (potemkin-b5k1).
 * Component-internal boundary references in reactions/dispatch are left as-authored.
 */

import { BootError } from '../errors.js';
import { substituteParameters } from './parameterSubstitution.js';
import type { BoundaryConfig, ComponentDefinition, UseEntry } from './types.js';

/**
 * Link use: entries into concrete BoundaryConfig objects and register them in
 * the provided byBoundaryName and byContractPath maps (mutating both in place).
 *
 * Must be called AFTER file boundaries are registered and BEFORE cross-reference
 * validation runs, so the merged byBoundaryName is the single source of truth
 * for validation.
 *
 * @param useEntries     All accumulated use: entries from use-mapping modules.
 * @param components     Parsed component catalog (may be empty).
 * @param byBoundaryName Mutable map of concrete boundary name → BoundaryConfig.
 * @param byContractPath Mutable map of contract path → BoundaryConfig.
 * @returns              The newly created concrete BoundaryConfig objects (in order).
 * @throws {BootError}   BOOT_ERR_DSL_REFERENCE for unknown component name.
 * @throws {BootError}   BOOT_ERR_DSL_SYNTAX for missing required parameter / type mismatch (from C2).
 * @throws {BootError}   BOOT_ERR_DSL_DUPLICATE_BOUNDARY for colliding concrete name or path.
 */
export function linkComponents(
  useEntries: readonly UseEntry[],
  components: Record<string, ComponentDefinition>,
  byBoundaryName: Record<string, BoundaryConfig>,
  byContractPath: Record<string, BoundaryConfig>,
): BoundaryConfig[] {
  const linked: BoundaryConfig[] = [];

  for (const entry of useEntries) {
    // 1. Resolve component from catalog.
    const component = components[entry.component];
    if (component === undefined) {
      throw new BootError(
        'BOOT_ERR_DSL_REFERENCE',
        `use: entry references unknown component "${entry.component}"`,
        { component: entry.component, as: entry.as },
      );
    }

    // 2. Substitute parameters (C2 handles missing required, type errors).
    const substituted = substituteParameters(component, entry.with ?? {});

    // 3. Collision guard: concrete name.
    if (Object.prototype.hasOwnProperty.call(byBoundaryName, entry.as)) {
      throw new BootError(
        'BOOT_ERR_DSL_DUPLICATE_BOUNDARY',
        `use: entry produces duplicate boundary name "${entry.as}" (already registered as a live boundary)`,
        { boundary: entry.as, component: entry.component },
      );
    }

    // 4. Collision guard: concrete contract_path.
    if (Object.prototype.hasOwnProperty.call(byContractPath, entry.contractPath)) {
      throw new BootError(
        'BOOT_ERR_DSL_DUPLICATE_BOUNDARY',
        `use: entry produces duplicate contract_path "${entry.contractPath}" for boundary "${entry.as}"`,
        { contractPath: entry.contractPath, boundary: entry.as, component: entry.component },
      );
    }

    // 5. Construct concrete BoundaryConfig.
    // The component carries optional DSL sections; absent sections become their
    // empty-array / undefined equivalents for a BoundaryConfig.
    // C5 (potemkin-b5k1) will rewrite self/sibling boundary references in
    // reactions and dispatch_commands; for now they are left as-authored.
    const concrete: BoundaryConfig = {
      boundary: entry.as,
      contractPath: entry.contractPath,
      fallbackOverride: false,
      behaviors: substituted.behaviors ?? [],
      reducers: substituted.reducers ?? [],
      eventCatalog: substituted.eventCatalog ?? [],
      ...(substituted.identity !== undefined ? { identity: substituted.identity } : {}),
      ...(substituted.state !== undefined ? { state: substituted.state } : {}),
      ...(substituted.reactions !== undefined && substituted.reactions.length > 0
        ? { reactions: substituted.reactions }
        : {}),
    };

    // 6. Register in both indexes.
    byBoundaryName[entry.as] = concrete;
    byContractPath[entry.contractPath] = concrete;
    linked.push(concrete);
  }

  return linked;
}
