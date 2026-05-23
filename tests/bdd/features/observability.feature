Feature: Observability — Libraries, Logging, and Tracing

  Background:
    Given the banking simulator is booted

  Scenario: REQ-41 — System boots using pino, ajv, swagger-parser, uuidv7
    Then the system logger should be a pino logger
    And uuidv7 IDs should be used for events
    And the schema registry should be derived from OpenAPI using swagger-parser

  Scenario: REQ-42 — Pino log emitted at boot, UoW, and projection
    Then pino logs should include structured fields
    And a child logger with boundary context should be usable

  Scenario: REQ-43 — OTEL span created per UoW execution
    Then the system tracer should be an OpenTelemetry tracer
    And a UoW execution should record a span
    And the system metrics should include commandsTotal counter
    And the engine metrics should track fault simulations
