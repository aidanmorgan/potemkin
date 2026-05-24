# End-to-End Test Suite

This directory contains the full e2e test harness that spins up a real Specmatic JVM with the Kotlin plugin JAR loaded alongside the Node engine and exercises every major feature through the real wire.

## Prerequisites

- **Java 17+** on PATH (`java -version` must succeed)
- **Node.js 20+** and `npm install` completed
- **Gradle** available (or the `./gradlew` wrapper inside `plugin/`)

## Quick start

```sh
# Step 1: Build the plugin fat-JAR
cd plugin && ./gradlew shadowJar && cd ..

# Step 2: Run the e2e suite
npm run test:e2e
```

Or use the combined script:

```sh
npm run test:e2e:build
```

## What gets downloaded automatically

- **Specmatic JAR v2.6.0** — downloaded on first run from the GitHub releases page and cached at `tests/e2e/.cache/specmatic-2.6.0.jar`.

## Test files

| File | Description |
|------|-------------|
| `00-bootstrap` | Specmatic starts; plugin loads via SPI; control server responds |
| `01-route-discovery` | Plugin fetches `/_engine/routes`; CRM paths present |
| `02-fixture-push` | Seeded entities pushed to Specmatic as expectations |
| `03-forwarding` | POST /leads via Specmatic stub → plugin → Node → state mutated |
| `04-cqrs-cascade` | POST /calls → Lead callIds updated (secondary command dispatch) |
| `05-rbac` | DNC without manager scope → 403; with scope → 200 |
| `06-idempotency` | Same Idempotency-Key returns replay response |
| `07-reliability` | Plugin health monitor reacts to engine up/down transitions |
| `08-shutdown-notification` | Engine boot sends /ready; stop sends /shutdown to plugin |
| `09-fixture-hot-reload` | Restart engine → plugin re-fetches fixtures on /ready |
| `10-full-crm-flow` | Full CRM happy-path: lead → call → qualify → convert → close WON |
| `11-inline-typescript` | computeScore script sets correct score on lead creation |
| `12-saga-compensation` | LeadConversionSaga creates Opportunity on convert |

## Harness files (`_harness/`)

| File | Purpose |
|------|---------|
| `binary-fetcher.ts` | Downloads Specmatic JAR; builds plugin JAR via Gradle |
| `port-allocator.ts` | Allocates ephemeral OS ports via `net.createServer().listen(0)` |
| `specmatic-driver.ts` | Spawns Specmatic JVM child process; waits for readiness; SIGTERM on teardown |
| `engine-driver.ts` | Boots Node engine in-process; exposes start/stop/restart |
| `e2e-test-app.ts` | Combined factory: allocates ports, writes plugin config, starts Specmatic + engine |

## Skip behaviour

Every test file has a `javaAvailable()` guard. If `java -version` fails, all tests in the file are marked `skip` rather than `fail`. This allows CI without Java to continue without noise.

## Port allocation

All three servers (Specmatic stub, Node engine, plugin control) are allocated dynamic ephemeral ports to avoid collisions between concurrent test runners. The plugin config YAML is written to a temp file for each test suite run.

## Timeout

Each test has a 60s timeout. The jest config sets `testTimeout: 60_000` globally. `beforeAll` blocks allow up to 120s for JVM startup.
