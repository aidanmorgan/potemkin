# Potemkin dependency matrix

The matrix below is the checked-in architectural contract. The automated gate
(`pnpm run verify:architecture`) checks the public facades, source ownership
paths, runtime-model purity, SDK closure, generated root declarations, and the
required evidence files. `pnpm run verify:cleanup` additionally rejects removed
paths, legacy SDK declaration members, leaked implementation symbols, stale
exports, unused modules, and duplicate-code drift.

| Producer                                                                 | May depend on                                                                | Must not depend on                                                                                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Foundation contracts (`src/contracts/**`, source-neutral `src/types.ts`) | standard-library-free contracts                                              | parser, YAML/CEL, HTTP implementation, runtime engine, CLI, LSP, editor, filesystem                 |
| Domain primitives                                                        | foundation; pure validation and value construction                           | parser configuration, transport, authoring builders, runtime engine                                 |
| Simulation authoring SDK                                                 | foundation; authoring descriptors; source-neutral OpenAPI metadata           | RuntimeModel/RuntimeProgram implementation, compiler, RuntimeSystem, parser, OpenAPI loader, HTTP   |
| YAML/CEL adapter                                                         | foundation; DSL/CEL implementation                                           | HTTP gateway, runtime boot, CLI, LSP                                                                |
| Project compiler                                                         | foundation; inbound adapters; runtime-model compiler; generation descriptors | runtime boot and transport implementations                                                          |
| Runtime model/compiler                                                   | foundation; model-owned validation and ports                                 | authoring, parser, YAML/CEL, HTTP, CLI, LSP, Specmatic                                              |
| Runtime application                                                      | runtime model; injected domain ports                                         | authoring, parser, YAML/CEL, HTTP wire adapters, CLI, LSP                                           |
| Transport/integration                                                    | foundation; runtime application ports; contract abstractions                 | authoring builders and parser internals                                                             |
| Generation                                                               | foundation; project snapshot; templates                                      | LSP protocol implementation and runtime engine                                                      |
| Tooling/IDE                                                              | project, generation, runtime/application public seams                        | private model/compiler internals and duplicated parsers; process entrypoints outside `cli/index.ts` |

Every source file is assigned by the path table in
[`context-map.md`](./context-map.md). Cross-context work must use a named
descriptor, port, compiler, translator, or generation service. Direct imports
that bypass those seams are architecture failures, not exceptions to be
hidden with aliases or compatibility barrels.
