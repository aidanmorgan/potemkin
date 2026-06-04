/**
 * C3: Whole-boundary instantiation linker.
 * C4: Fragment inclusion (include:) merge.
 * C5: Cross-component reference rewriting (self via `as`, siblings via `bind`).
 *
 * C3 — Turns each `use:` entry into a concrete live BoundaryConfig by:
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
 * C4 — mergeIncludes(): resolves include: on every file boundary (and every
 * use:-instantiated boundary) and merges included fragments into the host.
 * Merge precedence:
 *  - LOCAL wins: a host-declared event type / reducer on / behavior name
 *    overrides an identically-keyed included entry.
 *  - INCLUDED wins (when host has no local override): the included fragment's
 *    entry is appended.
 *  - CLASH between two INCLUDED fragments on the same event type or behavior
 *    name (with no host override) throws BOOT_ERR_DSL_SYNTAX. Reducer `on`
 *    is NOT a unique key — multiple included reducers with the same `on` are
 *    appended (all matching reducers run in the engine).
 *
 * Resolve include AFTER C3 linking so that component-carried include: on
 * use:-instantiated boundaries works (linkComponents propagates the component
 * include field into the concrete BoundaryConfig before mergeIncludes runs).
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
  EventCatalogEntry,
  ReactionRule,
  ReducerRule,
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
    // include: is propagated so that mergeIncludes (C4, which runs after C3) can
    // process component-carried fragment inclusions on the instantiated boundary.
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
      ...(rewritten.include !== undefined && rewritten.include.length > 0
        ? { include: rewritten.include }
        : {}),
    };

    // 7. Register in both indexes.
    byBoundaryName[entry.as] = concrete;
    byContractPath[entry.contractPath] = concrete;
    linked.push(concrete);
  }

  return linked;
}

// ---------------------------------------------------------------------------
// C4: mergeIncludes
// ---------------------------------------------------------------------------

/**
 * Merge a single included fragment (after substituteParameters) into the host
 * accumulator maps. Clash detection:
 *  - For event `type` and behavior `name` (unique keys): if `localKeys` already
 *    has the key, the included entry is silently skipped — local wins. A key in
 *    `includedKeys` from a prior include (not covered by `localKeys`) is a clash
 *    between two included fragments → boot error.
 *  - For reducer `on` (non-unique key): ALL included reducers are appended
 *    unconditionally — the engine runs every reducer whose `on` matches, so a
 *    local reducer and an included reducer on the same event both run. No
 *    local-wins skip and no clash error.
 */
function mergeFragment(
  fragmentEventCatalog: readonly EventCatalogEntry[] | undefined,
  fragmentReducers: readonly ReducerRule[] | undefined,
  fragmentBehaviors: readonly BehaviorRule[] | undefined,
  localEventTypes: ReadonlySet<string>,
  localBehaviorNames: ReadonlySet<string>,
  includedEventTypes: Map<string, string>,   // key → source component name
  includedReducerOns: Map<string, string>,   // tracked for informational purposes only (no clash error)
  includedBehaviorNames: Map<string, string>,
  accEventCatalog: EventCatalogEntry[],
  accReducers: ReducerRule[],
  accBehaviors: BehaviorRule[],
  sourceComponentName: string,
  hostBoundaryName: string,
): void {
  // Merge event catalog entries (type is a unique key — clash is a boot error).
  for (const entry of fragmentEventCatalog ?? []) {
    const key = entry.type;
    if (localEventTypes.has(key)) continue; // local wins
    if (includedEventTypes.has(key)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `boundary "${hostBoundaryName}": include: clash — event type "${key}" is contributed by both "${includedEventTypes.get(key)}" and "${sourceComponentName}" with no local override`,
        { boundary: hostBoundaryName, key, source1: includedEventTypes.get(key)!, source2: sourceComponentName },
      );
    }
    includedEventTypes.set(key, sourceComponentName);
    accEventCatalog.push(entry);
  }

  // Merge reducer rules (on is a NON-unique key — the engine runs ALL reducers
  // matching an event type, so coexistence is correct; append unconditionally.
  // Unlike event_catalog type and behavior name (which are unique keys), reducer
  // `on` has no local-wins semantics: a local reducer and an included reducer on
  // the same event are both valid and both run.
  for (const rule of fragmentReducers ?? []) {
    const key = rule.on;
    includedReducerOns.set(key, sourceComponentName);
    accReducers.push(rule);
  }

  // Merge behavior rules (name is a unique key — clash is a boot error).
  for (const behavior of fragmentBehaviors ?? []) {
    const key = behavior.name;
    if (localBehaviorNames.has(key)) continue;
    if (includedBehaviorNames.has(key)) {
      throw new BootError(
        'BOOT_ERR_DSL_SYNTAX',
        `boundary "${hostBoundaryName}": include: clash — behavior name "${key}" is contributed by both "${includedBehaviorNames.get(key)}" and "${sourceComponentName}" with no local override`,
        { boundary: hostBoundaryName, key, source1: includedBehaviorNames.get(key)!, source2: sourceComponentName },
      );
    }
    includedBehaviorNames.set(key, sourceComponentName);
    accBehaviors.push(behavior);
  }
}

/**
 * C4: Resolve all include: entries on the given boundaries and merge the
 * included component fragments into each host boundary.
 *
 * Called AFTER C3 linkComponents so that use:-instantiated boundaries (which
 * may themselves carry include: from their component definition, propagated by
 * linkComponents) are already present in `boundaries`.
 *
 * Precedence:
 *  - Event `type` and behavior `name` are unique keys: local declarations win
 *    over included ones; a clash between two included fragments on the same key
 *    (with no local override) is a BOOT_ERR_DSL_SYNTAX.
 *  - Reducer `on` is a non-unique key: ALL reducers (local and included) are
 *    kept — the engine runs every reducer whose `on` matches an event type, so
 *    a local reducer and an included reducer on the same event both run.
 *
 * The merged BoundaryConfig replaces the original in `byBoundaryName` and
 * the `boundaries` array (mutated in place). `byContractPath` is updated to
 * point at the new object as well.
 *
 * @param boundaries     All concrete BoundaryConfig objects (file + linked).
 * @param components     Parsed component catalog.
 * @param byBoundaryName Mutable boundary-name index (updated in place).
 * @param byContractPath Mutable contract-path index (updated in place).
 * @throws {BootError}   BOOT_ERR_DSL_REFERENCE for unknown included component.
 * @throws {BootError}   BOOT_ERR_DSL_SYNTAX for include: clash between two fragments.
 */
export function mergeIncludes(
  boundaries: BoundaryConfig[],
  components: Record<string, ComponentDefinition>,
  byBoundaryName: Record<string, BoundaryConfig>,
  byContractPath: Record<string, BoundaryConfig>,
): void {
  for (let i = 0; i < boundaries.length; i++) {
    const host = boundaries[i]!;
    if (!host.include || host.include.length === 0) continue;

    const hostName = host.boundary;

    // Pre-compute local key sets (the host's own declarations win unconditionally).
    const localEventTypes = new Set(host.eventCatalog.map((e) => e.type));
    const localBehaviorNames = new Set(host.behaviors.map((b) => b.name));

    // Accumulate included entries in order of the include: array.
    const accEventCatalog: EventCatalogEntry[] = [];
    const accReducers: ReducerRule[] = [];
    const accBehaviors: BehaviorRule[] = [];

    // identity + schema are single-valued: at most one source (the host or one
    // fragment) may declare each, else it is a clash. state is field-unioned:
    // computed/internal fields merge, clashing on a duplicate field name. The
    // host's own declarations seed the accumulators so host-vs-fragment clashes
    // are caught too.
    let mergedIdentity = host.identity;
    let identitySource = host.identity !== undefined ? hostName : undefined;
    let mergedSchema = host.schema;
    let schemaSource = host.schema !== undefined ? hostName : undefined;
    const accComputed = [...(host.state?.computed ?? [])];
    const accInternal = [...(host.state?.internal ?? [])];
    const stateFieldSource = new Map<string, string>();
    for (const f of accComputed) stateFieldSource.set(f.name, hostName);
    for (const f of accInternal) stateFieldSource.set(f.name, hostName);
    let stateChanged = false;

    // Track which included-fragment (by component name) claimed each key —
    // used for clash detection between two distinct fragments.
    const includedEventTypes = new Map<string, string>();
    const includedReducerOns = new Map<string, string>();
    const includedBehaviorNames = new Map<string, string>();

    for (const includeEntry of host.include) {
      const component = components[includeEntry.component];
      if (component === undefined) {
        throw new BootError(
          'BOOT_ERR_DSL_REFERENCE',
          `boundary "${hostName}": include: references unknown component "${includeEntry.component}"`,
          { boundary: hostName, component: includeEntry.component },
        );
      }

      // Reject unsupported sections in an included component: reactions and
      // nested include: cannot be merged via include: (no as/bind context for
      // reference rewriting, and semantic mismatches). identity, state and
      // schema ARE composable — they carry no cross-boundary references — and
      // are merged below (single-source for identity/schema, field-union for
      // state, all with clash detection). Make failures loud.
      if (component.reactions !== undefined && component.reactions.length > 0) {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `boundary "${hostName}": include: component "${component.name}" declares "reactions" — reactions are not supported under include: (use use: for components with reactions)`,
          { boundary: hostName, component: component.name, section: 'reactions' },
        );
      }
      if (component.include !== undefined && component.include.length > 0) {
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `boundary "${hostName}": include: component "${component.name}" declares its own "include:" — nested include is not supported under include:`,
          { boundary: hostName, component: component.name, section: 'include' },
        );
      }

      // Apply parameter substitution (C2) on the component before merging.
      const substituted = substituteParameters(component, includeEntry.with ?? {});

      // Reject behaviors whose dispatchCommands reference a boundary name that is
      // not a known concrete boundary. include: has no as/bind rewriting context,
      // so alias-looking names would be merged verbatim and silently mis-target.
      for (const behavior of substituted.behaviors ?? []) {
        for (const dc of behavior.dispatchCommands ?? []) {
          if (!Object.prototype.hasOwnProperty.call(byBoundaryName, dc.boundary)) {
            throw new BootError(
              'BOOT_ERR_DSL_SYNTAX',
              `boundary "${hostName}": include: component "${component.name}" behavior "${behavior.name}" dispatch_commands.boundary "${dc.boundary}" is not a known concrete boundary — included behaviors must use concrete boundary names (include: has no bind: rewriting context)`,
              { boundary: hostName, component: component.name, behavior: behavior.name, alias: dc.boundary },
            );
          }
        }
      }

      mergeFragment(
        substituted.eventCatalog,
        substituted.reducers,
        substituted.behaviors,
        localEventTypes,
        localBehaviorNames,
        includedEventTypes,
        includedReducerOns,
        includedBehaviorNames,
        accEventCatalog,
        accReducers,
        accBehaviors,
        component.name,
        hostName,
      );

      // Compose identity (single-source).
      if (substituted.identity !== undefined) {
        if (mergedIdentity !== undefined) {
          throw new BootError(
            'BOOT_ERR_DSL_SYNTAX',
            `boundary "${hostName}": include: component "${component.name}" declares "identity" but it is already declared by "${identitySource}" — identity may come from only one source`,
            { boundary: hostName, component: component.name, section: 'identity', existing: identitySource ?? null },
          );
        }
        mergedIdentity = substituted.identity;
        identitySource = component.name;
      }

      // Compose schema name (single-source).
      if (substituted.schema !== undefined) {
        if (mergedSchema !== undefined) {
          throw new BootError(
            'BOOT_ERR_DSL_SYNTAX',
            `boundary "${hostName}": include: component "${component.name}" declares "schema" but it is already declared by "${schemaSource}" — schema may come from only one source`,
            { boundary: hostName, component: component.name, section: 'schema', existing: schemaSource ?? null },
          );
        }
        mergedSchema = substituted.schema;
        schemaSource = component.name;
      }

      // Compose state (field-union; clash on a duplicate computed/internal field name).
      for (const f of substituted.state?.computed ?? []) {
        const prior = stateFieldSource.get(f.name);
        if (prior !== undefined) {
          throw new BootError(
            'BOOT_ERR_DSL_SYNTAX',
            `boundary "${hostName}": include: component "${component.name}" declares state field "${f.name}" but it is already declared by "${prior}" — state fields may come from only one source`,
            { boundary: hostName, component: component.name, field: f.name, existing: prior },
          );
        }
        stateFieldSource.set(f.name, component.name);
        accComputed.push(f);
        stateChanged = true;
      }
      for (const f of substituted.state?.internal ?? []) {
        const prior = stateFieldSource.get(f.name);
        if (prior !== undefined) {
          throw new BootError(
            'BOOT_ERR_DSL_SYNTAX',
            `boundary "${hostName}": include: component "${component.name}" declares state field "${f.name}" but it is already declared by "${prior}" — state fields may come from only one source`,
            { boundary: hostName, component: component.name, field: f.name, existing: prior },
          );
        }
        stateFieldSource.set(f.name, component.name);
        accInternal.push(f);
        stateChanged = true;
      }
    }

    const identityChanged = mergedIdentity !== host.identity;
    const schemaChanged = mergedSchema !== host.schema;

    // If no fragments contributed anything new, leave the boundary unchanged.
    if (
      accEventCatalog.length === 0 && accReducers.length === 0 && accBehaviors.length === 0 &&
      !identityChanged && !schemaChanged && !stateChanged
    ) {
      continue;
    }

    // Build the merged boundary: local entries first, included entries appended.
    const merged: BoundaryConfig = {
      ...host,
      eventCatalog: [...host.eventCatalog, ...accEventCatalog],
      reducers: [...host.reducers, ...accReducers],
      behaviors: [...host.behaviors, ...accBehaviors],
      ...(mergedIdentity !== undefined ? { identity: mergedIdentity } : {}),
      ...(mergedSchema !== undefined ? { schema: mergedSchema } : {}),
      ...(stateChanged ? { state: { computed: accComputed, internal: accInternal } } : {}),
    };

    // Update the mutable arrays and indexes in place.
    boundaries[i] = merged;
    byBoundaryName[hostName] = merged;
    byContractPath[host.contractPath] = merged;
  }
}
