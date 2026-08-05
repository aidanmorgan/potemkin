# Typed boundary inventory

The remaining assertions from untyped inputs are deliberate boundary
conversions, not SDK compatibility casts. They are kept out of public
declarations and are validated before the value crosses into a canonical
runtime or authoring contract.

| Boundary                                                                                              | Validation / invariant                                                                                                                 | Destination                                  |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| YAML and JSON roots (`src/parser/*`, `src/config.ts`)                                                 | `unknown` is checked for a non-array object before key access; field validators reject malformed shapes.                               | Parser-owned records and schema contracts    |
| OpenAPI documents (`src/contract/loader.ts`, `src/openapi/*`)                                         | Loader normalizes cloned object records; OpenAPI parsing and operation/schema lookup validate the document before indexing.            | `OpenApiDoc` and generated descriptor inputs |
| TypeScript factory modules (`src/parser/typescriptLoader.ts`, `src/parser/typescriptModuleLoader.ts`) | Factory output is checked for an object and recognized definition collections before it is normalized as `SimulationDefinition`.       | TypeScript authoring compiler                |
| CEL / YAML expressions (`src/parser/yamlCompiler.ts`)                                                 | Parser phase and expression boundary are explicit; evaluated values are constrained to JSON values and runtime predicate signatures.   | Runtime compiler contracts                   |
| OpenTelemetry (`src/observability/*`)                                                                 | OpenTelemetry API objects are supplied by the host or created by the SDK; body capture is bounded and redacted before span attributes. | Observability ports                          |
| Language-server wire values (`src/language-server/*`)                                                 | Semantic model values are converted at the LSP adapter boundary; the SDK and runtime do not import editor protocol types.              | LSP protocol objects                         |

The audit intentionally permits narrow casts at these boundaries because the
source type is `unknown` or a third-party protocol type. Broad `any` records
are prohibited in production loader code; all runtime objects use
`Record<string, unknown>` or a named validated contract. Public SDK files are
checked by the public API and dependency-boundary gates.

Evidence:

- `pnpm exec tsc --noEmit`
- `pnpm exec tsc --project tsconfig.authoring.json`
- `pnpm run verify:architecture`
- `pnpm run verify:public-api`
- `pnpm run verify:cleanup`
- `tests/unit/contracts/foundation.test.ts`
- `tests/unit/audit/dependencyBoundaries.test.ts`
