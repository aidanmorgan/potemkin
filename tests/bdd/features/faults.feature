Feature: Faults, Concurrency, and Errors

  Background:
    Given the banking simulator is booted

  Scenario: REQ-23 — Boot fails fast on DSL syntax error
    When I attempt to boot the simulator with DSL "boundary: [invalid yaml{"
    Then boot should fail with code "BOOT_ERR_DSL_SYNTAX"

  Scenario: REQ-24 — Invalid request returns 400 CONTRACT_VIOLATION
    When I send a POST to "/customers/req24-test" with an invalid body
    Then the response status should be 400 with code "CONTRACT_VIOLATION"

  Scenario: REQ-25 — Mutation of absent entity returns 404 ENTITY_ABSENCE
    When I PATCH a non-existent loan
    Then the response should be 404 ENTITY_ABSENCE

  Scenario: REQ-26 — Creation of existing entity returns 409 ENTITY_CONFLICT
    Given the seed customer "customer-seed-001" exists in the system
    When I send a creation request targeting an existing entity id
    Then the response should be 409 ENTITY_CONFLICT

  Scenario: REQ-27 — Unmatched command without fallback returns 422 UNHANDLED_OPERATION
    When I send a mutation that has no matching behavior and no fallback
    Then the response should be 422 UNHANDLED_OPERATION

  Scenario: REQ-28 — Stale sequence version returns 412 CONCURRENCY_CONFLICT
    When I send a mutation with a wrong sequence version
    Then the response should be 412 CONCURRENCY_CONFLICT

  Scenario: REQ-29 — Missing required sequence version returns 428 MISSING_PRECONDITION
    When I test missing precondition via direct UoW
    Then the UoW should abort with MISSING_PRECONDITION

  Scenario: REQ-30 — Exception in UoW discards staged events and aborts
    When I trigger a UoW that throws an internal execution error
    Then no events should have been appended

  Scenario: REQ-31 — Fault signal header triggers simulated fault response
    When I send a request with fault signal header returning 503
    Then the response should be the simulated fault
    And the response status should be 503

  Scenario: REQ-32 — Deep cascade returns 508 INFINITE_LOOP
    When I trigger a self-referential cascade that exceeds max depth
    Then the UoW should abort with INFINITE_LOOP
