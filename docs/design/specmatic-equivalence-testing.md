# Design spec: contract-backed behavioural equivalence for Potemkin

> Scope decision: Potemkin's Stripe tests do not call Stripe's network APIs.
> The vendored Stripe OpenAPI document and the local Specmatic JVM are the
> contract oracle, while the generated behavior runs in Potemkin. The
> real-provider/Stripe-test-mode material below is retained as an unimplemented
> future research direction only and is not part of the repository's test or
> acceptance path.

The implemented equivalence path is entirely local: model-driven traces may
compare two Potemkin runtimes, and contract-backed scenarios drive Potemkin
through Specmatic. References to a “real API” in the research material below
mean an optional future external system under study; they are not instructions
for the current test suite and must not introduce provider credentials, network
calls, or provider event feeds.

Status: design complete (2026-06-06) — grounded in a literature sweep across five bodies of theory
(ioco/uioco conformance, the linear/branching-time spectrum + nominal/register automata, active
automata learning, stateful model-based testing, the oracle problem; full citations at end). No
production code changed yet.

**Headline result of the literature review.** The framing — _Potemkin's DSL is the executable
behavioural contract (the oracle); the real API is the system under test; we check conformance, not
equality_ — is correct and is a recognised, sound methodology. But the literature sharpens it in three
ways and corrects one mistake:

1. **The target relation is a _one-directional_ conformance/refinement preorder, not bisimulation.**
   The right relation is **uioco** (Tretmans' input-output conformance, the underspecification-tolerant
   variant) — equivalently **alternating refinement** (Alur–Henzinger–Kupferman–Vardi; the
   correspondence is Janssen–Vaandrager–Tretmans, IFM 2019). Bisimulation is _too strong_: it forbids
   the real API from having extra internal states, which is not what conformance needs. Earlier drafts
   of this doc called the target "bisimulation"; that was wrong as the _certification_ target (it
   remains the right vocabulary only for the id-renaming sub-relation, below).
2. **Data/identifiers demand the symbolic + nominal layer.** Plain ioco compares concrete output
   labels and would flag every fresh id as a failure. The sound treatment is **symbolic ioco (sioco)
   over Symbolic Transition Systems** (Frantzen–Tretmans–Willemse; tool: TorXakis) for the data/guards,
   plus a **nominal / fresh-register** comparison **up to a single coherent identifier bijection tracked
   along the whole trace** (Tzevelekos' fresh-register automata; Gabbay–Pitts nominal sets;
   Khurshid–Marinov's TestEra "modulo isomorphism"). Per-response "match up to some renaming" is
   **unsound** — it accepts a system that permutes ids inconsistently.
3. **The "mathematical static layer" is better realised as W/Wp conformance suites generated _from
   Potemkin_ than as "learn the real API then compare."** Because we already hold a model, the standard
   cheaper route to bounded-completeness coverage is the **W-method / Wp-method** (Chow 1978; Fujiwara
   et al. 1991) generated from Potemkin. Active automata learning (L\*/register-automata learning) is
   **demoted to an optional discovery layer** — it exists in the literature precisely for the case where
   _no_ model is available, which is not ours.
   Related: [`specmatic-sv-integration.md`](specmatic-sv-integration.md) (master),
   [`specmatic-conformance-gate.md`](specmatic-conformance-gate.md) (the contract baseline this builds on),
   [`specmatic-export-examples.md`](specmatic-export-examples.md) (seed/regression corpus).

## Problem

We want to prove that Potemkin's stateful simulation of an API **behaves like the real API**, not
merely that it satisfies the contract. The conformance gate
([`specmatic-conformance-gate.md`](specmatic-conformance-gate.md)) only proves each side _individually_
obeys the contract's shapes and statuses — necessary but not sufficient. Two contract-correct
implementations can still behave differently (different default values, different state transitions,
different error wording, different reconciliation).

The naïve "run the same requests against both and diff" fails for three reasons, all of which the user
correctly identified:

1. The real API and Potemkin hold **different internal state**; we cannot assume a shared starting
   point.
2. Each side **mints its own identifiers and timestamps** (`cus_REAL123` vs `cus_POT456`), so literal
   response comparison is always unequal.
3. We want **behavioural equivalence, not exact equality** — agreement on what a consumer can observe
   and depend on, not byte-identity.

## Goal

Establish that **the real API conforms to Potemkin's behavioural contract** — i.e. that an external
client interacting only through the API never observes the real API doing something the contract
forbids — checked over generated operation _sequences_, **up to** a defined relation (a coherent
identifier bijection + volatile-field normalisation + behavioural projection). This is the **uioco /
alternating-refinement** preorder, not full equality and not bisimulation. Discover where the real API
diverges from the contract, shrink each divergence to a minimal reproducer, and either converge
Potemkin to match (when Potemkin's model is the thing that's wrong) or record the difference as a
justified, cited exception (when the real API legitimately differs).

## Two complementary layers

Equivalence is attacked from two directions, and they reinforce each other:

- **Layer 1 — empirical / differential** (sections below): _run_ generated operation sequences against
  both systems and compare observable responses. Samples the behaviour space; finds divergences by
  example; needs the real API to be invoked.
- **Layer 2 — static / mathematical** (the "model-by-analysis" section): _extract a finite-state model_
  from Potemkin's configuration and reason about its _structure_ — both standalone (reachability,
  dead states, totality) and, where a model of the real API exists, by computing a
  **simulation/refinement** relation. Reasons about the whole (abstracted) transition structure and the
  _sequence_ of calls, not individual request/response pairs.

Layer 2 answers "is Potemkin's contract structure self-consistent and _capable_ of expressing these
behaviours?"; Layer 1 answers "and does the real API actually conform to it, values and all?"

### Do we need both layers? No — Layer 1 is the answer; Layer 2 is a cheap config-check plus an optional discovery tool

The sharpest framing of the goal is **"validate that the real API behaves the way the (behavioural)
contract defines."** Read that way, **Potemkin's DSL _is_ the executable behavioural contract — the
model / oracle** — and the real API is the system under test. That is exactly **model-based conformance
testing**, whose established correctness relation is **uioco** (the underspecification-tolerant
input-output conformance of Tretmans; **sioco** once data is involved): after every sequence the
contract allows, the real API may only produce outputs (and quiescence) the contract permits — checked
up to a coherent id-bijection and the volatile-field abstraction.

For that goal, **Layer 1 alone is the strongest _practical_ mechanism and is sufficient.** The five
literatures agree the model-as-oracle conformance pattern is sound and recognised (Quviq QuickCheck /
"Mysteries of Dropbox" is the canonical real-service analogue; Tretmans gives the soundness theory).

Layer 2 splits into a part worth doing _now_ and a part that is _optional_:

- **MODEL1+MODEL2 — config-only structural checks** (reachability / dead-state / (state,operation)
  totality / contract-state coverage on Potemkin's _own_ extracted model): cheap, need **no real API**,
  complement the boot-lint subsystem, and catch "Potemkin's contract can't even _express_ this
  transition" before any real-API run. **Worth doing regardless.**
- **W/Wp-method test generation from Potemkin (the principled way to get coverage-up-to-a-bound)** lives
  in Layer 1, _not_ in a learning layer. Because we already hold the model, the standard cheaper route
  to a whole-state-space coverage claim (complete for implementations with ≤ _m_ extra states) is to
  generate a **W-method / Wp-method** conformance suite _from Potemkin_ (Chow 1978; Fujiwara et al. 1991) and run it against the real API — no second model required. This is folded into the EQ
  generator, not a separate epic.
- **MODEL3+MODEL4 — model-to-model comparison and active learning of the real API — are OPTIONAL.** The
  entire "learn-then-compare" literature (black-box checking, model learning) exists _because no model
  is available_; we have one, so learning the real API is largely redundant for certification. It earns
  its place only as an **occasional discovery / drift-detection tool** (à la TLS protocol-state fuzzing,
  which found unscripted "extra" states), and only when the identifier domain is **equality/freshness-
  only** (the sound, decidable fragment for register-automata learning). Outside that fragment it adds
  cost and a new unsoundness surface (the abstraction mapper) for a guarantee we can already get more
  cheaply from W/Wp. **Recommendation: ship Layer 1 (with W/Wp) + MODEL1/MODEL2; treat MODEL3/MODEL4 as
  optional, justified only by a specific need to hunt for behaviours the contract doesn't model.**

## The technique (established, not invented here)

This is **stateful model-based / property-based testing** with the model as oracle, checked under the
**uioco / sioco** conformance relation (Tretmans; symbolic variant for data) **up to a tracked
identifier bijection**. The same operational pattern is used by Quviq QuickCheck state machines,
Hypothesis `RuleBasedStateMachine`, `quickcheck-state-machine`, PropEr, ScalaCheck Commands, and
fast-check; the formal conformance backbone is ioco/uioco and its symbolic/nominal extensions
(references at end). The load-bearing ideas:

- **Generate sequences, don't author scenarios.** A test is a _generated_ sequence of operations
  (create, read, transition, delete), not a hand-written script. The space is explored, not enumerated.
  For a coverage _guarantee_ (complete up to _m_ extra states), generate the sequences by the
  **W/Wp-method** from Potemkin's state machine.
- **Symbolic references solve the fresh-id problem.** A later step refers to an earlier result
  _symbolically_ — "the customer created in step 1" — never by a literal id. Each system instantiates
  that symbol with _its own_ concrete id at run time (Hypothesis calls this a `Bundle`; PropEr uses
  `{var,N}`; quickcheck-state-machine calls it "turning symbolic references into concrete references").
  So one abstract sequence yields _different_ concrete requests on each side, each threading its own ids.
- **Conform under a _single coherent_ identifier bijection — not per-response renaming.** The relation
  is one-directional (uioco / **alternating refinement**): the real API's observable outputs after a
  contract-legal trace must be permitted by the contract, compared **modulo one bijection σ between
  real-side and model-side identifiers, maintained across the whole trace**, with freshly-minted ids
  matched by _allocation/freshness, not value_. This is the nominal / fresh-register-automata notion of
  "up to renaming" (Tzevelekos; TestEra's "modulo isomorphism"). Matching each response under _some_
  independent renaming is **unsound** — it would accept a real API that permutes identities
  inconsistently between calls. **Target relation is _not_ bisimulation** (that would wrongly forbid the
  real API from having extra internal states the contract doesn't model).
- **Model the real API's _rejections as outputs_, to satisfy ioco's input-enabledness assumption.** A
  real REST API is not input-enabled — it returns 4xx and refuses out-of-state requests. ioco assumes
  the implementation accepts every input, so a `requires`-guard failure must be modelled as a _defined
  error output_ (a 4xx with a contract error `code`), never as a blocked/absent transition. This is why
  proposal #4b (contract-conformant error bodies) is a prerequisite, not a nicety.
- **Shrink to minimal reproducers.** On a divergence, the framework reduces the sequence to the
  smallest one that still diverges — preserving symbolic dependencies (you cannot drop the `create` a
  later step references) — a 3-line reproducer, not a 200-step trace.
- **Metamorphic relations** cover the case where the real API cannot be driven into a required state:
  oracle-free invariants (e.g. "create-then-read returns the created entity up to renaming",
  "`amount_refunded` never exceeds `amount`", idempotency, ordering/filtering) — Segura et al.'s
  metamorphic-relation output patterns are the catalogue to reuse.

## The CQRS exploit: deriving the behavioural projection from reducer write-sets

The hardest design question — _which_ response fields must agree for two systems to be "behaviourally
equivalent", and how much variation to permit — is exactly where Potemkin's architecture pays off.
This is **not** just "run both and diff": a four-stream literature sweep (program slicing /
information-flow, data-refinement / frame conditions, event-sourcing equivalence, effect-derived
oracles — citations below) converges on a single result that lets the comparison be _derived_ rather
than hand-tuned.

**A reducer's write-set is a frame condition, and a frame condition defines the observation.** The same
artifact appears under five names across the literatures: the **reducer write-set** (CQRS), the
**`modifies`/`assignable` clause** (Design-by-Contract, JML), the separation-logic **footprint**
(O'Hearn–Reynolds–Yang), the **write effect** (Gifford–Lucassen type-and-effect), and the program
**slice def-set** (Weiser, Horwitz–Reps–Binkley). Separation logic's **frame rule** —
`{P} C {Q} ⊢ {P∗R} C {Q∗R}` — states formally that _everything outside the write-set is preserved
unchanged_. Read as a testing oracle: **require agreement outside the write-set; permit variation
inside it.**

So the behavioural projection is computed, not picked:

> π(O) = (the response fields the projection reads) ∩ (the dependency-closed union of reducer
> write-sets reachable from the exercised operations O)

— a _chop_ in slicing terms (forward slice from the events O ∩ backward slice from the response). A
field is **behaviourally relevant** iff some reducer reachable from O can write it (directly, or
transitively through a derived/computed field — the dependency closure matters). Its dual,
**non-interference** (Goguen–Meseguer), certifies the converse: a field _outside_ the closure provably
cannot depend on event-driven state, so variation there is safe.

This yields a **three-way partition of every response, computed per operation from the reducers** — no
per-API hand-tuning, which is what kills the "green-by-construction" risk:

1. **Assert-equal** — fields in the deterministically-replayable write-set. Potemkin is a _value
   oracle_; the real API's value must equal Potemkin's prediction, up to the coherent id-bijection σ.
2. **Assert-unchanged (the frame oracle)** — fields _outside_ this operation's write-set. They must be
   identical to the pre-state on both sides. Cheapest, strongest, and free: it catches the real API
   mutating something it shouldn't.
3. **Assert-shape-only** — volatile / computed / server-assigned fields the reducer does _not_
   deterministically produce (timestamps, fresh ids, a fraud score, a real FX rate). Compared by
   **schema-membership + metamorphic invariants**, never by value.

### Handling data Potemkin has never seen

The CQRS structure is _precisely_ what lets Potemkin degrade its oracle gracefully — field by field —
instead of failing on unfamiliar data. The cases:

- **Fresh ids / entities the real API mints** → never compared against pre-existing data. Equivalence
  is tested _locally_ (separation-logic local reasoning): the harness **creates the entities it tests**
  by driving operations, threads each side's own ids symbolically (the `Bundle` mechanism), and
  compares the _effect of operations_ — not absolute state — up to σ-renaming.
- **The real API's ambient pre-existing state** (rows Potemkin doesn't have) → out of scope by
  construction. You reason only about the slice the test drives; you never try to mirror it.
- **A value Potemkin cannot predict** because it depends on data/logic Potemkin doesn't model → that
  field is _not in a deterministic reducer write-set_, so it lands in **assert-shape-only**: validate it
  against the contract schema and against reducer-derived metamorphic invariants (`score ∈ [0,1]`,
  `amount_refunded ≤ amount`) that hold _without_ Potemkin knowing the value.
- **An input/transition Potemkin's contract doesn't model at all** → flagged by the static coverage
  checks (MODEL2), still bounded by the contract floor, sent to triage (extend the model, or ledger it).

The intelligent part — the answer to "is it just run-both-and-diff?" — is **no**. The reducers tell
you, per field, _whether Potemkin is entitled to be a value-oracle_ (the field is in a deterministic,
replayable write-set) _or must fall back to a weaker oracle_ (schema + metamorphic). That
classification is computed from the event/reducer structure, not guessed.

### Free metamorphic relations from reducer algebra

A reducer's _algebraic properties_ — readable from its declaration — generate relations that hold of
the real API with **no value-oracle at all**, so they work on unseen data:

| Reducer property (statically provable)          | Metamorphic relation on the real API                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| Idempotent                                      | re-applying the same event leaves the projection unchanged (retries; PUT/DELETE) |
| Commutative on **disjoint** write-sets          | reordering independent operations yields the same projection                     |
| Inverse pair (create/delete)                    | `e ; e⁻¹` returns to the original observable                                     |
| Monotone (append-only, counters, result growth) | adding an element/constraint moves the observable in a known direction           |

Commutativity is emitted **only when write-sets are provably disjoint** (the effect-system check) —
that is the soundness gate. A violated relation is a _finding about the real API_, valid precisely
because Potemkin's reducer provably has the property.

### Event-trace lift (when the real API exposes events)

`state = fold(reducer, events)`; `response = project(fold(events))`. The API exposes only the
_projection_ (the effect), and `fold` is non-injective, so by default equivalence is
**observational / weak-bisimulation on projections**, up to σ-renaming and async quiescence. **But** if
the real API emits events (webhooks, change feeds, an outbox) you can lift to **trace equivalence on
the events** — comparing the _cause_, not just the effect — which is strictly stronger and catches
latent divergence the projection hides. Internal unobservable events are τ (weak bisimulation).

### Honest caveats

- **The frame must be a sound over-approximation** — never declare a field unmodified that a reducer
  might write (→ false equivalence failures). Prefer _inferring_ write-sets from reducer bodies over
  trusting a declaration.
- **Conditional / CEL reducers make the write-set path-dependent.** `if c then write A else write B` has
  static write-set `{A,B}` (over-approx); per-execution it writes one. Derive _dynamic_ (per-trace)
  write-sets where possible; otherwise the frame oracle weakens to fields no branch touches.
- **Derived / aliased fields** (etag, computed aggregates) must be pulled in via the functional-
  dependency closure, or excluded from the observation — never demanded invariant while their base
  fields are in the write-set.
- **Async / eventual consistency** — poll-until-stable (quiescence) before comparing; read-after-write
  lag is τ, not a failure.

## Architecture (Potemkin-specific)

Potemkin has a structural advantage: **its DSL already is the state-machine model.** It encodes the
operations, the valid transitions, and the **preconditions** (e.g. `requires:` "you may only `capture`
a PaymentIntent in `requires_capture`"). That is exactly what a stateful generator needs to produce
valid, deep sequences. So Potemkin plays a dual role — the _model that drives generation_ and _one of
the two systems compared_.

Components (all new, under a new `tests/equivalence/` — matching the `tests/conformance/` gate — plus a
small engine introspection endpoint):

1. **Model-driven sequence generator.** Reads the OpenAPI operations + Potemkin's compiled DSL
   (operations, `emit`/transitions, `requires` preconditions) and generates valid operation sequences,
   directed for state/transition coverage. Symbolic placeholders bind the result of each create/op for
   later steps. (Reuses the engine's knowledge of legal transitions so generated sequences are not
   nonsense.)
2. **Dual runner.** Executes each abstract sequence against (a) the real API at a configured base URL
   and (b) Potemkin, resolving each symbolic placeholder to _that side's_ concrete id from _that
   side's_ earlier response. Resets/establishes a clean starting state on each side per sequence.
3. **Contract-aware comparator** — the heart of "behavioural, not exact", and where the soundness lives.
   It maintains **one coherent identifier bijection σ for the whole sequence** (not a fresh renaming per
   response): the first time a real id and a model id appear in corresponding positions they are _bound_
   in σ; every later occurrence must respect that binding; a newly minted id must be _globally fresh_ on
   both sides (the nominal / fresh-register discipline). Then, for each response pair it applies, in
   order:
   - **σ-renaming** — rewrite identifiers through σ; a binding that contradicts σ is a divergence (this
     is what catches a real API that reuses or permutes ids inconsistently — the failure mode that
     per-response renaming silently accepts);
   - **reducer-derived three-way projection** (see "The CQRS exploit" above — this replaces a hand-tuned
     field list): **assert-equal** on fields in the operation's deterministically-replayable reducer
     write-set (up to σ); **assert-unchanged** (the frame oracle) on fields outside it; **assert-shape-
     only** (schema-membership + metamorphic invariants) on volatile/computed/unseen-data fields the
     reducer does not deterministically produce. Volatile fields are identified from the contract
     (`format` families actually present — e.g. Stripe uses `unix-time`, not `date-time` — plus
     `readOnly` and a configured set), not a fixed marker list;
   - **uioco output-inclusion** — the surviving real output must be one the contract _permits_ here (⊆),
     not necessarily the only one; underspecified points are "don't care".
     Permitted-after-this-relation ⇒ the step conforms. (This is the engineering realisation of
     "alternating refinement up to a bijection on names", with the observation derived from the reducer
     write-sets as frame conditions.)
4. **Shrinker.** On a non-equivalent step, minimise the generating sequence to the smallest reproducer.
5. **Justified-divergence ledger.** Each confirmed divergence is resolved one of two ways, never
   silently: (a) a Potemkin fidelity fix to match the real API, or (b) a **cited** ledger entry
   recording a deliberate difference (e.g. the real API rate-limits and Potemkin does not), keyed by
   operation + the specific behavioural field, with the justification. The comparator treats a ledgered
   difference as equivalent; a meta-check fails if a ledger entry no longer corresponds to a real
   divergence (same staleness guard as the conformance allowlist).
6. **Metamorphic mode.** When no real API is available, run the generated sequences against Potemkin
   alone and check the metamorphic invariants — proving internal behavioural consistency without an
   oracle.

## The static / mathematical layer: model-equivalence by analysis

Instead of (only) running calls and diffing responses, treat both systems as **finite-state models**
and _compute_ whether one can reproduce the other. This is the formal-methods view, and it answers the
"reason about whether Potemkin's structure can re-create the change, by sequence" question directly.

### Step A — extract Potemkin's model from its configuration (no real API needed)

Potemkin's DSL _is_ a state machine, so a model can be lifted from the config by static analysis —
this is the "scan the different configurations and the event ordering" the question asks for:

- **States** = the abstract, state-bearing fields of the schema (e.g. `PaymentIntent.status` ∈
  {`requires_payment_method`, `requires_confirmation`, `requires_capture`, `succeeded`, `canceled`}) —
  the _control state_, not the concrete data.
- **Transitions** = each operation, **guarded** by its `requires:` precondition, **emitting** an
  event whose **reducer** computes the next state. Reactions/sagas add further (internal) transitions.
- **Data** = the entity's value fields, modelled as **registers** updated by the reducers — i.e. an
  _Extended Finite State Machine_ / _register automaton_, which is the right class because it captures
  **identifier flow** (a created `id` flowing into a later path) and data relations, exactly the
  fresh-id concern, at the model level.

From this extracted model alone — **without touching the real API** — Potemkin can compute, purely
about its own structure:

- **Reachability**: is every contract-implied state reachable? Are there dead/unreachable states or
  **deadlocks** (a state with no legal outgoing transition where the contract expects one)?
- **Determinism / well-formedness**: does every (state, operation) pair have a defined transition, or
  are there gaps the DSL silently leaves to fallback?
- **Coverage of the contract**: every operation × reachable state the contract enumerates is realised
  by some transition. This is a _capability_ check — "is Potemkin's structure even _able_ to express
  these behaviours?" — answerable by model-checking the extracted automaton.

### Step B — get a coverage _guarantee_ without a second model (W/Wp), and only optionally a real-API model

There are three ways to use Potemkin's extracted model against the real API, in increasing cost:

1. **W/Wp-method conformance suite from Potemkin (recommended; no real-API model needed).** Classical
   FSM conformance testing (Chow's **W-method**, 1978; Fujiwara et al.'s **Wp-method**, 1991; Vasilevskii 1973) derives, _from the known model_, a finite test suite that is **complete for any implementation
   with at most _m_ more states than the model** — a genuine coverage-up-to-a-bound guarantee, and the
   reason we do **not** need to learn the real API to get one. The suite is generated from Potemkin and
   executed by the Layer-1 dual runner; this is the principled upgrade of "generate sequences", and it
   lives in Layer 1.
2. **Authored real-API model** — a hand-written behavioural state-machine of the real API (from its
   docs). Enables a pure model-to-model check (Step C) with no real-API interaction. Only as good as
   its author; rarely available.
3. **Learned real-API model (optional discovery tool).** **Active automata learning** (Angluin's **L\***
   and successors — TTT, Observation Packs; via **LearnLib** / **AALpy**) infers a finite model from
   bounded **membership** + **equivalence** queries; for identifiers/data, **register-automata learning**
   (SL\*/SLλ, **RALib**) infers models carrying data relations and fresh names. This is the technique for
   when _no model exists_ — which is not our situation — so here it is justified only as an occasional
   way to **surface states/transitions the contract never modelled** (the TLS/TCP/DTLS protocol-state-
   fuzzing results found exactly such unscripted states), and only when the id domain is
   **equality/freshness-only** (the soundly-learnable, decidable fragment).

### Step C — compute the relation between two models (when you have both)

When a real-API model exists (authored or learned), the question becomes a _structural_ one. The target
is a **one-directional simulation / refinement**, **not bisimulation**:

- **Simulation preorder / alternating refinement** (`real ⊑ Potemkin`): Potemkin can match every move
  the real API requires — the precise formalisation of "Potemkin's structure can re-create the real
  API's changes." This is the right one-directional notion (Alur–Henzinger–Kupferman–Vardi).
- **Failures refinement** (CSP ⊑_F; tools **FDR**, **mCRL2**, **CADP**): adds the _deadlock/refusal_
  guarantee — the real API must not refuse an operation the contract says is enabled (this is the
  formal home of the `requires`-precondition obligation).
- **Bisimulation is deliberately _not_ the target** — it would force the two to be interchangeable
  rather than the real API merely conforming. (It remains the right vocabulary only for the
  id-renaming sub-relation: equivalence _up to a bijection on fresh names_.)

**Decidability frontier (be honest about it):** for **deterministic** (fresh-)register automata,
equivalence/simulation up to renaming is **decidable — polynomial-time** (Murawski–Ramsay–Tzevelekos,
2018); finite-state refinement is decidable and well-tooled (Paige–Tarjan O(m log n); FDR). But for
**nondeterministic** register automata, equivalence and containment are **undecidable**
(Benedikt–Ley–Puppis, 2010). So a clean model-to-model verdict exists only for deterministic, finite
abstractions of _both_ sides — and you only have a real-API model at all if you authored or learned one.

### How the layers compose

The empirical dual-runner (Layer 1) is exactly the **teacher** an L\*-style learner needs (its
membership query _is_ "run this sequence and observe", its equivalence query _is_ "differential-test the
hypothesis to find a counterexample") — so _if_ you ever run the optional learning layer, Layer 1 feeds
it and the learned model's coverage directs Layer 1 back. But note the asymmetry the literature insists
on: because we already hold a model, **W/Wp from Potemkin (Layer 1) gives the coverage guarantee more
cheaply than learning ever could**; learning is reserved for _discovering behaviours the contract
doesn't model_, not for certification.

### Precise limits of the mathematical layer

- The model captures the **control + register structure**, not arbitrary data computation. Pure
  arithmetic over values (exact `amount_refunded = sum(refunds)` clamping) is only partially expressible
  as register updates; that fidelity is certified by Layer 1, not Layer 2.
- A **learned** model is correct only up to its equivalence-query oracle (W/Wp completeness needs an
  _m_-bound you must guess; random testing gives only PAC-style confidence) **and** up to a hand-written
  abstraction mapper whose wrongness yields confidently-wrong verdicts. An **authored** model is only as
  good as its author.
- Model-to-model checking is **decidable only for deterministic finite abstractions**; nondeterminism +
  unbounded identifiers is undecidable. Against the genuinely black-box real API there is no global
  refinement check — only sound _refutation_ by sampling (Layer 1).

## How this answers the open questions

- **"Which scenarios do we run?"** None are authored — they are _generated_ from Potemkin's own state
  machine, directed for coverage of every state and transition. You measure model coverage, not a
  fixed scenario count.
- **"Different state / Potemkin mints its own ids?"** Symbolic id-threading: never compare literal ids;
  thread "the entity from step N" through each side and compare under a _single coherent_ bijection σ
  maintained across the whole trace (nominal / fresh-register "up to renaming"), not a per-response one.
- **"Behavioural equivalence, not exact equality?"** The **uioco / alternating-refinement** preorder up
  to the relation in component 3 — the real API's observable outputs after a contract-legal trace are
  _permitted by_ the contract (⊆), on the behaviourally-relevant fields, after σ-renaming +
  normalisation. One-directional and conformance-shaped, not bisimulation, not byte-equality.
- **"How do we find the differing behaviours so we can fix Potemkin?"** The dual run surfaces each
  divergence; the shrinker minimises it; the ledger forces an explicit resolve (fix or cite). Re-running
  over many generated sequences converges Potemkin toward equivalence.

## What equivalence certifies — and its precise properties

These are properties of the method, stated plainly, not caveats to defer work:

- **It yields statistical confidence, not formal proof.** The sequence space is unbounded; like all
  property-based testing, confidence rises with generation depth and coverage. The gate reports the
  coverage achieved (states/transitions exercised, sequences run) so the confidence level is explicit.
- **It is observational.** It certifies exactly the behaviour visible through the API. Internal state a
  system never exposes through any operation is, by construction, unobservable — a consumer cannot
  depend on it either, so it is correctly outside what equivalence needs to cover. (This is the
  definition of observational equivalence, not a gap.)
- **Deliberate differences are explicit and cited**, recorded in the divergence ledger with a
  justification, never silently dropped — and the ledger is staleness-guarded so a difference that
  later disappears (or a Potemkin regression that introduces a new one) is caught.
- **The real API must be drivable** (a test account/mode, or a controlled instance) and tolerant of
  generated traffic; the comparator carries configured tolerances for genuine real-API non-determinism
  (eventual consistency, retries). Where it is not drivable, the metamorphic mode still certifies
  Potemkin's internal behavioural consistency.

## Relationship to the other proposals

- **Conformance gate** ([doc](specmatic-conformance-gate.md)) is the **floor**: both the real API and
  Potemkin individually satisfy the contract (shape + status). Equivalence testing is the **behavioural
  layer** above it — once both pass the contract floor, any divergence the comparator finds is a true
  behavioural difference, not one side being contract-broken.
- **Export-examples** ([doc](specmatic-export-examples.md)) provides the **seed corpus and regression
  record**: a sequence proven equivalent is captured as a Specmatic example so it stays green.
- **Error bodies** (master proposal #4b) is in scope: error responses are observable behaviour and are
  compared by the comparator's behavioural projection (the error `code`/shape).

## Increment plan (filed as two epics — beads separate)

**Layer 1 — model-based conformance testing (PRIMARY — Potemkin as the behavioural oracle, ioco):**

1. **EQ1 — comparator + uioco relation, with a coherent trace-wide id-bijection σ and the reducer-
   derived three-way projection.** The contract-aware comparator (σ maintained across the whole
   sequence + the **assert-equal / assert-unchanged(frame) / assert-shape-only** partition computed from
   the operation's reducer write-sets — see "The CQRS exploit" — + uioco output-inclusion), per-API
   relation config. Unit-tested on response pairs incl. the unsoundness case (inconsistent id
   permutation must fail) and the unseen-data case (a field outside the deterministic write-set is
   shape-checked, not value-checked); no live API yet. _Depends on MODEL1 for the per-operation
   write-sets._
2. **EQ2 — dual runner + symbolic id-threading.** Execute an _authored_ abstract sequence against two
   base URLs, threading each side's own ids; diff via EQ1. Proven first with Potemkin-vs-Potemkin
   (two instances → must conform) to validate the harness without a real API. Requires rejections to be
   modelled as contract error outputs (depends on #4b error bodies — the input-enabledness obligation).
3. **EQ3 — model-driven generator, W/Wp-capable.** Generate valid sequences from Potemkin's compiled
   DSL (operations + `requires` preconditions + transitions), coverage-directed, with symbolic
   placeholders — _including negative sequences_. Support **W/Wp-method** generation so the suite is
   complete up to a configured _m_-state bound (the coverage guarantee, derived from Potemkin, with no
   second model).
4. **EQ4 — shrinking (dependency-preserving) + justified-divergence ledger** (with staleness guard).
5. **EQ5 — metamorphic mode**, with relations **auto-derived from reducer algebra** (idempotency,
   commutativity on provably-disjoint write-sets, inverse pairs, monotonicity — gated on static
   provability) plus Segura-style MROPs. Oracle-free, so it also validates **unseen-data** fields and
   the not-drivable case.
6. **EQ6 — contract-backed provider coverage**: run the generated model traces
   through local Potemkin instances and the Specmatic contract floor. Live
   provider testing is explicitly outside this repository's acceptance path.

**Layer 2 — static / mathematical model-equivalence (OPTIONAL reinforcement; MODEL1+MODEL2 are the
config-only checks worth doing early; MODEL3+MODEL4 only if structural-coverage guarantees are needed):**

7. **MODEL1 — extract Potemkin's transition model** (register automaton / EFSM) from the compiled DSL
   via a new engine introspection endpoint; emit it as a typed structure. Pure static analysis.
8. **MODEL2 — config-only structural checks**: reachability, deadlock/dead-state detection,
   (state, operation) totality, and contract-state coverage on the extracted model. Surfaces gaps with
   no real API. (Naturally complements the boot-lint subsystem.)
9. **MODEL3 — model-to-model refinement engine** (optional): compute the **simulation / failures
   refinement** (not bisimulation) between Potemkin's model and an authored real-API model, up to the
   id-renaming relation; report the failing transitions that pinpoint where the real API would diverge.
   Decidable only for deterministic finite abstractions.
10. **MODEL4 — active learning of the real API** (optional, discovery only): integrate a learner
    (LearnLib/AALpy/RALib) whose teacher is the EQ2 dual-runner, to _learn_ the real API's (register)
    automaton and diff it against Potemkin to **surface unmodelled states/transitions**. Justified only
    when the id domain is equality/freshness-only and you specifically need behaviour-discovery beyond
    what W/Wp from Potemkin already covers. Not a certification mechanism.

## References

Assembled from two literature sweeps (2026-06-06): a five-stream sweep on the conformance relation +
id problem, and a four-stream sweep on deriving the behavioural projection from the CQRS/reducer
structure. Grouped by the role each plays in the design.

### Conformance relation — the Layer-1 backbone (ioco / uioco / sioco)

- J. Tretmans, _Conformance Testing with Labelled Transition Systems: Implementation Relations and Test
  Generation_ (Computer Networks & ISDN Systems, 1996) — the canonical **ioco** relation + sound &
  exhaustive test derivation.
- J. Tretmans, _Model-Based Testing with Labelled Transition Systems_ (LNCS 4949, 2008) — the standard
  tutorial: IOLTS, quiescence, suspension traces, soundness/exhaustiveness.
- M. van der Bijl, A. Rensink, J. Tretmans, _Compositional Testing with ioco_ (FATES 2003) — **uioco**,
  the underspecification-tolerant, compositional variant (our actual base relation).
- L. Frantzen, J. Tretmans, T. Willemse, _A Symbolic Framework for Model-Based Testing_ (FATES/RV 2006)
  — **sioco** over Symbolic Transition Systems (data + guards); implemented in **TorXakis**.
- R. Janssen, F. Vaandrager, J. Tretmans, _Relating Alternating Relations for Conformance and
  Refinement_ (IFM 2019) — uioco ≅ a variant of **alternating refinement**; the bridge to the
  process-theory view.
- A. Belinfante, _JTorX: A Tool for On-Line Model-Driven Test Derivation and Execution_ (TACAS 2010);
  Tretmans et al., **TorXakis** (Dropbox case study) — reference ioco/sioco tools.
- J. Booy, J. Keiren, M. van der Bijl, _Compositional ioco using model-based mocking_ (CEUR 2023);
  S. Salva, P. Laurençot, _ioco proxy-testers for web service compositions_ (2015) — ioco applied to
  service/REST architectures.

### Behavioural relations & the id problem — the equivalence theory

- R. J. van Glabbeek, _The Linear Time – Branching Time Spectrum I & II_ (Handbook of Process Algebra,
  2001; CONCUR 1993) — the map of trace/failures/simulation/bisimulation and what each preserves.
- R. Alur, T. Henzinger, O. Kupferman, M. Vardi, _Alternating Refinement Relations_ (CONCUR 1998);
  L. de Alfaro, T. Henzinger, _Interface Automata_ (ESEC/FSE 2001) — the right one-directional notion
  for input/output systems.
- C. A. R. Hoare, _CSP_ (1985); A. W. Roscoe, _Theory and Practice of Concurrency_ (1997);
  Gibson-Robinson et al., _FDR3_ (TACAS 2014) — failures/divergences **refinement** and its checker.
- M. Gabbay, A. Pitts, _A New Approach to Abstract Syntax with Variable Binding_ (2002); A. Pitts,
  _Nominal Sets_ (CUP 2013) — the rigorous theory of "equality up to renaming" (freshness, equivariance).
- U. Montanari, M. Pistore, _History-Dependent Automata_ (1999); N. Tzevelekos, _Fresh-Register
  Automata_ (POPL 2011) — state machines that **mint fresh names**; bisimulation up to name allocation.
- A. Murawski, S. Ramsay, N. Tzevelekos, _Polynomial-Time Equivalence Testing for Deterministic
  Fresh-Register Automata_ (STACS/MFCS 2018) — **decidable, P-time** up-to-renaming equivalence
  (deterministic case).
- M. Kaminski, N. Francez, _Finite-Memory Automata_ (TCS 1994); M. Bojańczyk, B. Klin, S. Lasota,
  _Automata Theory in Nominal Sets_ (LMCS 2014); M. Benedikt, C. Ley, G. Puppis, _Automata vs. Logics on
  Data Words_ (CSL 2010) — register/nominal automata and the **undecidability** frontier for the
  nondeterministic case.
- S. Khurshid, D. Marinov, _TestEra: Specification-Based Testing … Using SAT_ (ASE journal, 2004) —
  checking outputs against a spec **modulo isomorphism** (the engineering form of "up to renaming").

### Coverage guarantee from a known model — W/Wp

- T. S. Chow, _Testing Software Design Modeled by Finite-State Machines_ (IEEE TSE, 1978) — the
  **W-method** (complete up to _m_ extra states); M. Vasilevskii (1973), independent origin.
- S. Fujiwara et al., _Test Selection Based on Finite State Models_ (IEEE TSE, 1991) — the **Wp-method**.

### Stateful model-based / property testing — the operational pattern & symbolic ids

- J. Hughes, _QuickCheck Testing for Fun and Profit_ (PADL 2007) and _Testing the Hard Stuff and Staying
  Sane_ (LNCS 9600, 2016) — the statem model-as-oracle method, symbolic command sequences, shrinking.
- T. Arts, J. Hughes et al., _Testing Telecoms Software with Quviq QuickCheck_ (Erlang WS 2006);
  _Testing AUTOSAR Software with QuickCheck_ (ICSTW 2015); J. Hughes, B. Pierce et al., _Mysteries of
  Dropbox_ (ICST 2016) — industrial model-vs-real-system testing; Dropbox is the closest published
  analogue to "drive a real networked service from a model".
- MacIver, Hatfield-Dodds, _Hypothesis_ (JOSS 2019) — `RuleBasedStateMachine`, `Bundle`/`target`/
  `consumes` (the symbolic-id mechanism); **PropEr** `{var,N}`; **ScalaCheck** `Commands`; **fast-check**
  `ModelRunner`/`commands()` (same TS ecosystem as Specmatic — the most direct adoption path).
- N. Koh et al., _From C to Interaction Trees_ (CPP 2019) — executable spec of a real network server,
  observational-equivalence over the wire.

### Active automata learning — the optional discovery layer

- D. Angluin, _Learning Regular Sets from Queries and Counterexamples_ (1987) — **L\*** / the MAT
  framework; R. Rivest, R. Schapire (1993); M. Isberner et al., _TTT_ (RV 2014) — practical learners.
- **LearnLib** (Isberner–Howar–Steffen, CAV 2015); **AALpy** (Muškardin et al., 2022); **RALib** — tools.
- F. Vaandrager, _Model Learning_ (CACM 2017) — the survey; D. Peled, M. Vardi, M. Yannakakis,
  _Black Box Checking_ (FORTE 1999) — the canonical "learn + check when no model exists".
- J. de Ruiter, E. Poll, _Protocol State Fuzzing of TLS Implementations_ (USENIX Security 2015);
  Fiterău-Broștean et al. (TCP, CAV 2016; DTLS, USENIX Security 2020) — learning found unscripted
  "extra" states: the evidence for learning-as-discovery.
- S. Cassel, F. Howar, B. Jonsson, B. Steffen, _Active Learning for Extended Finite State Machines_
  (FAC 2016); Dierl et al., _Scalable Tree-based Register Automata Learning_ (TACAS 2024) — id/data-aware
  learning (the equality/freshness fragment).

### Applied REST/API testing & the oracle problem

- E. Barr, M. Harman, P. McMinn, M. Shahbaz, S. Yoo, _The Oracle Problem in Software Testing: A Survey_
  (IEEE TSE 2015) — the oracle taxonomy; Potemkin-as-oracle is a _specified/model-based_ oracle.
- S. Segura et al., _Metamorphic Testing of RESTful Web APIs_ (IEEE TSE 2018) + the MT surveys (Segura
  et al. 2016; Chen et al. ACM CSUR 2018) — metamorphic relations for the not-drivable case.
- Atlidakis et al., _RESTler_ (ICSE 2019); Liu et al., _Morest_ (ICSE 2022); Arcuri et al., _EvoMaster_
  (ASE 2024); Hatfield-Dodds & Dygalo, _Schemathesis_ (ICSE 2022); Viglianisi et al., _RestTestGen_
  (ICST 2020); Kim et al., _No Time to Rest Yet_ (ISSTA 2022, the tool study) — the state of the art,
  whose oracles are shallow (5xx + schema), confirming the gap a stateful behavioural oracle fills.
- W. McKeeman, _Differential Testing for Software_ (1998); Petsios et al., _NEZHA_ (IEEE S&P 2017) — the
  differential fallback.

### Deriving the behavioural projection — the CQRS exploit (write-set = frame = observation)

_Slicing / information-flow (which response fields are behaviourally load-bearing):_

- M. Weiser, _Program Slicing_ (ICSE 1981 / IEEE TSE 1984); S. Horwitz, T. Reps, D. Binkley,
  _Interprocedural Slicing Using Dependence Graphs_ (PLDI 1988 / TOPLAS 1990) — the SDG and transitive
  def-use closure of write-sets reachable from the exercised operations (the projection = a _chop_).
- T. Reps, W. Yang, _The Semantics of Program Slicing_ (1989) — soundness: a slice agrees with the
  original on the sliced variables. Korel–Laski (1988) & Agrawal–Horgan (PLDI 1990) — dynamic (per-trace)
  slices. Binkley et al., _ORBS: Language-Independent Program Slicing_ (FSE 2014) — observation-based
  slicing (derive relevance by perturb-and-observe). Sridharan et al., _Thin Slicing_ (PLDI 2007).
- J. Goguen, J. Meseguer, _Security Policies and Security Models_ (S&P 1982) — **non-interference**: the
  dual that certifies fields _outside_ the closure cannot depend on state. Sabelfeld–Myers survey (2003).
- Cheney, Chiticariu, Tan, _Provenance in Databases_ (FnT 2009) — per-field provenance explains _derived_
  fields (relevant iff provenance touches state).

_Data refinement / frame conditions (the write-set IS the observation):_

- C. A. R. Hoare, _Proof of Correctness of Data Representations_ (Acta Inf. 1972) — the abstraction/
  retrieve function. W.-P. de Roever, K. Engelhardt, _Data Refinement_ (CUP 1998) — forward+backward
  simulation, sound & jointly complete. N. Lynch, F. Vaandrager, _Forward and Backward Simulations_
  (Inf.&Comp. 1995) — the I/O-automata proof method; history/prophecy variables.
- J. Reynolds, _Separation Logic_ (LICS 2002); O'Hearn, Reynolds, Yang, _Local Reasoning_ (CSL 2001) —
  the **frame rule** `{P}C{Q} ⊢ {P∗R}C{Q∗R}`: everything outside the footprint is preserved. I. Kassios,
  _Dynamic Frames_ (FM 2006) — _state-dependent_ write-sets (a reducer's write-set is data-dependent).
  Smans et al., _Implicit Dynamic Frames_ (ECOOP 2009) — write-set = footprint.
- A. Pitts, _Operational Semantics and Program Equivalence_ (APPSEM 2002); Milner/Plotkin full abstraction
  (TCS 1977) — observational/contextual equivalence relative to a chosen observation.
- F. Aarts, B. Jonsson, J. Uijen, F. Vaandrager, _Generating Models … with Abstraction_ (ICTSS 2010 /
  FMSD 2015) — the **mapper/abstraction** must be a _sound projection_; the precedent for "id-renaming +
  keep meaningful fields", refined from counterexamples rather than hand-tuned.

_Event-sourcing / CQRS equivalence (state = fold(reducer, events)):_

- Meijer, Fokkinga, Paterson, _Bananas, Lenses, Envelopes and Barbed Wire_ (FPCA 1991) + Hutton's
  _universality of fold_ (JFP 1999) — `state = fold(reducer, events)` as a catamorphism; proof principle
  for projection equivalence. M. Fowler, _Event Sourcing_ (2005); G. Young, _CQRS_ — the engineering form.
- Shapiro et al., _Conflict-Free Replicated Data Types_ (SSS 2011); Gomes, Kleppmann et al., _Verifying
  Strong Eventual Consistency_ (OOPSLA 2017) — **commutativity/idempotency ⇒ order-independence**, the
  source of free metamorphic relations. Copei & Zündorf, _Commutative Event Sourcing_ (2021).

_Effect-derived oracles & metamorphic relations from update functions:_

- Arts, Hughes et al. (Quviq) — the reducer ≈ `next_state`, the comparator ≈ `postcondition`. Veanes et
  al., _Spec Explorer_ (LNCS 4949, 2008) — the model update _is_ the assertion.
- Doong & Frankl, _ASTOOT_ (TOSEM 1994); Gannon et al., _DAISTS_ (TOPLAS 1981); Bernot, Gaudel, Marre
  (1991) — algebraic-spec axioms ⇒ oracles + equivalent/non-equivalent sequence pairs.
- Borgida, Mylopoulos, Reiter, _…And Nothing Else Changes: The Frame Problem in Procedure Specifications_
  (ICSE 1993); Gifford–Lucassen, _Polymorphic Effect Systems_ (POPL 1988); Talpin–Jouvelot, _The Type and
  Effect Discipline_ (Inf.&Comp. 1994) — the frame/write-effect as a first-class, _inferable_ object.
- Segura et al., _MR Patterns for Query-Based Systems_ (MET 2019); Alonso et al., _AGORA_ (ISSTA 2023) —
  reusable MR catalogue + inferred invariants for the shape-only (unseen-data) fields.
