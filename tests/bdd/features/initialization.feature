Feature: Initialization and Bootstrapping

  Background:
    Given the banking simulator is booted

  Scenario: REQ-8 — System boot compiles distributed DSL modules into unified execution matrix
    Then the compiled DSL should have at least 2 boundaries
    And each boundary should have behaviors compiled

  Scenario: REQ-9 — DSL boundaries are bound to contract routes
    Then each boundary should reference a valid OpenAPI path
    And the DSL byContractPath index should be populated

  Scenario: REQ-10 — Initialization records become baseline events
    Then the event log should contain baseline events after boot
    And the frozen baseline should be preserved

  Scenario: REQ-11 — State Graph reflects baseline after boot
    Then the state graph should be non-empty after boot
    And the seeded customer should be in the state graph
    And the seeded loan should be in the state graph
