# Requirements Addendum

The following requirements extend the original 40 requirements in `requirements.md`.
They were identified during the implementation of cross-cutting concerns (object-graph
schema enforcement and BDD scaffolding).

---

41. **The System shall** be implemented in idiomatic TypeScript using well-known community
    libraries (pino, ajv, swagger-parser, uuidv7, js-yaml, @opentelemetry/*) rather than
    reinventing solved problems.

42. **The System shall** emit structured logs at every major lifecycle event using the `pino`
    logger, with child-logger context for boundary, commandId, eventId, and aggregateId.

43. **The System shall** expose OpenTelemetry tracing (spans for boot, UoW, pattern-match,
    projection, query, HTTP request) and metrics (commandsTotal, commandDurationMs,
    eventsAppendedTotal, uowAbortsTotal, faultsSimulatedTotal).

44. **The System shall** maintain an **Object-Graph Schema Registry** keyed by State Boundary,
    derived from the OpenAPI component schemas at boot.

45. **The System shall** statically validate all DSL operations (behavior conditions, reducer
    assign/append paths, event-catalog payload templates) against the Object-Graph Schema at
    boot; unknown paths or unknown boundaries shall halt boot with
    `BOOT_ERR_DSL_SCHEMA_VIOLATION`.

46. **The System shall** type-check every runtime assignment/append against the Object-Graph
    Schema before applying it to the State Graph; mismatches shall abort the UoW with
    `SCHEMA_TYPE_MISMATCH` (HTTP 500 internal execution failure).

47. **The System shall** provide BDD (Gherkin/Cucumber) tests that prove each numbered
    requirement in `requirements.md` and this addendum.

---

## 11. Expression Language Extensions

The following requirements specify the full CEL expression language implemented in
`src/cel/evaluator.ts` and `src/cel/builtins.ts`.  They extend the three original
built-in functions (`$uuidv7`, `$now`, `$concat`) documented in §8.1 of `design.md`.

48. **The System shall** support list literals of the form `[e1, e2, …]` and map
    literals of the form `{k1: v1, k2: v2, …}` as first-class expression primaries,
    evaluated to JavaScript `Array` and `Object` values respectively. Trailing commas
    shall be accepted in both forms.

49. **The System shall** support null-safe member access (`?.`) and null-safe bracket
    indexing (`?[`) operators; **WHEN** the receiver evaluates to `null` or
    `undefined`, **the System shall** return `null` rather than throwing an error.

50. **The System shall** support the five comprehension macros — `all`, `exists`,
    `exists_one`, `filter`, and `map` — invoked as `list.macro(varName, body)`.
    **WHEN** applied to a map, the macro shall iterate over the map's keys.

51. **The System shall** provide type-conversion functions `int`, `double`, `string`,
    `bool`, and `bytes` that coerce their single argument to the target type; **IF**
    the argument cannot be coerced, **THEN the System shall** throw a
    `CEL_TYPE_ERROR`.

52. **The System shall** provide math functions `abs`, `min`, `max`, `floor`, `ceil`,
    `round`, `pow`, and `sqrt`; **IF** a numeric argument is of the wrong type or if
    `sqrt` receives a negative value, **THEN the System shall** throw a
    `CEL_TYPE_ERROR` or `CEL_RUNTIME_ERROR` respectively.

53. **The System shall** provide collection functions `size`, `keys`, `values`, and
    `range`; `size` shall accept strings, lists, and maps; `keys` and `values` shall
    accept maps only; `range(n)` shall return `[0…n−1]` and `range(start, end)` shall
    return `[start…end−1]`.

54. **The System shall** provide the following receiver-style string methods invoked as
    `str.method(…)`: `startsWith`, `endsWith`, `contains`, `matches`, `replace`,
    `split`, `substring`, `indexOf`, `lastIndexOf`, `lowerAscii`, `upperAscii`,
    `trim`, `trimStart`, `trimEnd`, `charAt`, and `size`.

55. **The System shall** provide the following receiver-style list methods invoked as
    `list.method(…)`: `contains`, `indexOf`, `lastIndexOf`, `sort`, `reverse`, `join`,
    `flatten`, `distinct`, and `size`.

56. **The System shall** provide a `type(x)` function that returns a string
    representation of the runtime type of `x`, returning one of: `"null"`, `"bool"`,
    `"int"`, `"double"`, `"string"`, `"bytes"`, `"list"`, `"map"`, or `"unknown"`.

57. **The System shall** provide null-fallback functions `coalesce(a, b, …)`, which
    returns the first non-null, non-undefined argument, and `default(a, fallback)`,
    which returns `a` if it is non-null, otherwise `fallback`.

58. **WHEN** a CEL expression is evaluated in the Behavior or EventHydration phase,
    **the System shall** permit the date/time functions `timestamp(s)`, `duration(s)`,
    and `now()`; `timestamp` shall validate the ISO-8601 string and return a canonical
    ISO-8601 UTC string; `duration` shall accept ISO 8601 duration strings (e.g.
    `"P1DT2H"`) and simple shorthand strings (e.g. `"30s"`, `"2h"`) and return the
    equivalent millisecond count.

59. **The System shall** implement deep structural equality for the `==` and `!=`
    operators: two values shall be considered equal if and only if they are of the same
    type and all nested fields and elements are recursively equal. No implicit type
    coercion shall be performed between distinct types.

60. **WHEN** any expression is evaluated in the Reducer phase, **the System shall**
    reject calls to non-deterministic built-in functions `$uuidv7`, `$now`, `now`, and
    `timestamp` with a `CEL_PHASE_BANNED` error, ensuring that reducer logic remains
    replay-safe and event-sourcing-deterministic.

---

## 12. DSL Matching Extensions

The following requirements specify the Tier 1 DSL extensions proposed in
`DSL_FEATURE_PROPOSAL.md`.  They are purely additive to the existing DSL schema.

61. **WHEN** a `behaviors[]` entry contains a `match.requires[]` array, **the System
    shall** evaluate each entry's `expression` CEL boolean in document order before
    evaluating `match.condition`; **IF** any expression evaluates to `false`, **THEN
    the System shall** halt processing for that behavior, return HTTP 422, and include
    the entry's `message` field in the error body.  Subsequent behaviors shall not be
    evaluated.

62. **WHEN** a `behaviors[]` entry contains a `postcondition` block, **the System
    shall** evaluate its `expression` CEL boolean against the UoW Shadow Graph
    immediately after the behavior's Domain Event has been projected but before the
    Unit of Work is committed; **IF** the expression evaluates to `false`, **THEN the
    System shall** abort the UoW, discard all staged events, and return
    `POSTCONDITION_VIOLATED` (HTTP 500).

63. **WHEN** a `dispatch_commands[]` entry contains a `condition` CEL expression,
    **the System shall** evaluate that expression against the UoW Shadow Graph at
    dispatch evaluation time; **IF** the expression evaluates to `false`, **THEN the
    System shall** silently skip that secondary command without aborting the Unit of
    Work or altering its outcome.

64. **WHEN** a `behaviors[]` entry contains an `emit_when[]` array, **the System
    shall** evaluate each entry's `when` CEL expression in document order against the
    UoW Shadow Graph at the time of evaluation, projecting each emitted event into the
    Shadow Graph before evaluating subsequent entries; **the System shall** stage the
    corresponding event for all entries whose `when` expression evaluates to `true`.
    An `emit_when` array and a top-level `emit` string shall be mutually exclusive
    within the same behavior entry; the System shall halt boot with
    `BOOT_ERR_DSL_SYNTAX` if both are present.

65. **WHEN** an `event_catalog[]` entry contains a `schema_ref` field, **the System
    shall** resolve the value as an OpenAPI `$ref` path against the bound Interface
    Contract at boot time; **IF** the reference cannot be resolved, **THEN the System
    shall** halt boot with `BOOT_ERR_DSL_SCHEMA_VIOLATION`.  **WHEN** the event is
    materialized at runtime, **the System shall** validate the event payload against
    the resolved schema; **IF** validation fails, **THEN the System shall** abort the
    Unit of Work with `SCHEMA_TYPE_MISMATCH`.

---

## 13. Inline TypeScript Escape Hatch

The following requirements specify the inline TypeScript escape hatch mechanism.
This mechanism permits DSL authors to provide arbitrary TypeScript logic where
CEL expressiveness is insufficient.

66. **The System shall** accept an optional top-level `scripts:` block in a boundary
    configuration file.  Each entry in `scripts:` shall declare a `name` (string,
    unique within the boundary) and a `source` (multiline TypeScript string containing
    a default-exported function).

67. **WHEN** a DSL field that otherwise accepts a CEL expression contains a value with
    the prefix `ts:`, **the System shall** treat the remainder of the value as the
    `name` of an entry in the boundary's `scripts:` block.  The `ts:` sentinel shall
    be permitted wherever a CEL expression is accepted, except in Reducer-phase fields
    (see req. 71).

68. **WHEN** the System boots, **the System shall** transpile each `scripts[].source`
    from TypeScript to JavaScript using `esbuild`'s `transformSync` API with
    `loader: 'ts'`; **IF** transpilation fails due to a syntax error, **THEN the
    System shall** halt initialization and return `BOOT_ERR_SCRIPT_SYNTAX`.

69. **WHEN** a script is invoked at runtime, **the System shall** execute the
    transpiled JavaScript inside a `node:vm` sandbox whose context exposes only a
    restricted set of host objects (a no-op `console.log` and the `ScriptContext`
    argument); no references to `fs`, `net`, `process`, `require`, or `__dirname`
    shall be present in the sandbox context.  **IF** script execution exceeds
    50 milliseconds (configurable), **THEN the System shall** terminate execution and
    return `SCRIPT_TIMEOUT`.

70. **IF** a script throws an unhandled exception during runtime execution, **THEN the
    System shall** abort the active Unit of Work and return
    `INTERNAL_EXECUTION_FAILURE` with the exception message included as diagnostic
    detail.

71. **The System shall** prohibit `ts:` script references in all Reducer-phase DSL
    fields (`reducers[].assign`, `reducers[].append`) to preserve event-sourcing
    determinism and replay safety; **IF** a `ts:` sentinel is encountered in a
    Reducer-phase field, **THEN the System shall** halt boot with
    `BOOT_ERR_DSL_SYNTAX`.

72. **The System shall** provide every invoked script with a `ScriptContext` argument
    of the following shape: `command` (the current Command envelope), `state` (the
    current State Graph node for the target entity), `event` (the Domain Event being
    hydrated, available in EventHydration phase only), `payload` (the materialized
    event payload, available in EventHydration phase only), `helpers` (an object
    exposing `uuidv7()`, `now()`, and `concat(…parts)` convenience functions), and
    `logger` (a scoped pino child-logger).  The `ScriptContext` shape shall constitute
    the canonical contract between the engine and all inline scripts.
