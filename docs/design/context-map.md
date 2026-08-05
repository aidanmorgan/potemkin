# Potemkin bounded-context map

This is the ownership map for production TypeScript under `src/`. A module has
one owner: the first path rule that matches it. New production modules must be
placed under an existing owner or added to this document and the architecture
gate before they are used.

| Context                    | Owned paths                                                                                                                    | Input                                   | Output / stable seam                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Foundation contracts       | `types.ts`, `contracts/**`, `errors.ts`, `ids/**`                                                                              | validated primitives                    | JSON/patch values, diagnostics, identifiers, transport-neutral controls                                      |
| Domain primitives          | `domain/**`                                                                                                                    | raw values at parser/transport seams    | branded names, operation/event references, aggregate/event identifiers, JSON paths, response policy lowering |
| Simulation authoring       | `authoring/**`, `sdk/**`                                                                                                       | TypeScript descriptors/builders         | source-neutral authoring descriptors                                                                         |
| YAML/CEL inbound adapter   | `dsl/**`, `cel/**`, `parser/yamlParser.ts`, `parser/yamlCompiler.ts`                                                           | YAML/CEL source                         | YAML descriptors and diagnostics                                                                             |
| TypeScript inbound adapter | `parser/typescript*.ts`, `parser/configuredTypeScript.ts`                                                                      | project TypeScript source               | authoring descriptors and source locations                                                                   |
| Project compilation        | `project/**`, `config.ts`, `parser/config*.ts`, `parser/mixed.ts`, `parser/files.ts`, `parser/gateway.ts`, `parser/runtime.ts` | source descriptors and configuration    | one project snapshot and one `RuntimeDefinition` compilation request                                         |
| Runtime model              | `model/**`, `schema/**`                                                                                                        | source-neutral definitions              | validated immutable `RuntimeProgram`                                                                         |
| Runtime application        | `core/**`, `runtime/**`, `identity/**`, `idempotency/**`, `lifecycle/**`, `observability/**`                                   | `RuntimeProgram` and injected ports     | application use cases and lifecycle outcomes                                                                 |
| Transport and contracts    | `contract/**`, `http/**`, `webhooks/**`                                                                                        | application ports and OpenAPI documents | wire requests, responses, headers, and delivery outcomes                                                     |
| Generation                 | `generation/**`, `openapi/bindings.ts`, `openapi/yamlSchema.ts`, `openapi/scenarioModel.ts`                                    | project snapshot                        | deterministic OpenAPI bindings and YAML/SDK declarations                                                     |
| Tooling and IDE            | `cli/**`, `conformance/**`, `lint/**`, `language-server/**`, `typescript-plugin/**`                                            | project/generation seams                | one CLI command registry, diagnostics, LSP/plugin protocol responses                                         |

Dependency direction is inward toward foundation contracts:

```text
authoring/YAML/TypeScript adapters -> project compilation -> runtime model -> runtime application
generation/tooling/transport adapters -> project/runtime/generation seams
foundation contracts <- every context
domain primitives <- authoring, parser/compiler, runtime model, runtime application
```

The runtime model and runtime application never import authoring, parser, YAML,
CEL, HTTP, CLI, LSP, editor, or Specmatic implementations. The SDK never
imports runtime-model implementation modules; `authoring/compiler.ts` is a
compiler adapter used only by project compilation and tests.
