Feature: Querying and Read Operations

  Background:
    Given the banking simulator is booted

  Scenario: REQ-35 — Collection query with filters returns matching subset
    Given there are multiple loans with different statuses
    When I query the LoanAccount boundary with no filters
    Then the query result should be an array
    And the query result should contain at least 1 items

  Scenario: REQ-35b — Pagination directive limits result set
    Given there are multiple loans with different statuses
    When I query the LoanAccount boundary with limit 1
    Then the query result should be an array
    And the query result should contain at most 1 items

  Scenario: REQ-35c — Status filter returns only matching loans
    Given there are multiple loans with different statuses
    When I query the LoanAccount boundary with status filter "pending"
    Then the query result should be an array
    And all query result items should have status "pending"

  Scenario: REQ-36 — Response includes computed derived property values
    When I GET customer "customer-seed-001"
    Then the response status should be 200
    And the response should contain the derived property "fullName"
    And the derived property "fullName" should equal the customer name

  Scenario: REQ-36b — Direct query returns derived properties
    Then running a direct query for customer should include derived properties
