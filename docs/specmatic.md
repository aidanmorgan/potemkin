# Specmatic Integration — Plugin Architecture

The engine no longer ships its own Specmatic-compatible HTTP surface. Contract testing is
now handled via a Kotlin plugin that runs inside the Specmatic **stub** process. The plugin
registers as a Specmatic `StubInitializer` (`com.potemkin.specmatic.PluginInitializer`) and
installs request/response interceptors that forward stubbed requests to the Node engine.
This document describes the plugin model, how to configure it, and what the engine receives
and returns.

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
│                        │ request / response interceptors    │
│  ┌─────────────────────▼───────────────────────────────┐   │
│  │  Potemkin Kotlin Plugin                             │   │
│  │  plugin/src/main/kotlin/com/potemkin/specmatic/...  │   │
│  │  - registered as a StubInitializer (Java SPI)       │   │
│  │  - intercepts each stubbed request                  │   │
│  │  - POSTs to Node engine /_engine/forward endpoint   │   │
│  │  - applies the engine response (+ _patches) back    │   │
│  └────────────────────┬────────────────────────────────┘   │
└───────────────────────┼─────────────────────────────────────┘
                        │ HTTP  POST /_engine/forward
                        ▼
          ┌─────────────────────────────┐
          │  Node Engine  (this repo)   │
          │  - CQRS / ES / DSL / CEL    │
          │  - deterministic state      │
          │  - returns ForwardedResponse│
          └─────────────────────────────┘
```

The Kotlin plugin is loaded by Specmatic via the `META-INF/services` Java SPI mechanism
(`io.specmatic.stub.StubInitializer`). For each request the stub serves, the plugin's
interceptors forward it to the Node engine's `/_engine/forward` endpoint and apply the
returned response (and any `_patches`) before Specmatic performs contract validation.

---

## 2. Running Specmatic with the Plugin

### Prerequisites

- Java 17+
- `specmatic.jar` (tested against Specmatic 2.x)
- The plugin JAR built from `plugin/`
- Node engine running (default port 3000)

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

The plugin registers itself as a Specmatic `StubInitializer` by including the file:

```
plugin/src/main/resources/META-INF/services/io.specmatic.stub.StubInitializer
```

containing the fully-qualified class name of the plugin entrypoint
(`com.potemkin.specmatic.PluginInitializer`). No additional configuration is required for
Specmatic to discover and load the plugin.

### java -cp invocation

To run the Specmatic **stub** server (virtualized API) with the plugin on the classpath:

```bash
java -cp "specmatic.jar:potemkin-plugin.jar" \
  application.SpecmaticApplication \
  stub \
  --port 9000 \
  path/to/nuisance-bureau.yaml
```

This is exactly how the e2e harness launches it (see `tests/e2e/_harness/specmatic-driver.ts`). The plugin intercepts every request the stub serves and forwards it to the Node engine (configured via `potemkin.yaml`, see §3) before Specmatic's default stub behaviour.

---

## 3. Configuration

### Plugin configuration

The plugin is configured from a `potemkin.yaml` file (NOT JVM system properties). It is
resolved in this order (see `PluginConfig.load()` in `plugin/src/main/kotlin/.../PluginConfig.kt`):

1. The path in the `POTEMKIN_CONFIG_PATH` environment variable, if set.
2. `./potemkin.yaml` in the working directory.
3. Built-in defaults if neither is found.

The plugin reads the `plugin:` block:

```yaml
# potemkin.yaml
plugin:
  engine:
    url: "${POTEMKIN_ENGINE_URL:http://localhost:3000}"  # Node engine base URL
    timeoutMs: 30000                                      # per-forward HTTP timeout (ms)
  controlPort: 0                                          # plugin control server port (0 = ephemeral)
  # Optional resilience / health tuning:
  resilience:
    maxRetries: 5
    backoffMs: 100
  healthProbe:
    initialMs: 300
    stableMs: 45000
  discovery:
    refreshOnFailureMs: 8000
```

| Key | Default | Description |
|-----|---------|-------------|
| `plugin.engine.url` | `http://localhost:3000` | Base URL of the Node engine's `/_engine/forward` endpoint |
| `plugin.engine.timeoutMs` | `10000` | HTTP timeout (milliseconds) for each forward call |
| `plugin.controlPort` | `0` | Plugin control server port (`0` = ephemeral) |

Run with an explicit config path:

```bash
POTEMKIN_CONFIG_PATH=/path/to/potemkin.yaml \
  java -cp "specmatic.jar:potemkin-plugin.jar" \
       application.SpecmaticApplication stub --port 9000 path/to/contract.yaml
```

### Path patterns the plugin owns

The plugin handles **all** paths that Specmatic generates from the OpenAPI spec. There is
no path-prefix filtering; the plugin forwards every request Specmatic passes to it.

The Node engine URL (`plugin.engine.url`) must point to the running Node process. The
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
        com/potemkin/specmatic/
          PluginInitializer.kt          ← StubInitializer entrypoint; wires everything
          PotemkinRequestInterceptor.kt ← inbound request interception
          PotemkinResponseInterceptor.kt← outbound response (_patches, Warning header)
          StatefulRequestHandler.kt     ← forwards matched requests to the engine
          CqrsBackendClient.kt          ← HTTP client for the engine /_engine/forward endpoint
          PluginConfig.kt               ← potemkin.yaml parsing (engine.url, timeoutMs, …)
          reliability/HealthMonitor.kt  ← engine health probing
          reliability/FixtureLifecycleManager.kt ← fixture seating lifecycle
      resources/
        META-INF/services/
          io.specmatic.stub.StubInitializer   ← service registration (FQCN of PluginInitializer)
    test/
      kotlin/
        ...                             ← Plugin unit tests
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
