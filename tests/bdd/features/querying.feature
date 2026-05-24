Feature: Querying and Read Operations

  Background:
    Given the CRM simulator is booted

  Scenario: REQ-35 — Collection query with filters returns matching subset
    Given there are multiple opportunities with different stages
    When I query the Opportunity boundary with no filters
    Then the query result should be an array
    And the query result should contain at least 1 items

  Scenario: REQ-35b — Pagination directive limits result set
    Given there are multiple opportunities with different stages
    When I query the Opportunity boundary with limit 1
    Then the query result should be an array
    And the query result should contain at most 1 items

  Scenario: REQ-35c — Stage filter returns only matching opportunities
    Given there are multiple opportunities with different stages
    When I query the Opportunity boundary with stage filter "proposed"
    Then the query result should be an array
    And all query result items should have stage "proposed"

  Scenario: REQ-36 — Response includes computed derived property values
    When I GET lead "lead-seed-001"
    Then the response status should be 200
    And the response should contain the derived property "fullContact"
    And the derived property "fullContact" should equal the lead contactName

  Scenario: REQ-36b — Direct query returns derived properties
    Then running a direct query for lead should include derived properties
