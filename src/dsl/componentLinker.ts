/**
 * C3: Whole-boundary instantiation linker.
 * C5: Cross-component reference rewriting (self via `as`, siblings via `bind`).
 *
 * Turns each `use:` entry into a concrete live BoundaryConfig by:
 *  1. Looking up the component by name in the compiled component catalog.
 *  2. Calling substituteParameters (C2) to apply parameter bindings.
 *  3. Rewriting boundary references (C5): self → as, siblings → bind map.
 *  4. Constructing a BoundaryConfig with boundary = use.as and contractPath
 *     = use.contractPath, populated from the substituted component fields.
 *  5. Detecting collisions: a `use.as` name or `use.contractPath` that clashes
 *     with an existing boundary name or path (from file boundaries or a prior
 *     use: entry) throws BOOT_ERR_DSL_DUPLICATE_BOUNDARY.
 *
 * Multiple use: entries referencing the same component each produce a DISTINCT
 * concrete boundary — different `as`/`contractPath` is what makes them distinct.
 *
 * C5 rewriting rules (applied after C2 parameter substitution):
 *  - SELF: a boundary name equal to the component's own `name` rewrites to `use.as`.
 *  - SIBLING: any other boundary name that appears as a key in `use.bind` rewrites
 *    to the corresponding concrete name from the bind map.
 *  - UNBOUND: any other boundary name that is neither SELF nor a bind key throws
 *    BOOT_ERR_DSL_REFERENCE naming the alias and the use entry.
 *
 * Reference positions rewritten:
 *  - reactions[].boundary       (the reacting boundary — SELF)
 *  - reactions[].on             (the "<Boundary>:" prefix of qualified triggers)
 *  - behaviors[].dispatchCommands[].boundary  (secondary command target)
 */

import { BootError } from '../errors.js';
import { substituteParameters } from './parameterSubstitution.js';
import type {
  BehaviorRule,
  BoundaryConfig,
  ComponentDefinition,
  ReactionRule,
  SecondaryCommandSpec,
  UseEntry,
} from './types.js';

// ---------------------------------------------------------------------------
// C5: boundary reference resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a component-internal boundary alias to its concrete name.
 *
 * - If `alias` equals the component's `name`, it is a SELF reference → `concreteAs`.
 * - If `alias` appears in `bind`, it is a SIBLING reference → `bind[alias]`.
 * - Otherwise it is UNBOUND → throw BOOT_ERR_DSL_REFERENCE.
 */
function resolveAlias(
  alias: string,
  componentName: string,
  concreteAs: string,
  bind: Record<string, string>,
  entry: UseEntry,
): string {
  if (alias === componentName) {
    return concreteAs;
  }
  if (Object.prototype.hasOwnProperty.call(bind, alias)) {
    return bind[alias]!;
  }
  throw new BootError(
    'BOOT_ERR_DSL_REFERENCE',
    `use: entry "${entry.as}" (component "${entry.component}"): boundary alias "${alias}" is not the component self-name and is not mapped in bind — add it to bind: { ${alias}: <ConcreteName> }`,
    { alias, component: entry.component, as: entry.as },
  );
}

/**
 * Rewrite boundary references in a single ReactionRule.
 *
 * Positions:
 *  - `boundary`: the reacting boundary — typically the component itself.
 *  - `on`: qualified trigger in the form "<Boundary>:<EventType>" — rewrite the
 *    prefix only; bare "<EventType>" triggers (no colon) are left unchanged.
 */
function rewriteReaction(
  reaction: ReactionRule,
  componentName: string,
  concreteAs: string,
  bind: Record<string, string>,
  entry: UseEntry,
): ReactionRule {
  // Rewrite `boundary` (always present after C3/R1 fills it in for boundary-file
  // reactions; may be undefined for global reactions, but components use boundary-file
  // style so it defaults to the component name via the schema parser).
  const rawBoundary = reaction.boundary;
  const newBoundary = rawBoundary !== undefined
    ? resolveAlias(rawBoundary, componentName, concreteAs, bind, entry)
    : undefined;

  // Rewrite the "<Boundary>:" prefix of a qualified "on" trigger.
  const colonIdx = reaction.on.indexOf(':');
  let newOn = reaction.on;
  if (colonIdx !== -1) {
    const onBoundary = reaction.on.slice(0, colonIdx);
    const eventType = reaction.on.slice(colonIdx + 1);
    const resolvedOnBoundary = resolveAlias(onBoundary, componentName, concreteAs, bind, entry);
    newOn = `${resolvedOnBoundary}:${eventType}`;
  }

  if (newBoundary === rawBoundary && newOn === reaction.on) {
    return reaction;
  }

  return {
    ...reaction,
    ...(newBoundary !== undefined ? { boundary: newBoundary } : {}),
    on: newOn,
  };
}

/**
 * Rewrite boundary references in a single SecondaryCommandSpec.
 * Only `boundary` is a reference position.
 */
function rewriteSecondaryCommand(
  spec: SecondaryCommandSpec,
  componentName: string,
  concreteAs: string,
  bind: Record<string, string>,
  entry: UseEntry,
): SecondaryCommandSpec {
  const newBoundary = resolveAlias(spec.boundary, componentName, concreteAs, bind, entry);
  if (newBoundary === spec.boundary) {
    return spec;
  }
  return { ...spec, boundary: newBoundary };
}

/**
 * Rewrite all boundary references in a BehaviorRule's dispatchCommands.
 * Returns the same object reference if nothing changed.
 */
function rewriteBehavior(
  behavior: BehaviorRule,
  componentName: string,
  concreteAs: string,
  bind: Record<string, string>,
  entry: UseEntry,
): BehaviorRule {
  if (!behavior.dispatchCommands || behavior.dispatchCommands.length === 0) {
    return behavior;
  }

  let changed = false;
  const rewritten = behavior.dispatchCommands.map((dc) => {
    const next = rewriteSecondaryCommand(dc, componentName, concreteAs, bind, entry);
    if (next !== dc) changed = true;
    return next;
  });

  if (!changed) return behavior;
  return { ...behavior, dispatchCommands: rewritten };
}

/**
 * C5: Rewrite all component-internal boundary references in `substituted` to
 * concrete names using the self (`as`) and sibling (`bind`) maps.
 *
 * Returns a copy of `substituted` with reactions and behaviors rewritten.
 * Fields that require no rewriting (eventCatalog, reducers, identity, state)
 * are left untouched.
 */
function rewriteBoundaryRefs(
  substituted: ComponentDefinition,
  entry: UseEntry,
): ComponentDefinition {
  const bind = entry.bind ?? {};
  const componentName = substituted.name;
  const concreteAs = entry.as;

  // A bind alias must not shadow the component's own name: self always rewrites
  // to `as`, so such a bind entry would be silently ignored. Reject it so the
  // ambiguity surfaces at boot rather than producing surprising wiring.
  if (Object.prototype.hasOwnProperty.call(bind, componentName)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `use: entry "${entry.as}" (component "${entry.component}"): bind alias "${componentName}" shadows the component's own name — the self reference always rewrites to "as", so remove this bind entry`,
      { alias: componentName, component: entry.component, as: entry.as },
    );
  }

  // Rewrite reactions.
  let reactions = substituted.reactions;
  if (reactions && reactions.length > 0) {
    let changed = false;
    const rewritten = reactions.map((r) => {
      const next = rewriteReaction(r, componentName, concreteAs, bind, entry);
      if (next !== r) changed = true;
      return next;
    });
    if (changed) reactions = rewritten;
  }

  // Rewrite behaviors (their dispatchCommands.boundary positions).
  let behaviors = substituted.behaviors;
  if (behaviors && behaviors.length > 0) {
    let changed = false;
    const rewritten = behaviors.map((b) => {
      const next = rewriteBehavior(b, componentName, concreteAs, bind, entry);
      if (next !== b) changed = true;
      return next;
    });
    if (changed) behaviors = rewritten;
  }

  if (reactions === substituted.reactions && behaviors === substituted.behaviors) {
    return substituted;
  }

  return {
    ...substituted,
    ...(reactions !== substituted.reactions ? { reactions } : {}),
    ...(behaviors !== substituted.behaviors ? { behaviors } : {}),
  };
}

// ---------------------------------------------------------------------------
// C3: linkComponents
// ---------------------------------------------------------------------------

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
 * @throws {BootError}   BOOT_ERR_DSL_REFERENCE for unknown component name or unbound sibling alias.
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

    // 3. C5: Rewrite component-internal boundary references (self → as, siblings → bind).
    const rewritten = rewriteBoundaryRefs(substituted, entry);

    // 4. Collision guard: concrete name.
    if (Object.prototype.hasOwnProperty.call(byBoundaryName, entry.as)) {
      throw new BootError(
        'BOOT_ERR_DSL_DUPLICATE_BOUNDARY',
        `use: entry produces duplicate boundary name "${entry.as}" (already registered as a live boundary)`,
        { boundary: entry.as, component: entry.component },
      );
    }

    // 5. Collision guard: concrete contract_path.
    if (Object.prototype.hasOwnProperty.call(byContractPath, entry.contractPath)) {
      throw new BootError(
        'BOOT_ERR_DSL_DUPLICATE_BOUNDARY',
        `use: entry produces duplicate contract_path "${entry.contractPath}" for boundary "${entry.as}"`,
        { contractPath: entry.contractPath, boundary: entry.as, component: entry.component },
      );
    }

    // 6. Construct concrete BoundaryConfig.
    // The component carries optional DSL sections; absent sections become their
    // empty-array / undefined equivalents for a BoundaryConfig.
    const concrete: BoundaryConfig = {
      boundary: entry.as,
      contractPath: entry.contractPath,
      fallbackOverride: false,
      behaviors: rewritten.behaviors ?? [],
      reducers: rewritten.reducers ?? [],
      eventCatalog: rewritten.eventCatalog ?? [],
      ...(rewritten.identity !== undefined ? { identity: rewritten.identity } : {}),
      ...(rewritten.state !== undefined ? { state: rewritten.state } : {}),
      ...(rewritten.reactions !== undefined && rewritten.reactions.length > 0
        ? { reactions: rewritten.reactions }
        : {}),
    };

    // 7. Register in both indexes.
    byBoundaryName[entry.as] = concrete;
    byContractPath[entry.contractPath] = concrete;
    linked.push(concrete);
  }

  return linked;
}
