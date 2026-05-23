Feature: BDD Traceability — Every Requirement Has a Scenario

  @noBoot
  Scenario: REQ-47 — every requirement has at least one BDD scenario covering it
    Given the requirements files at "requirements.md" and "REQUIREMENTS_ADDENDUM.md"
    When I scan the features under "tests/bdd/features"
    Then every requirement number from 1 to 47 should match at least one scenario title
