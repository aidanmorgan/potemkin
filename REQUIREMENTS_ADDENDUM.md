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
