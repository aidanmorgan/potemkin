# Requirements

Behavioural requirements for the Specmatic Stateful Simulation Engine, in EARS form.
Each requirement is covered by at least one BDD scenario whose title references its
`REQ-N` number (verified by the traceability scenario in
[`tests/bdd/features/traceability.feature`](tests/bdd/features/traceability.feature)).

## Architecture and write/read model

1. **The System shall** treat the OpenAPI contract as the authoritative schema source.
2. **The System shall** keep the write model (event log) and the read model (state graph) as independent stores.
3. **The System shall** ensure appended events cannot be modified.
4. **The System shall** make every state change traceable to an event.
5. **The System shall** generate events from DSL rules rather than mutating state directly.

## Commands and the Unit of Work

6. **The System shall** allow boundary A to emit a secondary command to boundary B.
7. **The System shall** treat primary and secondary commands as one atomic Unit of Work.
8. **The System shall** compile distributed DSL modules into a unified execution matrix at boot.
9. **The System shall** bind DSL boundaries to their contract routes.
10. **The System shall** turn initialization records into baseline events.
11. **The System shall** reflect the baseline in the state graph after boot.
12. **The System shall** reject an invalid request payload with a contract violation.
13. **The System shall** identify creation versus mutation intent during the identity phase.
14. **The System shall** create a command from an inbound request.
15. **The System shall** route a command to the correct boundary.
16. **The System shall** evaluate a command against the boundary's behavior rules in the pattern matcher.
17. **The System shall** fire only the first matching rule when multiple rules match.
18. **The System shall** have a matched rule produce an event rather than a direct state write.
19. **The System shall** stage secondary commands declared by a matched rule.
20. **The System shall** append events atomically after the Unit of Work completes.
21. **The System shall** advance the sequence version per appended event.
22. **The System shall** reflect a committed event in the state graph instantly.

## Errors and faults

23. **The System shall** fail fast on a DSL syntax error at boot.
24. **The System shall** return 400 CONTRACT_VIOLATION for an invalid request.
25. **The System shall** return 404 ENTITY_ABSENCE for a mutation of an absent entity.
26. **The System shall** return 409 ENTITY_CONFLICT for a creation of an existing entity.
27. **The System shall** return 422 UNHANDLED_OPERATION for an unmatched command with no fallback.
28. **The System shall** return 412 CONCURRENCY_CONFLICT for a stale sequence version.
29. **The System shall** return 428 MISSING_PRECONDITION for a missing required sequence version.
30. **The System shall** discard staged events and abort when an exception occurs in the Unit of Work.
31. **The System shall** return a simulated fault response when the fault signal header is present.
32. **The System shall** return 508 INFINITE_LOOP when a cascade exceeds the maximum depth.

## Queries and fallback

33. **The System shall** return the current entity state via read fallback when no rule matches.
34. **The System shall** generate a generic update event via mutation fallback.
35. **The System shall** return the matching subset for a collection query with filters.
36. **The System shall** include computed derived property values in a response.

## Lifecycle and reset

37. **The System shall** clear all events from the event log on reset.
38. **The System shall** clear all entities from the state graph on reset.
39. **The System shall** restore the baseline state after reset.
40. **The System shall** perform no disk writes during normal operation.

## Observability and schema

41. **The System shall** boot using pino, ajv, swagger-parser, and uuidv7.
42. **The System shall** emit pino logs at boot, Unit of Work, and projection.
43. **The System shall** create an OpenTelemetry span per Unit of Work execution.
44. **The System shall** populate the schema registry with an entry for each boundary after boot.
45. **The System shall** fail boot with BOOT_ERR_DSL_SCHEMA_VIOLATION for a DSL with an unknown state path.
46. **The System shall** abort the Unit of Work with SCHEMA_TYPE_MISMATCH for a wrong-typed reducer value.

## Traceability

47. **The System shall** ensure every requirement has at least one BDD scenario covering it.
