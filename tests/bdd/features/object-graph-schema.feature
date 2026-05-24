Feature: Object-Graph Schema Registry and Validation

  Background:
    Given the CRM simulator is booted

  Scenario: REQ-44 — Schema registry contains entry for each boundary after boot
    Then the schema registry should contain an entry for each boundary
    And the Lead schema should have the expected properties
    And the Opportunity schema should have the expected properties

  Scenario: REQ-45 — DSL with unknown state path fails boot with BOOT_ERR_DSL_SCHEMA_VIOLATION
    When I attempt to boot with a DSL referencing an unknown state path
    Then boot should fail with BOOT_ERR_DSL_SCHEMA_VIOLATION

  Scenario: REQ-45b — DSL with unknown reducer assign path fails boot
    When I attempt to boot with a DSL referencing an unknown reducer assign path
    Then boot should fail with BOOT_ERR_DSL_SCHEMA_VIOLATION

  Scenario: REQ-46 — Wrong-typed assign value aborts UoW with SCHEMA_TYPE_MISMATCH
    Given a strict-schema boundary with an integer field is booted
    When I send a mutation that assigns a string to the integer field on the strict boundary
    Then the UoW should abort with status 500 and code SCHEMA_TYPE_MISMATCH

  Scenario: REQ-46b — Runtime guard rejects string value for number schema field
    Then the runtime type guard should reject a string value for a number field
    And a valid number value should be accepted by the runtime guard
