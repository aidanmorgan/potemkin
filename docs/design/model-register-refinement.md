# MODEL5 fresh-register refinement determination

The MODEL5 spike has a negative first deliverable for the current
`TransitionModel` contract.

The model is a finite-state, source-independent projection. Its transitions
contain opaque state labels, operation labels, guard text, and a
reducer-derived write-set summary. It does not contain register variables,
fresh-name allocation actions, equality tests over registers, or a relation
between an identifier written by one transition and an identifier consumed by
another. The model therefore cannot establish that CRM UUIDs or Stripe
`pi_`/`ch_` identifiers form a deterministic fresh-register automaton.

The TypeScript model builder also deliberately emits
`nextStateKnown: false` for opaque reducer callbacks, and the CRM Agent status
machine contains exactly such a transition. MODEL3 rejects that aggregate by
construction. These facts prevent a sound claim that the whole extracted
model lies in the deterministic fresh-register fragment.

Consequently MODEL5 stops at the determination stage: no id-renaming
refinement verdict is emitted and no nominal-name algorithm is added. A future
implementation must first extend the canonical model with explicit register
and freshness semantics, guard-lift every data-dependent transition, and
prove deterministic/UNKNOWN-free input before this spike can be resumed. The
finite-state MODEL3 checker remains the only optional refinement capability
implemented here, and neither analysis is part of `test:equivalence`.
