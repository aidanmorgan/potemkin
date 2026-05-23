# Specmatic Stateful Simulation Engine

A high-performance, strictly in-memory middleware that simulates HTTP services declaratively
using OpenAPI contracts and a YAML/CEL behavioral DSL.

## Architecture

The engine enforces **CQRS** (Command Query Responsibility Segregation) and **Event Sourcing**:

- **Write Model (Event Log):** An append-only ledger of immutable Domain Events, indexed via UUIDv7.
- **Read Model (State Graph):** A `Map<TargetId, JsonObject>` continuously projected from events.
- **DSL Behaviors:** YAML-declared rules evaluated by a sandboxed CEL expression engine.
- **Pattern Matcher:** Compares each inbound Command against ordered behavior rules; first match wins.
- **Unit of Work:** Atomic 2PC transaction boundary managing the Shadow Graph and secondary Commands.

## Key Features

- OpenAPI contract validation on every inbound request (400 on violation).
- Deterministic reset via a frozen baseline (`POST /_admin/reset`).
- Fault-simulation signal bypass for chaos testing.
- CEL built-ins (`$uuidv7`, `$now`, `$concat`) with phase-restricted determinism.
- Cross-boundary dispatch with infinite-loop guard (max depth 5).
- Fully ephemeral — all state lives in volatile memory only.
