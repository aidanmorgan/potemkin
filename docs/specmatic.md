# Specmatic Integration — Plugin Architecture

The engine no longer ships its own Specmatic-compatible HTTP surface. Contract testing is
now handled via a Kotlin plugin that runs inside the Specmatic process as a `RequestHandler`
extension. This document describes the plugin model, how to configure it, and what the
engine receives and returns.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Specmatic process  (Java / specmatic.jar)                  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Specmatic contract engine                           │  │
│  │  - loads OpenAPI spec                                │  │
│  │  - generates test scenarios                          │  │
│  │  - validates responses                               │  │
│  └────────────────────┬─────────────────────────────────┘  │
│                        │ RequestHandler.handleRequest()     │
│  ┌─────────────────────▼───────────────────────────────┐   │
│  │  Potemkin Kotlin Plugin                             │   │
│  │  plugin/src/main/kotlin/...                         │   │
│  │  - implements RequestHandler SPI                    │   │
│  │  - translates Specmatic request → HTTP call         │   │
│  │  - POSTs to Node engine /forward endpoint           │   │
│  │  - translates response back to HttpStubResponse     │   │
│  └────────────────────┬────────────────────────────────┘   │
└───────────────────────┼─────────────────────────────────────┘
                        │ HTTP  POST /forward
                        ▼
          ┌─────────────────────────────┐
          │  Node Engine  (this repo)   │
          │  - CQRS / ES / DSL / CEL    │
          │  - deterministic state      │
          │  - returns HttpStubResponse │
          └─────────────────────────────┘
```

The Kotlin plugin is loaded by Specmatic via the `META-INF/services` Java SPI mechanism.
Specmatic calls `handleRequest()` for each test scenario it generates. The plugin forwards
the request to the Node engine's `/forward` endpoint and returns the response to Specmatic
for contract validation.

---

## 2. Running Specmatic with the Plugin

### Prerequisites

- Java 17+
- `specmatic.jar` (tested against Specmatic 2.x)
- The plugin JAR built from `plugin/`
- Node engine running (default port 4000)

### Gradle drop-in

Add the plugin JAR to the Specmatic classpath via Gradle:

```kotlin
// build.gradle.kts
dependencies {
    testImplementation("io.specmatic:specmatic-core:2.+")
    testImplementation(files("path/to/potemkin-plugin.jar"))
}

tasks.test {
    useJUnitPlatform()
}
```

### META-INF/services registration

The plugin registers itself as a Specmatic `RequestHandler` by including the file:

```
plugin/src/main/resources/META-INF/services/io.specmatic.core.RequestHandler
```

containing the fully-qualified class name of the plugin implementation. No additional
configuration is required for Specmatic to discover and load the plugin.

### java -cp invocation

To run Specmatic contract tests directly from the command line:

```bash
java -cp "specmatic.jar:potemkin-plugin.jar" \
  io.specmatic.core.TestRunner \
  --testBaseURL=http://127.0.0.1:4000 \
  path/to/nuisance-bureau.yaml
```

The plugin intercepts all `handleRequest()` calls before Specmatic's default behaviour.

---

## 3. Configuration

### Plugin configuration

The plugin reads a small configuration block, typically supplied via system properties or
an environment variable:

| Property | Default | Description |
|----------|---------|-------------|
| `potemkin.engineUrl` | `http://localhost:4000` | Base URL of the Node engine's `/forward` endpoint |
| `potemkin.timeoutMs` | `10000` | HTTP timeout (milliseconds) for each forward call |

Example:

```bash
java -Dpotemkin.engineUrl=http://localhost:4000 \
     -cp "specmatic.jar:potemkin-plugin.jar" \
     io.specmatic.core.TestRunner ...
```

### Path patterns the plugin owns

The plugin handles **all** paths that Specmatic generates from the OpenAPI spec. There is
no path-prefix filtering; the plugin forwards every request Specmatic passes to it.

The Node engine URL (`potemkin.engineUrl`) must point to the running Node process. The
engine's own contract routes (defined via the DSL `contract_path`) receive the forwarded
requests and return CQRS-derived responses.

---

## 4. Forwarded Request Shape

The plugin converts each Specmatic `HttpRequest` to an HTTP POST sent to the Node engine's
`/forward` endpoint. The body is a JSON object:

```json
{
  "method": "POST",
  "path": "/leads",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer test-token"
  },
  "query": {
    "stage": "negotiating"
  },
  "body": {
    "companyName": "Apex Solutions",
    "contactName": "Alice"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `method` | string | HTTP method, uppercase |
| `path` | string | Path component only (no query string) |
| `headers` | object | Request headers as string-to-string map |
| `query` | object | Query parameters as string-to-string-or-array map |
| `body` | any | Parsed JSON body, or `null` if absent |

---

## 5. Engine Response Shape

The Node engine processes the forwarded request through its full CQRS pipeline and returns
a JSON object shaped to match `HttpStubResponse`:

```json
{
  "status": 200,
  "headers": {
    "Content-Type": "application/json",
    "ETag": "\"3\""
  },
  "body": {
    "id": "lead-001",
    "companyName": "Apex Solutions",
    "contactName": "Alice",
    "status": "new"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | number | HTTP status code |
| `headers` | object | Response headers as string-to-string map |
| `body` | any | JSON response body, or `null` |

The plugin wraps this in a Specmatic `HttpStubResponse` object and returns it to the
Specmatic test runner, which then validates the body against the OpenAPI schema.

---

## 6. Plugin Source Location

The plugin source lives in the `plugin/` directory at the repository root:

```
plugin/
  build.gradle.kts
  src/
    main/
      kotlin/
        au/com/bankwest/potemkin/
          PotemkinRequestHandler.kt   ← RequestHandler implementation
          ForwardClient.kt            ← HTTP client for /forward endpoint
          Config.kt                   ← Configuration (engineUrl, timeoutMs)
      resources/
        META-INF/services/
          io.specmatic.core.RequestHandler
    test/
      kotlin/
        ...                           ← Plugin unit tests
```

The Node engine's `/forward` endpoint is implemented by a separate agent (see the
`wt-engine-fwd` branch). The plugin and the endpoint are developed in parallel.

---

## 7. Compatibility Table

### What Specmatic provides (no longer the engine's concern)

| Specmatic capability | Owner |
|----------------------|-------|
| OpenAPI spec loading and parsing | Specmatic |
| Contract test scenario generation | Specmatic |
| Response schema validation | Specmatic |
| Report generation | Specmatic |
| CLI (`specmatic test`, `specmatic stub`) | Specmatic |
| Gherkin / Kotlin contract DSL | Specmatic |
| WSDL, gRPC, AsyncAPI support | Specmatic |
| `--strict` mode | Specmatic |

### What the Node engine provides

| Engine capability | Description |
|-------------------|-------------|
| CQRS / Event Sourcing pipeline | Stateful domain event processing |
| DSL boundary configuration | YAML-driven behavior rules |
| CEL expression evaluation | Guard conditions, derived properties |
| Schema registry | Runtime and static type checking from OpenAPI |
| Saga orchestration | Multi-step distributed transaction compensation |
| Identity and RBAC | Actor extraction, scope enforcement |
| Idempotency | Key-based request deduplication |
| Derived projections | Aggregated read-model views |
| Fault simulation | `x-specmatic-fault` header bypass |
| Admin endpoints | Reset, state dump, event log, health check |
| OpenTelemetry instrumentation | Spans and metrics for all engine operations |

---

## 8. Admin Endpoints (unchanged)

The engine's `/_admin/*` endpoints remain available for test setup and teardown:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/_admin/reset` | `POST` | Reset CQRS state to post-boot baseline. Returns 204. |
| `/_admin/state` | `GET` | Dump full entity state graph. |
| `/_admin/events` | `GET` | List all events (supports `?aggregateId`, `?limit`, `?offset`). |
| `/_admin/health` | `GET` | Liveness probe with version, uptime, counts. |
| `/_admin/derived/:name` | `GET` | Derived projection state; 404 if unknown. |

If `ADMIN_TOKEN` is set, all admin routes require `Authorization: Bearer <token>`.

For DSL boundary configuration see [docs/dsl.md](dsl.md).
For CEL expression semantics see [docs/cel.md](cel.md).
