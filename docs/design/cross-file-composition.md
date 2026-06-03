# Design spec: cross-file boundary composition

Status: C1–C8 shipped; C9 (regression/migration) in progress.
Related: [`multi-boundary-reactions.md`](multi-boundary-reactions.md) (reactions are one of the
reference kinds the linker rewrites).

## Problem

Today every globbed file with a `boundary:` key becomes a live boundary, and boundary names must be
globally unique (`src/dsl/parser.ts:74`); the loader partitions files into live boundaries vs global
modules (`src/dsl/configLoader.ts`). You cannot author a boundary as a reusable definition, reuse one
definition more than once, reference a boundary defined elsewhere, share event/reducer/behaviour
fragments, or parameterise a definition. This blocks compositional assembly of a larger API under
test from reusable building blocks.

## Goal

Let a developer define an entity (events, reducers, behaviours) once in a component file and map it
into a simulation from a different file, any number of times, with named parameters. Backward
compatible: existing boundary files (those with `contract_path`) stay live by default.

Design decisions (confirmed): inert components activated by an explicit `use:`; both whole-boundary
instantiation and fragment/mixin inclusion; named parameters with types/defaults; beads interleaved
with the reactions epic by true dependency.

## Model

A **linker pass** runs between file loading and the existing compile/boot validation and emits the
same flat `CompiledDsl` the engine consumes. The runtime is unchanged.

### Components (inert definitions)

A file with `kind: component` is loaded into a catalog and is **not** a live boundary. It declares
some subset of `event_catalog` / `reducers` / `behaviors` / `identity` / `state` / `reactions`, an
optional `parameters:` block, and an optional set of local boundary aliases it references.

```yaml
kind: component
name: DocumentEntity
parameters:
  initialStatus:
    type: string
    required: true
  statusField:
    type: string
    default: "status"
event_catalog:
  - type: DocumentArchived
    payload_template:
      archivedAt: "$now()"
reducers:
  - on: DocumentArchived
    patches:
      - op: replace
        path: "/{{statusField}}"          # parameter substitution (link-time)
        value: "${'ARCHIVED'}"            # CEL, untouched by the linker
```

### Whole-boundary instantiation (`use:`)

A simulation/mapping file activates a component as one or more concrete boundaries:

```yaml
use:
  - component: DocumentEntity
    as: Document
    contract_path: /documents
    with:
      initialStatus: "DRAFT"
  - component: DocumentEntity
    as: ArchivedDocument
    contract_path: /archived-documents
    with:
      initialStatus: "ARCHIVED"
    bind: {}                              # map component-local sibling refs -> concrete names
```

Each `use` produces a distinct concrete `BoundaryConfig` (name = `as`, the bound `contract_path`,
parameters substituted). Reuse is just multiple `use` entries — distinct concrete names sidestep the
duplicate-name rejection, which now applies only to concrete (post-link) names.

### Fragment inclusion (`include:`)

The same component artifact, consumed at sub-boundary granularity. A live boundary merges a
component's `event_catalog` / `reducers` / `behaviors` into its own:

```yaml
boundary: Document
contract_path: /documents
include:
  - component: AuditMixin
    with:
      actorField: "modifiedBy"
event_catalog:
  # ...local entries...
reducers:
  # ...local entries...
```

Merge precedence: local declarations win on a key clash; a clash between two included fragments on
the same event type or reducer `on` is a boot error unless one explicitly overrides.

### Parameters

`parameters:` declares each variable with `type` (string | number | boolean), optional `default`,
and optional `required: true`. At link time the engine substitutes `{{name}}` tokens found in string
leaves (values and keys such as JSON-Pointer paths and boundary names) of the component, after
parsing and before CEL compilation, with type checking against the declared parameter. `{{ }}` is
distinct from CEL `${ }`, so the two never collide.

### Cross-component reference rewriting

A component that contains `dispatch_commands`, `reactions` (`on: <Boundary>:<Event>`), `sagas`, or
derived-projection `subscribe` entries refers to boundary names that are concrete only after
instantiation. The linker rewrites those references:

- **Self** references (the component's own boundary) rewrite via `as`.
- **Sibling** references use component-local alias names bound at instantiation through
  `bind: { LocalAlias: ConcreteName }`. The linker rewrites the `boundary` field of dispatch
  commands, the `<Boundary>` part of reaction `on:` and reaction `boundary:`, saga `trigger`/`steps`
  boundaries, and derived `subscribe` prefixes.

This is the load-bearing tie to reactions: a reused component's two instances wire their reactions to
different concrete targets purely through `as` + `bind`.

## Validation (three phases)

1. **Definition validation (per file, partial).** Classify each file as live boundary, component, or
   global module. Validate shape and intra-component references (a component `emit` resolves to its
   own catalog; a reducer `on` resolves to its own event; `parameters:` well-formed). Defer all
   binding-dependent checks (`contract_path`↔OpenAPI, object-graph schema, cross-component refs). A
   component without `contract_path` is valid here.
2. **Linking.** Resolve `use:`/`include:`, type-check and substitute parameters, rewrite self/sibling
   references, merge fragments, and emit concrete boundaries. Detect unknown component refs, missing
   required parameters, unbound sibling references, and concrete name/path collisions.
3. **Post-composition validation (today's boot checks on the linked model).** Cross-reference,
   contract-binding, object-graph schema registry, and reaction-reference validation run on the flat
   linked model — most of the existing boot validation, moved behind the linker.

## Runtime

Unchanged. The linker feeds `compileDsl` / boot exactly the `byBoundaryName` structure they already
expect. The duplicate-name guard moves to operate on concrete names.

## Interaction with the reactions epic

- **R2** (reaction registry + cross-reference validation) validates against the compiled
  (post-composition) `byBoundaryName` and must not assume references are file-local; it runs in
  Phase 3. Re-scoped accordingly.
- **C5** (reference rewriting) covers reactions, dispatch_commands, sagas, and derived subscriptions
  together; it depends on the reaction grammar (R1) and on instantiation (C3).
- A combined e2e (C8) shows one component instantiated twice whose instances react to each other,
  exercising both features.

## Delivery increments

- **C1** — File-kind classification + component / `use:` / `include:` / `parameters` grammar + types + Phase-1 validation (no linking; a component file produces no live boundary).
- **C2** — Parameter substitution engine + type validation (`{{name}}` over string leaves, defaults, required, type errors).
- **C3** — Whole-boundary instantiation linker (`use:` -> concrete boundaries; multiple uses; collision detection); duplicate-name guard moves to concrete names.
- **C4** — Fragment inclusion (`include:`) merge with precedence/collision rules.
- **C5** — Cross-component reference rewriting (self via `as`, siblings via `bind:`) for reactions / dispatch_commands / sagas / derived subscriptions.
- **C6** — Validation reorg: existing cross-ref / contract / object-graph / reaction-ref checks run on the linked model; Phase-1 partial validation for components.
- **C7** — Documentation: this spec finalized, `docs/dsl.md` composition section, README cookbook recipes.
- **C8** — Engine-only e2e: a component defined once and instantiated multiple times from another file (distinct paths/params), a fragment mixin reused across boundaries, and reactions across the instances.
- **C9** — Regression/migration: existing fixtures unaffected; loader partitioning recognises the new file kinds.
