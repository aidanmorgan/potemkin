# Design spec: multi-boundary atomic reactions (choreography)

Status: R1–R5, R7 shipped; R6 (documentation) and R8 (regression sweep) complete.

## Problem

One inbound operation often needs to mutate several object graphs (boundaries) at once.
Potemkin can already do this with `dispatch_commands` (synchronous, in-UoW, atomic) and `sagas`
(post-commit, eventual), but both are **orchestration**: the source behaviour must enumerate every
target inline, each target needs its own OpenAPI operation + behaviour + event + reducer, and the
cascade is capped at depth 5 (`src/engine/uow.ts:434`). The result is high authoring friction,
tight source→target coupling, and a hard upper bound on fan-out chains.

## Goal

A declarative, **choreography**-style mechanism — `reactions:` — where a boundary subscribes to
another boundary's committed-to-shadow events and reacts by emitting its own event, **inside the
same Unit of Work** (atomic), with **no source coupling**, **no per-target operation/behaviour
scaffolding**, and **no fixed depth cap** (termination guaranteed by cycle dedup + an event budget).

This is the write-side analogue of `derived_projections` (which subscribe to multi-boundary events
but only build a read model). Reactions reuse the same `subscribe`/`on` matcher, wired into the
UoW's staged-event loop instead of the post-commit projection loop.

## Grammar

A `reactions:` array may appear in a boundary file (reacting boundary) or in the global config.
Each entry:

```yaml
reactions:
  - name: record-conversion-on-campaign   # optional, for trace logs
    on: "Lead:LeadConverted"              # "<Boundary>:<EventType>" or bare "<EventType>"
    when: "event.payload.campaignId != null"   # optional CEL gate (default: true)
    boundary: Campaign                    # reacting boundary; defaults to the file's boundary
    emit: CampaignConversionRecorded      # event type in the reacting boundary's event_catalog
    intent: mutation                      # mutation (default) | creation
    target: "event.payload.campaignId"    # CEL -> aggregate id to mutate/create
    payload:                              # optional CEL overrides merged over the event template
      leadId: "${event.aggregateId}"
```

| Field | Required | Meaning |
|---|---|---|
| `on` | yes | Trigger subscription: `Boundary:EventType` or bare `EventType` (any boundary). |
| `emit` | yes | Event type to emit, resolved against the reacting boundary's `event_catalog`. |
| `target` | yes (mutation) | CEL resolving to the aggregate id the emitted event applies to. For `creation`, may generate via the reacting boundary's `identity.creation.generate` when omitted. |
| `boundary` | no | Reacting boundary; defaults to the boundary of the file the reaction is declared in (required when declared in the global file). |
| `when` | no | CEL gate; the reaction fires only when true. |
| `intent` | no | `mutation` (default) or `creation`. |
| `payload` | no | CEL map merged over the emitted event's `payload_template`. |

The reaction does **not** reference an `operationId` and requires **no behaviour** on the reacting
boundary — only the event in its `event_catalog` and a reducer for it (the irreducible ES minimum).

## Semantics

1. **Trigger.** During the UoW loop (`src/engine/uow.ts:429-526`), after each event is staged and
   projected to the shadow graph, the reaction registry is consulted for entries whose `on` matches
   `<boundary>:<eventType>` (and bare `<eventType>`).
2. **Gate.** `when` is evaluated against the trigger context; false skips the reaction.
3. **Hydrate.** `target`/`payload` are evaluated; the emitted event type's `payload_template` (from
   the reacting boundary) is hydrated and the reaction's `payload` overrides are merged on top.
4. **Stage + project.** The emitted event is appended to the same `stagedEvents` list and projected
   into the same shadow graph via the reacting boundary's reducers. Its own staging can trigger
   further reactions (recursive fan-out), processed by the same queue.
5. **Commit.** All events — primary, dispatched, and reaction-emitted — are appended in the single
   `eventStore.append(stagedEvents)` and `shadow.commitInto(graph)` (`uow.ts:547-552`). The response
   reflects every mutated graph. Any reaction error aborts the entire UoW (atomic, all-or-nothing).

## Termination (replaces the depth cap for reactions)

Reactions are **not** bounded by `MAX_UOW_DEPTH`. Instead the UoW maintains:

- a `firedReactions: Set<reactionId + '@' + targetAggregateId>` — a given reaction fires at most once
  per target aggregate within a UoW (idempotent fan-out; breaks cycles); and
- a per-UoW **event budget** (`max_uow_events`, default e.g. 1000) as a backstop; exceeding it throws
  a deterministic `ReactionBudgetExceededError` (HTTP 508) with the offending reaction named.

This yields genuinely unbounded breadth and depth across distinct aggregates while guaranteeing the
UoW halts. `dispatch_commands` retain their existing depth model unchanged.

## CEL context and phase

`when` / `target` / `payload` evaluate against `{ event, payload }` where `event` is the trigger
domain event (`type`, `aggregateId`, `payload`, `sequenceVersion`, `boundary`) and `payload` aliases
`event.payload`. The emitted event's `payload_template` hydrates in the EventHydration phase
(`$uuidv7()`/`$now()` permitted there). Reducers for the emitted event keep the reducer-phase ban
(determinism preserved). Reaction firing is deterministic for replay (see ordering).

## Determinism / ordering

- Trigger events are processed in staging (FIFO) order.
- For a single trigger event, matching reactions fire in a stable order: reacting boundary name
  ascending, then declaration index. This must be deterministic so event-log replay reproduces state.
- Reactions fire from primary and dispatched events within the UoW. Saga-step events (separate
  post-commit UoWs) trigger reactions within their own UoW.

## Coexistence

- Cross-file composition ([`cross-file-composition.md`](cross-file-composition.md)) treats `reactions`
  as one of the reference kinds its linker rewrites: a reaction declared inside a reusable component
  has its `on:`/`boundary:` names rewritten to the concrete instantiated names (self via `as`,
  siblings via `bind:`). R2 therefore validates reaction references against the compiled
  post-composition model, not a file-local one.
- `derived_projections` stay read-only/post-commit; `reactions` are the in-UoW write-side analogue.
- `dispatch_commands` (explicit orchestration) and `sagas` (eventual, compensating) are unchanged.
- `reactions` become the natural default for "this operation should also update these other graphs"
  without the source knowing about them.

## Delivery increments

Each is a separately shippable bead; every increment keeps the build green and updates tests + docs.

- **R1** — DSL grammar, `ReactionRule` types, boot schema validation (no runtime).
- **R2** — Reaction registry/index at boot + cross-reference validation (trigger/emit event existence, CEL compiled at boot).
- **R3** — In-UoW reaction firing engine (hydrate + stage + project, atomic commit).
- **R4** — Termination model: fired-set dedup + event budget; reactions exempt from the depth-5 cap.
- **R5** — Reaction CEL context/phase + deterministic ordering.
- **R6** — Documentation: this spec finalized, `docs/dsl.md` section, README cookbook recipe.
- **R7** — Engine-only e2e example: one operation fans out to ≥3 boundaries with zero source edits, incl. a chain deeper than 5.
- **R8** — Regression sweep: update existing depth/loop tests; whole suite green.
