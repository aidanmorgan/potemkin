Feature: Architectural and Ubiquitous Requirements

  Background:
    Given the banking simulator is booted

  Scenario: REQ-1 — Interface Contract is the authoritative schema source
    When I send "POST /customers/arch-test-001" with body "{ \"name\": \"Bob\", \"email\": \"bob@example.com\" }"
    Then the response status should be 201
    And requests with invalid payload are rejected with 400

  Scenario: REQ-2 — Write model and read model are independent stores
    Then the event store and state graph are separate stores

  Scenario: REQ-3 — Appended events cannot be modified
    When I send "POST /customers/arch-test-003" with body "{ \"name\": \"Eve\", \"email\": \"eve@example.com\" }"
    Then the response status should be 201
    And events in the event log should be frozen

  Scenario: REQ-4 — State changes are traceable to an event
    Then the state graph entity count should match committed events

  Scenario: REQ-5 — DSL rules generate events not direct mutations
    Then DSL rules emit events rather than directly mutating state

  Scenario: REQ-6 — Boundary A can emit secondary command to boundary B
    Then secondary commands can target other boundaries

  Scenario: REQ-7 — Primary and secondary commands form an atomic Unit of Work
    Then all events from the request are committed atomically
