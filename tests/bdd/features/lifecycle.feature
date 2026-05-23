Feature: System Reset and Lifecycle

  Background:
    Given the banking simulator is booted

  Scenario: REQ-37 — Reset clears all events from the event log
    Given I have created some entities after boot
    When I trigger a system reset
    Then the reset response status should be 204
    And the event log should only contain baseline events

  Scenario: REQ-38 — Reset clears all entities from the state graph
    When I add entities and then reset the system
    Then the extra entity should no longer exist

  Scenario: REQ-39 — Baseline state is restored after reset
    When I trigger a system reset
    Then the reset response status should be 204
    And the baseline entities should be restored
    And the event log count should equal the frozen baseline count

  Scenario: REQ-40 — No disk writes occur during normal operation
    Then the state graph does not use disk storage
    And the event log does not persist to disk
