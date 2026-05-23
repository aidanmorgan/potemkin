Feature: Generic Fallbacks

  Background:
    Given the banking simulator is booted

  Scenario: REQ-33 — Read fallback returns current entity state when no rule matches
    When I GET an entity with no specific query rule and fallback enabled
    Then the response should return the entity from the state graph

  Scenario: REQ-33b — GET seed customer returns entity via fallback
    When I GET customer "customer-seed-001"
    Then the response status should be 200
    And the response body field "name" should equal "Alice"

  Scenario: REQ-34 — Mutation fallback generates generic update event
    When I PATCH an entity with no matching behavior but fallback enabled
    Then the response should be a generic update applied to the entity
    And a generic domain event should be appended

  Scenario: REQ-34b — Fallback mutation updates state graph via generic event
    When I PATCH customer "customer-seed-001" to update the name to "Alice Updated"
    Then the response status should be 200
    And the state graph entity "customer-seed-001" should have name "Alice Updated"
