# Optional finite-state refinement

`tests/equivalence/refinement.ts` provides MODEL3's optional finite-state
analysis. It consumes the source-independent `TransitionMachine` produced by
the YAML parser and TypeScript loader; it does not inspect either authoring
surface and is not part of the runtime or the certification command.

The implementation is checked against the specification using one-directional
simulation/failures refinement. Every implementation transition from a related
state must have a same-operation specification transition to another related
pair. Specification-only transitions are allowed, so this is not bisimulation.
Unreachable implementation states are consequently harmless.

The analysis rejects by construction when a machine contains an
`nextStateKnown: false`/`UNKNOWN` transition. It also rejects nondeterminism
unless every competing branch has pairwise-obvious, mutually exclusive
conjunctive guards. Arbitrary CEL is not solved by this optional checker: a
branch that cannot be proven disjoint is rejected rather than producing an
unsound verdict. Identifier/register reasoning remains outside this finite
state module and belongs to the separate MODEL5 spike.

The test suite includes refining and non-refining machines, unreachable extra
states, guard-lifted branches, unguarded nondeterminism, and the CRM Agent
status machine's required UNKNOWN rejection. The module is deliberately not
referenced by `test:equivalence`.
