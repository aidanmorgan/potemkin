# Potemkin test organization and value rules

Tests are grouped by the behavior or boundary they verify. Numeric historical
prefixes are not part of the test naming convention.

| Area                    | Location                                                   | Canonical purpose                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                    | `tests/unit/<layer>/`                                      | Fast contracts for CEL, YAML parsing, TypeScript SDK/loader, model, runtime policies, transport, identity, observability, and error diagnostics.                                       |
| Runtime                 | `tests/runtime/`                                           | Source-independent execution and direct HTTP parity. Each source-sensitive behavior is exercised for YAML and TypeScript, with mixed-source cases where composition matters.           |
| Integration/equivalence | `tests/integration/`, `tests/unit/equivalence/`            | Normalized model, event/state/response comparisons, conformance harnesses, and external-provider boundaries.                                                                           |
| Specmatic E2E           | `tests/e2e/`                                               | Real Specmatic JVM → plugin → Potemkin business requests, including YAML-only, TypeScript-only, and mixed configurations. Business assertions do not call `/_engine/forward` directly. |
| BDD                     | `tests/bdd/`                                               | Requirement traceability and executable feature-level scenarios. Step mappings point to descriptive canonical tests.                                                                   |
| Property and security   | `tests/property/`, `tests/redteam/`                        | Invariants, generated values, and adversarial parser/evaluator behavior.                                                                                                               |
| Plugin/examples         | `plugin/src/test/`, `tests/examples/`, `examples/*/tests/` | JVM transport behavior and consumer-facing example contracts.                                                                                                                          |

Value review rules:

- Keep one canonical test for each invariant at the lowest useful layer and a
  real Specmatic test for each externally observable product contract.
- Retain direct runtime tests when they isolate model or port semantics that
  would be obscured by the JVM transport.
- Retain YAML, TypeScript, and mixed cases when authoring or composition could
  change semantics; do not duplicate a source-neutral assertion in three files
  when one parameterized parity test proves it.
- Delete migration-only smoke tests only after their assertions are covered by
  a broader canonical test and all traceability references are moved.
- Never use `skip`, `only`, or `todo` registrations to hide unfinished work.

The current audit removed the redundant two-case authoring smoke suite after
its behavior was confirmed in `tests/runtime/runtime-authoring-parity.runtime.test.ts`.
The remaining suite is checked for descriptive filenames, known layer
directories, stale numeric E2E references, and the no-skips rule by
`tests/unit/audit/sourceTree.test.ts` and `scripts/check-no-skipped-tests.mjs`.

The value review is also machine-checked by
`tests/unit/audit/testValueTraceability.test.ts`, using the explicit policy
inventory in `tests/_support/testValueInventory.ts`. Every test artifact is
assigned a role, purpose, canonical boundary, and at least one canonical
evidence test. This catches orphaned or newly misplaced tests before they can
be treated as coverage. The inventory deliberately keeps direct runtime tests
where they isolate source-neutral semantics, and keeps real Specmatic tests
where they prove the external contract; it does not count either as a
substitute for the other.

The review record for the migration-only removal is the deleted two-case
runtime authoring smoke suite: its assertions were compared with the
parameterized canonical parity suite before removal, and the source-tree audit
rejects stale references to the deleted path. No test is removed solely because
another test happens to pass; removal requires an equivalent canonical
assertion and a traceability update.
