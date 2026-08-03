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

All suites in this directory are Specmatic-backed. Feature requests must go to
the `E2eApp.stubUrl`, where the real Specmatic JVM and Kotlin plugin forward
owned routes to the Node engine. The engine URL is reserved for control-plane
inspection and test lifecycle operations such as route discovery, state, and
clock administration.

Lower-level runtime/parser tests that do not need the JVM live under
`tests/runtime/` and use the normal Jest configuration. They are deliberately
not named or configured as E2E suites.

## What gets downloaded automatically

- **Specmatic JAR v2.46.2** — downloaded on first run and cached at `tests/e2e/.cache/specmatic-2.46.2.jar`.

## Test files

| File                    | Description                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `bootstrap`             | Specmatic starts; plugin loads via SPI; control server responds                       |
| `route-discovery`       | Plugin fetches `/_engine/routes`; CRM paths present                                   |
| `fixture-push`          | Seeded entities pushed to Specmatic as expectations                                   |
| `forwarding`            | POST /leads via Specmatic stub → plugin → Node → state mutated                        |
| `cqrs-cascade`          | POST /calls → Lead callIds updated (secondary command dispatch)                       |
| `rbac`                  | DNC without manager scope → 403; with scope → 200                                     |
| `idempotency`           | Same Idempotency-Key returns replay response                                          |
| `reliability`           | Plugin health monitor reacts to engine up/down transitions                            |
| `shutdown-notification` | Engine boot sends /ready; stop sends /shutdown to plugin                              |
| `fixture-hot-reload`    | Restart engine → POST `/_admin/force-reload` → plugin re-fetches fixtures immediately |
| `full-crm-flow`         | Full CRM happy-path: lead → call → qualify → convert → close WON                      |
| `typescript-factory`    | configured TypeScript factory behaviour through Specmatic                             |
| `authoring-parity`      | YAML, TypeScript, and mixed authoring side-effect/response parity through Specmatic   |
| `saga-compensation`     | LeadConversionSaga creates Opportunity on convert                                     |

## Harness files

| File                                  | Purpose                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/conformance/binaries.ts`         | Downloads Specmatic JAR; builds plugin JAR via Gradle                              |
| `src/conformance/portAllocator.ts`    | Allocates ephemeral OS ports via `net.createServer().listen(0)`                    |
| `src/conformance/specmaticProcess.ts` | Spawns Specmatic JVM child process; waits for readiness; SIGTERM on teardown       |
| `engine-driver.ts`                    | Boots Node engine in-process; exposes start/stop/restart                           |
| `e2e-test-app.ts`                     | Combined factory: allocates ports, writes plugin config, starts Specmatic + engine |

## Required runtime

Every Specmatic-backed test requires Java. If `java -version` fails, the suite fails during setup; no E2E suite is silently marked `skip`.

## Port allocation

All three servers (Specmatic stub, Node engine, plugin control) are allocated dynamic ephemeral ports to avoid collisions between concurrent test runners. The plugin config YAML is written to a temp file for each test suite run.

## Timeout

Each test has a 60s timeout. The jest config sets `testTimeout: 60_000` globally. `beforeAll` blocks allow up to 120s for JVM startup.
