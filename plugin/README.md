# potemkin-stateful-plugin

A Kotlin/Gradle Specmatic plugin that hooks into Specmatic's `RequestHandler` extension point and forwards intercepted HTTP requests to the Potemkin Node CQRS engine. Rather than duplicating Specmatic's stub-matching logic in TypeScript, this plugin lets Specmatic own all API contract validation while the Node engine owns stateful CQRS processing for the paths it declares.

Routes are **discovered at runtime** — no static `pathPatterns` configuration is needed.

---

## Building

```sh
cd plugin
./gradlew clean shadowJar
```

Output: `plugin/build/libs/potemkin-stateful-plugin.jar`

The fat-JAR bundles all transitive dependencies (OkHttp, Jackson, SnakeYAML, SLF4J-API) but deliberately excludes `specmatic-core`, which is provided on the classpath at runtime by Specmatic itself.

---

## Installing

1. **Build or download the JAR** (see above, or grab a release artifact).

2. **Place the JAR next to `specmatic.jar`** (or anywhere on the classpath):
   ```
   ./specmatic.jar
   ./potemkin-stateful-plugin.jar
   ./potemkin-plugin.yaml
   ```

3. **Create `potemkin-plugin.yaml`** in the same directory from which you launch Specmatic.  
   Copy `potemkin-plugin.example.yaml` from the plugin's `src/main/resources/` directory as a starting point:
   ```yaml
   backendUrl: "http://localhost:3000"
   forwardTimeoutMs: 5000
   discoveryRefreshOnFailureMs: 5000
   ```

4. **Start the Specmatic stub server** with the plugin on the classpath:
   ```sh
   java -cp specmatic.jar:potemkin-stateful-plugin.jar \
        io.specmatic.application.ApplicationKt stub \
        --config=specmatic.yaml
   ```
   On Windows, replace `:` with `;` in the classpath.

5. **Start the Node CQRS engine** (in a separate terminal):
   ```sh
   npm run start
   ```
   The engine must expose:
   - `GET  /_engine/routes`   — returns the list of stateful paths to intercept.
   - `POST /_engine/forward`  — handles forwarded requests for those paths.

---

## Route discovery

On startup the plugin calls `GET <backendUrl>/_engine/routes` and builds an in-memory path matcher from the response. The response shape is:

```json
{
  "paths": ["/customers", "/customers/{id}", "/loans"]
}
```

Paths use OpenAPI-style template syntax (`{id}` matches one path segment, equivalent to `*`).

### Refresh cadence

- The route list is cached using the TTL from `Cache-Control: max-age=N` (default: **30 s** if the header is absent).
- On each `isStateful()` call the plugin checks whether the TTL has expired. If so, a **background refresh** is triggered — the request in flight is not blocked.
- The refresh sends an `If-None-Match` header with the last ETag. If the engine returns `304 Not Modified`, the path list is unchanged and the TTL is reset.
- On a **failed refresh** (network error, unexpected status), the stale route list is kept and the next retry is delayed by `discoveryRefreshOnFailureMs` (default: **5 s**).

### Behaviour on startup failure

If the initial `GET /_engine/routes` request fails (engine not yet running, network error), the plugin starts with an empty route list and all requests fall through to Specmatic's own stub matching. Discovery is retried automatically on the next request after the back-off period.

---

## Configuration reference

| Field | Default | Description |
|---|---|---|
| `backendUrl` | `http://localhost:3000` | Base URL of the Node CQRS engine. |
| `forwardTimeoutMs` | `5000` | Timeout (ms) for `POST /_engine/forward` calls. |
| `discoveryRefreshOnFailureMs` | `5000` | Back-off (ms) before retrying discovery after a failed fetch. |

> **Note:** `pathPatterns` is no longer used. If present in an existing config file it is silently ignored (a warning is logged). Remove it to suppress the warning.

---

## Running tests

```sh
cd plugin
./gradlew clean test
```

---

## Troubleshooting

**Plugin not loading (no "Potemkin plugin initialising" log line)**  
The JAR is not on the Specmatic classpath. Verify you are using `-cp specmatic.jar:potemkin-stateful-plugin.jar` (not `-jar specmatic.jar`, which ignores the classpath).

**All requests fall through to Specmatic stubs**  
Check that the Node engine is running and reachable at `backendUrl`. On startup, look for the "initial fetch succeeded" log line. If you see "initial fetch failed", the engine was not available at startup and discovery will retry automatically.

**"Connection refused" in plugin logs**  
The Node engine is not running or is bound to a different port. Start the engine first, or update `backendUrl` in `potemkin-plugin.yaml`.

**ClassNotFoundException for Specmatic classes at build time**  
`specmatic-core` is a `compileOnly` dependency — it is intentionally absent from the fat-JAR. It must be present on the Specmatic runtime classpath (it always is when using `specmatic.jar`).

---

## Design reference

See `docs/specmatic.md` in the parent repository for the full plugin design, extension-point analysis, and end-to-end request flow diagram.
