# Dependency-injection boundaries

Potemkin has one source-independent runtime model. The YAML parser and the
TypeScript SDK/loader compile into that model before the runtime is created.
Runtime behavior receives external effects through ports; it does not discover
process services through module state.

## Explicit composition boundaries

The following direct platform dependencies are deliberate and are kept at
composition boundaries:

| Boundary                               | Direct platform dependency                                  | Why it is allowed                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli/index.ts`                     | process argv/stdout/stderr, command selection               | The single process entrypoint dispatches to typed CLI command APIs.                                                                          |
| `src/cli/server.ts`                    | process environment, default logger/tracer/fetch, bind host | The server command assembles a production host and turns environment values into typed runtime inputs.                                       |
| `src/conformance/cli.ts`               | process environment                                         | The conformance command passes the child-process environment explicitly to Specmatic.                                                        |
| `src/http/bindHost.ts`                 | process environment default                                 | The bind-host resolver also accepts an injected environment for embedding and tests.                                                         |
| `src/runtime/host.ts`                  | wall clock, randomness, native timers                       | This is the default host implementation. `RuntimeHostServices` is injected into the runtime and can be replaced with deterministic services. |
| `src/parser/configuredWatcher.ts`      | native timers                                               | This is the default polling scheduler. The watcher accepts a scheduler port, including a deterministic test scheduler.                       |
| `src/parser/typescriptDiscovery.ts`    | filesystem and glob resolution                              | The default discovery provider is created at the host boundary; scanner tests inject glob and source-reading ports.                          |
| `src/parser/typescriptModuleLoader.ts` | filesystem, TypeScript transpilation, and VM execution      | The default module-loader provider is created at the host boundary; loader tests inject source, transpilation, context, and execution ports. |
| `src/lifecycle/gracefulShutdown.ts`    | native delay                                                | Terminus owns process shutdown at this infrastructure boundary; lifecycle hooks receive their runtime clock and helpers explicitly.          |
| `src/cel/*`                            | wall-clock/random fallbacks                                 | Standalone CEL evaluation has a safe fallback. Runtime compilation supplies the active clock and random source through `BuiltinContext`.     |
| `src/core/engine.ts`                   | standalone delay fallback                                   | A directly constructed minimal `RuntimeProgram` may omit optional delay services; a booted runtime always supplies the host sleep port.      |

Every other runtime, model, parser, TypeScript loader, storage, transport,
observability, and lifecycle dependency is passed through an interface or
factory argument. In particular, factory registration is per load, module
caches are per loader, and no process-global runtime registry exists.

`@PotemkinConfigure` is intentionally static because it is the user-facing
discovery contract. The loader injects the SDK instance used by discovered
factories; the decorator is not a runtime service locator.

## Error boundary

Expected TypeScript authoring and loading failures use
`TypeScriptAuthoringError` with stable codes, structured details, and source
locations where available. Runtime-model and configuration failures use the
corresponding typed error classes. Unexpected factory exceptions are wrapped at
the loader boundary with their original cause retained for diagnostics.

The source tree contains no runtime adapter, shim, compatibility boot path, or
former `@Script` registration surface. YAML and TypeScript both produce the
same `RuntimeProgram` shape before the runtime engine is invoked.

The executable boundary audit is enforced by
`tests/unit/audit/dependencyBoundaries.test.ts`.
