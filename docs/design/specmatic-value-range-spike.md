# Specmatic value-range generator spike

Date: 2026-08-01
Specmatic: 2.46.2
JAR: `tests/e2e/.cache/specmatic-2.46.2.jar`

## Determination

The value-range mutation class cannot be isolated by the Specmatic 2.46.2
test CLI or v3 test configuration. The supported `--filter` keys reported by
`specmatic test --help` are `METHOD`, `PATH`, and `STATUS`; none identifies a
generator class, schema keyword, or value-range mutation. The available v3
settings control the resiliency mode and request-combination/count limits, but
do not add a value-range selector.

Therefore Layer A must apply the existing preference order as follows:

1. Use method/path/status filtering where it excludes an entire unwanted
   operation without removing genuine schema-resiliency coverage.
2. Use pinned positive examples for stateful reads.
3. Route only exact value-range divergences that remain to Layer C, with a
   narrow scenario-specific allowlist entry and a justification that cites the
   validator's deliberate range-key stripping. No wildcard or path-only entry
   is acceptable.

## Evidence

The hand-runnable spike is:

```sh
pnpm exec tsx tests/conformance/specmatic-value-range-spike.ts
```

It performs two checks against the real JVM: it inspects the live CLI help,
then boots the CRM example and runs a bounded generative test through the real
Specmatic test JVM using `METHOD='POST' && PATH='/leads'`. The recorded run
produced 24 test cases, including four stateful positive failures caused by
generated foreign aggregate ids. The bounded result does not imply that all
value-range cases are equivalent; it demonstrates that the probe is using the
real test-mode path while the selector capability is determined from the
actual pinned binary.

The source of the known divergence is `stripValueRanges` in
`src/contract/validator.ts`: numeric range keywords are intentionally removed
from request validation, so an out-of-range but otherwise well-typed value may
reach the engine rather than produce the contract-generated 400 response.
