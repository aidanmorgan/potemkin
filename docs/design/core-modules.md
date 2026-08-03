# Core module boundaries

The runtime has one source-independent model and several small collaborators.
The dependency direction is intentionally one-way:

```text
authoring / YAML compilers
          |
          v
   model/compiler  ---------->  model/runtime contracts
                                      |
                                      v
                              RuntimeEngine facade
                              /        |        \
                       policies     UoW       ports
```

`src/core` must not import the YAML DSL, parser, CEL evaluator, or the public
authoring façade. Source compilers produce `RuntimeProgram`; the runtime
executes that canonical model.

## Patterns used

- **Facade and application service:** `RuntimeEngine` owns request sequencing,
  transaction boundaries, lifecycle, and atomic reload. It coordinates work;
  pure policy behavior belongs in collaborators.
- **Ports and implementations:** `RuntimeEventStore`, `RuntimeStateStore`, and
  `RuntimeIdempotencyStore` are ports. `storage.ts` supplies in-memory
  implementations,
  while production integrations can be injected through `RuntimeProgram`.
- **Strategy registry:** query operators and response formats are selected from
  registries in `queryPolicies.ts` and `responsePolicies.ts`. New behavior can be
  added without growing the request orchestration branches.
- **Builder:** `src/model/builders.ts` provides immutable functional builders over the same
  runtime contracts used by direct object authoring.
- **Unit of Work:** the engine's transaction object collects state, events, and
  reaction work before commit; post-commit effects run only after the unit is
  durable.
- **Source compilers:** `src/parser` lowers YAML/CEL and the TypeScript SDK/loader
  lowers direct TypeScript definitions. Both target `RuntimeProgram`; neither
  introduces a source-specific runtime path.

## Rules for future changes

1. Keep contracts in `model/runtime.ts` and source-specific types in their
   source packages.
2. Inject external effects through ports; do not instantiate infrastructure in
   policy functions.
3. Keep query, response, storage, and fault behavior independently testable.
4. Prefer immutable inputs and cloned values at storage boundaries.
5. Add import-boundary tests when introducing a new source compiler or public façade.
6. Keep `RuntimeEngine` as the coordinator; move reusable policy behavior into a
   focused module before adding another branch to the façade.

The executable boundary tests in `tests/unit/core/import-boundary.test.ts` and
`tests/unit/core/no-reexports.test.ts` enforce the most important parts of this
direction.
