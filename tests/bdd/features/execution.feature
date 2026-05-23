Feature: Execution, Pattern Matching and State Boundaries

  Background:
    Given the banking simulator is booted

  Scenario: REQ-16 — Pattern matcher evaluates command against behavior rules
    Then the pattern matcher should evaluate the command and produce an event

  Scenario: REQ-17 — Only the first matching rule fires when multiple match
    Then when multiple rules could match, only the first fires

  Scenario: REQ-18 — Rule produces event not direct state write
    Then the state transition should be traceable to a domain event

  Scenario: REQ-19 — Secondary commands from matched rule are staged
    Given a system with cross-boundary DSL configured
    Then creating a source dispatches a secondary command to update the target
