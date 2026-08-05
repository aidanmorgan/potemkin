# TypeScript/YAML parity and the shared runtime

Status: canonical-only runtime path implemented.

The migration is forward-only. TypeScript and YAML are authoring inputs; neither
is an execution engine and neither is routed through the other. Both are lowered
to one source-independent `RuntimeProgram`, executed by `RuntimeEngine`, and
served by one generic HTTP gateway.

## Architecture

```text
TypeScript authoring ──┐
                      ├─> RuntimeProgram ──> RuntimeEngine ──> createRuntimeGateway
YAML parser ──────────┘
```

The boundaries are deliberately one-way:

- `src/authoring/compiler.ts` and `src/authoring/resourceModel.ts` define
  the direct TypeScript model.
- `src/parser` reads YAML, validates the YAML grammar, evaluates CEL and
  produces the same `RuntimeProgram` shape. Its linked YAML representation is
  parser-internal and never enters the runtime API.
- `src/core` contains the canonical contracts, compiler, engine, storage and
  policies. It has no dependency on YAML, CEL or parser modules.
- `src/runtime/system.ts` owns the single runtime boot, reload and lifecycle
  surface.
- `src/http/runtimeGateway.ts` is the only HTTP transport for both authoring
  forms. `src/parser/gateway.ts` supplies parser-owned reload and fault-wire
  operations as extensions to that gateway; it does not create another gateway.

## Booting TypeScript

Direct authoring compiles without a YAML round trip:

```ts
import { bootRuntime } from 'potemkin/runtime';
import { createRuntimeGateway } from 'potemkin/http';
import { compileProgram, simulation } from 'potemkin/sdk';

const program = compileProgram(simulation().build(), { dependencies });
const system = await bootRuntime({ openapi, program });
const app = createRuntimeGateway(system);
```

The public builders in `src/authoring/builders.ts` compile through the private
`src/authoring/compiler.ts` boundary:

```ts
const system = await bootRuntime({
  openapi,
  definition: simulation().boundary(order).build(),
});
```

TypeScript authoring uses semantic reference constructors for protocol-facing
identifiers. For example, `boundaryName("Order")`,
`contractPath(pathSegment("orders"), pathParameter("id"))`,
`operationId("createOrder")`, `eventType("OrderCreated")`, and
`fieldPath(field("internalNote"))` produce role-specific values. The runtime
model lowers these to its canonical string fields only at the authoring/model
boundary; YAML continues to use its own textual grammar and both paths retain
the same runtime shape.

## Booting YAML

Inline YAML uses the YAML parser and the same runtime boot and HTTP gateway:

```ts
import { bootYamlRuntime } from 'potemkin/parser/runtime';
import { createRuntimeGateway } from 'potemkin/http';

const system = await bootYamlRuntime({
  openapi,
  yamlProgram: {
    modules: [{ name: 'orders.yaml', yaml: ordersYaml }],
    globalYaml,
  },
});
const app = createRuntimeGateway(system);
```

File-backed YAML uses `bootYamlRuntimeFromConfig`. The config loader returns raw
YAML modules and typed top-level configuration; it does not expose parser IR as
a boot input.

## Shared runtime invariants

Both source compilers must produce equivalent values for equivalent declarations:

- routing, operation IDs, identity and fallback behavior;
- events, reducers, patch application and deterministic seeds;
- query, response, mask, HATEOAS, deprecation and version policies;
- auth, idempotency, faults, reactions, sagas, projections and webhooks;
- lifecycle, observability, forwarding and reset/reload behavior.

The engine validates inbound requests, applies the same transaction and
projection rules, and returns the same transport-neutral result regardless of
the authoring source. The HTTP gateway is responsible only for HTTP parsing,
contract shaping, control headers and the Specmatic transport envelope.

## Reload

`RuntimeSystem.reload` accepts only a `RuntimeProgram`. YAML reload is owned by
the parser gateway extension: it parses and compiles the incoming YAML, then
calls `system.reload`. TypeScript callers compile a new program and call the
same method. The engine replays the retained event log through the replacement
program before making it visible.

## Import boundary

The canonical import closure is enforced by
`tests/unit/core/import-boundary.test.ts` and
`tests/unit/core/no-reexports.test.ts`. The checks ensure that:

- `src/core` cannot import parser, YAML, CEL or source-specific modules;
- direct authoring cannot import parser or CEL;
- the runtime system cannot import parser implementation modules;
- the package exports expose the canonical runtime, parser and gateway entry
  points only;
- no compatibility boot, transport or authoring entry point remains.

## Evidence

The parity coverage is intentionally split by boundary:

- pure TypeScript: `tests/runtime/authoring-typescript.runtime.test.ts` and
  `tests/runtime/typescript-resource.runtime.test.ts`;
- pure YAML: `tests/runtime/authoring-yaml.runtime.test.ts`;
- shared observables: `tests/runtime/pure-authoring-observables.runtime.test.ts`;
- runtime reload and controls: `tests/runtime/runtime-reload.runtime.test.ts`,
  `tests/runtime/runtime-controls.runtime.test.ts`, and the named
  Specmatic-backed E2E suites;
- source-independent unit coverage: `tests/unit/core` and
  `tests/unit/authoring`.

There are no compatibility wrappers, shims, aliases or alternate boot paths in
the source tree.

## §17 — parity inventory and evidence

This is the completed inventory for the parity review. A row is only
complete when the source-independent runtime, YAML projection, TypeScript
authoring path, and the appropriate real Specmatic evidence are all present.

| Feature family                                                              | Canonical evidence                                                                                                                                                                       | Remaining review                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model construction, routing, identity, and fallback                         | `tests/unit/authoring/runtimeParity.test.ts`, `tests/e2e/authoring-parity.e2e-test.ts`                                                                                                   | Add any newly introduced optional/discriminated variants to both constructors and the parity matrix.                                                                                                                                                                                                                                                                                                                                                                      |
| Events, reducers, nested patches, seeds, replay, and reset                  | `tests/unit/core/runtimeEngine.test.ts`, `tests/e2e/reducer-patch-ops.e2e-test.ts`, `tests/e2e/authoring-parity.e2e-test.ts`                                                             | Keep arbitrary-depth JSON values and all patch combinations represented in the source-neutral model.                                                                                                                                                                                                                                                                                                                                                                      |
| Queries, pagination, masks, formats, and HATEOAS                            | `tests/e2e/query-policy-authoring-parity.e2e-test.ts`, `tests/e2e/authoring-parity.e2e-test.ts`, `tests/e2e/bulk-side-effects-authoring-parity.e2e-test.ts`                              | The dedicated Specmatic matrix covers all plain/HAL/JSON:API × envelope/raw/link-header combinations with masking and HATEOAS for YAML, TypeScript, and mixed loading. It also proves the same multi-operation forwarded patch journal is applied to the transport envelope and removed from the caller-facing response across create, read, and update requests, plus a JSON:API alternate-format mask journal on transactional bulk arrays for all three loading modes. |
| Reactions, projections, sagas, dispatch, webhooks, and bulk transactions    | `tests/e2e/bulk-side-effects-authoring-parity.e2e-test.ts`, `tests/e2e/saga-compensation.e2e-test.ts`                                                                                    | Workflow, side-effect, and transactional rollback boundaries are covered; add a new row only for a distinct supported contract.                                                                                                                                                                                                                                                                                                                                           |
| Faults, selectors, latency, chaos, and connection drops                     | `tests/e2e/authoring-parity.e2e-test.ts`, `tests/e2e/configured-admin-faults.e2e-test.ts`, `tests/e2e/chaos-headers.e2e-test.ts`, `tests/runtime/runtime-direct-chaos.runtime.test.ts`   | The real Specmatic matrix proves forwarded drop isolation across the primary/secondary side-effect graph, read-path isolation, fresh-key retry semantics, stacked latency/jitter/shaping/masking/truncation, and named-fault precedence for YAML, TypeScript, static-factory, and mixed loading. Authenticated fault/drop/idempotency precedence is covered by `session-authoring-parity`.                                                                                |
| Authentication, sessions, CSRF, scopes, and consistency                     | `tests/e2e/session-authoring-parity.e2e-test.ts`, `tests/e2e/jwt-auth.e2e-test.ts`, `tests/e2e/rbac.e2e-test.ts`                                                                         | Cookie/CSRF, JWT, RBAC, conditional requests, idempotency, and fault precedence pass across YAML, TypeScript, and mixed loading.                                                                                                                                                                                                                                                                                                                                          |
| Validation, admin controls, observability, and diagnostics                  | `tests/e2e/validation-controls-authoring-parity.e2e-test.ts`, `tests/e2e/admin-surface-authoring-parity.e2e-test.ts`, `tests/e2e/runtime-observability.e2e-test.ts`                      | Validation ordering, admin controls, production OTLP spans, and OTLP metrics for committed, read, faulted, and bulk outcomes pass for YAML, TypeScript, and mixed loading.                                                                                                                                                                                                                                                                                                |
| Configuration discovery, watcher reload, lifecycle, and Specmatic transport | `tests/e2e/configured-source-matrix.e2e-test.ts`, `tests/e2e/query-policy-authoring-parity.e2e-test.ts`, `tests/e2e/fixture-hot-reload.e2e-test.ts`, `tests/e2e/reliability.e2e-test.ts` | `configured-source-matrix` proves automatic watched-source polling and explicit configuration reload; `query-policy-authoring-parity` proves initialized fixture push for YAML, TypeScript, and mixed loading; `fixture-hot-reload` proves true Node process restart with one shared Specmatic JVM. G-25 is closed.                                                                                                                                                       |
| Shared helpers and TypeScript static factories                              | `tests/unit/parser/typescriptFactoryScanner.test.ts`, `tests/e2e/configured-source-matrix.e2e-test.ts`                                                                                   | Maintain AST-based `@PotemkinConfigure` discovery and one helper representation for YAML and TypeScript.                                                                                                                                                                                                                                                                                                                                                                  |

JWT parity is additionally covered by `tests/e2e/jwt-authoring-parity.e2e-test.ts`:
valid scoped tokens preserve actor identity and replay idempotently, invalid
signatures/expiry/missing scopes win before competing chaos controls, and an
authenticated connection drop leaves no event or idempotency reservation before
a healthy commit and replay through YAML, TypeScript, and mixed Specmatic
configurations. The TypeScript model compiler receives the same authentication
implementation through the injected `RuntimeAuthenticationPort` used by the
YAML/runtime composition.

The authoritative operational gap definitions and status are maintained in
[`main-readme-operational-feature-completeness.md`](main-readme-operational-feature-completeness.md).

The latest targeted local verification covers 44 E2E suites and 475 tests,
plus 265 audit tests, with no skipped tests in those runs. The observability
E2E suite asserts the production OTLP/HTTP exporter, final spans, and
source-independent outcome metrics through Specmatic for YAML, TypeScript,
and mixed loading.
