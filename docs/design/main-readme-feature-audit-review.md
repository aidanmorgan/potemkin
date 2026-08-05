# README feature-audit review

This document records the additive review of the historical README feature
inventory. It is intentionally separate from the generated developer guide so
that implementation evidence can be updated without reintroducing migration
instructions into the public README.

The review is maintained as a source-of-truth index. A feature is complete
only when its runtime implementation, YAML and TypeScript authoring paths, and
unit/integration/end-to-end evidence are all present. The authoritative
feature rows are in
[`main-readme-feature-completeness.md`](./main-readme-feature-completeness.md)
and the operational controls are in
[`main-readme-operational-feature-completeness.md`](./main-readme-operational-feature-completeness.md).

## Review rules

- A direct engine test proves only the source-neutral runtime contract.
- A YAML or TypeScript unit test proves only the corresponding authoring
  translator.
- A parity or integration test must exercise compilation into the same runtime
  program.
- An end-to-end test must exercise the transport or control surface claimed by
  the feature.
- Unsupported or plugin-owned capabilities are documented at the owning
  boundary and are not counted as runtime-model features.

The repository verification commands are the evidence gate:

```text
pnpm run verify:check-types
pnpm run verify:no-skips
pnpm run verify:architecture
pnpm exec jest --runInBand
pnpm run test:e2e
```
