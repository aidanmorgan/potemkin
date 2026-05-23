Feature: Event Sourcing and CQRS Projections

  Background:
    Given the banking simulator is booted

  Scenario: REQ-20 — Events are appended atomically after UoW completion
    Then all events from the unit of work should be appended atomically
    And no events should be appended if the command fails

  Scenario: REQ-21 — Sequence version advances per appended event
    Then the sequence version for the entity should increment after each event
    And the event should carry the incremented sequence version

  Scenario: REQ-22 — State graph reflects committed event instantly
    Then the state graph should reflect the committed event immediately
    And the state graph should reflect mutation events
