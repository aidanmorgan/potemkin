Feature: Ingestion and Command Translation

  Background:
    Given the banking simulator is booted

  Scenario: REQ-12 — Invalid request payload is rejected with contract-violation
    When I send a POST to "/customers/new-id-001" with an invalid body
    Then the response should be a contract violation error

  Scenario: REQ-13 — Identity phase identifies creation vs mutation intent
    Then a POST with identity.creation configured should produce a creation command
    And the created resource should have a generated id

  Scenario: REQ-14 — Command is created from inbound request
    Then a PATCH to an existing resource should be treated as mutation

  Scenario: REQ-15 — Command arrives at the correct boundary
    Then the command should reach the correct boundary

  Scenario: REQ-15b — Created customer persisted via correct boundary routing
    When I create a customer with name "Grace" and email "grace@example.com"
    Then the response status should be 201
    And the customer should be persisted in the state graph
