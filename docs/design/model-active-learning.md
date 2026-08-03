# Optional active-learning discovery

`tests/equivalence/activeLearning.ts` is an isolated discovery harness. It
uses the injected EQ2 runner surface for bounded membership queries and builds
an observation-tree hypothesis. The hypothesis can be compared with MODEL1 to
list operations and transitions observed in the real target that the authored
model does not describe.

This is deliberately bounded discovery, not certification and not a claim of
general register-automata learning. It only runs when the caller explicitly
declares an equality/freshness-only identifier domain. Arbitrary identifiers,
semantic values, and nondeterministic/UNKNOWN behaviour require a stronger
learner and are rejected or reported as inconclusive. The harness is not
referenced by `test:equivalence` and has no effect on runtime boot or E2E
certification.
