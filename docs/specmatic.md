# Specmatic Integration Guide

This guide explains how to use the engine's Specmatic compatibility surface: the `/_specmatic/*`
admin endpoints, the request-matcher semantics, externalised stub files, and how stubs coexist
with the CQRS/ES pipeline.

The engine is a **stateful CQRS/ES simulation server** that also speaks the Specmatic stub
protocol. This means you can use Specmatic tooling (dynamic expectations, externalised JSON stubs,
the `specmatic.jar` CLI) against the same server that drives your contract-test harness.

For DSL boundary configuration see [docs/dsl.md](dsl.md). For CEL expression semantics see
[docs/cel.md](cel.md).

---

## 1. Overview

### What Specmatic compatibility means here

The engine implements the Specmatic _stub admin surface_: the `/_specmatic/*` HTTP namespace that
Specmatic-compatible stub servers expose. Clients that already know how to talk to a Specmatic
stub server (JVM `HttpStub`, Specmatic CLI `mock` command, or any test library that uses
`POST /_specmatic/expectations`) work against this engine without modification.

On top of that standard surface the engine adds its own CQRS/ES pipeline. Every request that
**does not** match a registered stub is forwarded to the CQRS pipeline, which produces a
deterministic, state-derived response. This is semantically equivalent to Specmatic's _generative
fallback_ mode, but instead of generating a random schema-valid value the engine returns real
aggregate state.

### When to use stubs vs the CQRS DSL

| Use case | Recommendation |
|----------|---------------|
| Pin a specific error response (e.g. 422, 503) for failure-mode testing | Stubs |
| Test a retry sequence (first call fails, second succeeds) | Sequenced stubs |
| Happy-path flows that need consistent state across multiple calls | CQRS pipeline |
| Pre-populate read-model data without driving real commands | File-loaded stubs |
| Role/scope-based access control behaviour | DSL `required_scopes` (see [docs/dsl.md](dsl.md)) |

### Architecture: how stubs and CQRS coexist

```
Inbound HTTP request
        │
        ▼
  Fault simulation header check (x-specmatic-fault)
        │
        ▼
  ┌─────────────────────────────────────┐
  │  Expectation store match (LIFO)     │  ← stubs registered via /_specmatic/*
  │  Does any stub match this request?  │
  └──────────┬──────────────────────────┘
             │ yes                no
             ▼                    ▼
       Stub response        CQRS/ES pipeline
       (no state change)    (full UoW execution)
```

The expectation store is consulted **before** the CQRS pipeline. A matched stub returns the
canned response immediately — no state graph mutation occurs, no event is appended. Only when no
stub matches does the request reach CQRS.

---

## 2. Quick Start

### Boot the engine

```typescript
import { bootSystem } from './src/engine/boot.js';
import { createGateway } from './src/http/gateway.js';
import { loadBankingFixture } from './tests/integration/_helpers/inline-fixture.js';

const fixture = await loadBankingFixture();
const sys = await bootSystem(fixture);
const app = createGateway(sys);
// app is an Express instance; bind it with app.listen() or pass to supertest
```

### Publish a stub via curl

```bash
curl -s -X POST http://localhost:4000/_specmatic/expectations \
  -H 'Content-Type: application/json' \
  -d '{
    "http-request": {
      "method": "GET",
      "path": "/customers/cust-acme-001"
    },
    "http-response": {
      "status": 200,
      "headers": { "Content-Type": "application/json" },
      "body": { "id": "cust-acme-001", "name": "Acme Coffee", "riskBand": "LOW" }
    }
  }'
```

A successful registration returns `200` with the stored expectation object, including its
auto-assigned `id`:

```json
{
  "id": "01934b7f-0e12-7000-8000-0c0a0b0d0e0f",
  "request": { "method": "GET", "path": "/customers/cust-acme-001" },
  "response": { "status": 200, "body": { ... } },
  "createdAt": "2026-05-24T10:00:00.000Z",
  "source": "dynamic",
  "transient": false
}
```

### Make a request that matches

```bash
curl -s http://localhost:4000/customers/cust-acme-001
# → 200 with body { "id": "cust-acme-001", ... }
# Response headers include:
#   X-Specmatic-Result: success
#   X-Specmatic-Expectation-Id: 01934b7f-0e12-7000-8000-0c0a0b0d0e0f
```

### Clear stubs — CQRS generative fallback resumes

```bash
curl -s -X DELETE http://localhost:4000/_specmatic/expectations
# → 200 { "cleared": 1 }

curl -s http://localhost:4000/customers/cust-acme-001
# → 404 (no such entity in CQRS state graph)
```

### Supertest (TypeScript) example

```typescript
import request from 'supertest';

const agent = request(app);

// Register stub
const postRes = await agent
  .post('/_specmatic/expectations')
  .set('Content-Type', 'application/json')
  .send({
    'http-request': { method: 'GET', path: '/customers/cust-acme-001' },
    'http-response': {
      status: 200,
      body: { id: 'cust-acme-001', name: 'Acme Coffee', riskBand: 'LOW' },
    },
  })
  .expect(200);

const expectationId = postRes.body.id as string;

// Verify stub response
const res = await agent.get('/customers/cust-acme-001').expect(200);
expect(res.body.name).toBe('Acme Coffee');
expect(res.headers['x-specmatic-result']).toBe('success');
expect(res.headers['x-specmatic-expectation-id']).toBe(expectationId);

// Clear and verify fallback
await agent.delete('/_specmatic/expectations').expect(200);
await agent.get('/customers/cust-acme-001').expect(404);
```

---

## 3. Endpoint Reference

All `/_specmatic/*` endpoints:
- Return `X-Specmatic-Result: success` on every `2xx` response.
- Return `X-Specmatic-Result: failure` on every `4xx` response.
- Accept and produce `application/json`.

### 3.1 Expectations API

#### `POST /_specmatic/expectations`

Register a permanent (non-transient) stub.

**Request body:**

```json
{
  "http-request": {
    "method": "GET",
    "path": "/loans/loan-x",
    "headers": { "X-Tenant-Id": "tenant-1" },
    "query": { "status": "ACTIVE" },
    "body": { "optional": "request body" }
  },
  "http-response": {
    "status": 200,
    "headers": { "Content-Type": "application/json" },
    "body": { "id": "loan-x", "principal": 50000, "status": "ACTIVE" }
  }
}
```

Top-level keys in the Specmatic wire format:

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `http-request` | object | yes | Request matcher (method + path are required) |
| `http-request.method` | string | yes | HTTP method, case-insensitive |
| `http-request.path` | string | yes | Exact path (no query string) |
| `http-request.headers` | object | no | Header subset matcher |
| `http-request.query` | object | no | Query parameter matcher |
| `http-request.body` | any | no | Body deep-equality matcher; absent = any body |
| `http-response` | object | yes | Canned response |
| `http-response.status` | number | yes | HTTP status code |
| `http-response.headers` | object | no | Response headers to send |
| `http-response.body` | any | no | Response body |

**Response codes:**

| Status | Meaning |
|--------|---------|
| `200` | Stub registered; body contains the stored `Expectation` object with `id` |
| `400 STUB_BODY_INVALID` | Missing or malformed `http-request`/`http-response` fields |
| `400 STUB_VALIDATION_FAILED` | Response body fails OpenAPI contract validation for this path |

> ⚠️ The engine validates the stub's **response** body against the OpenAPI contract for the
> matched path. Stubs that would return a schema-invalid body are rejected with `400
> STUB_VALIDATION_FAILED`. This is a deliberate design choice: every stub response must remain
> on-contract. You cannot register stubs that bypass the OpenAPI schema. See [section 8](#8-generative-fallback)
> for the implications.

#### `GET /_specmatic/expectations`

List all currently registered expectations (dynamic + file-loaded).

**Response:** `200` with a JSON array of `Expectation` objects.

> ℹ️ The upstream Specmatic JVM stub server (`HttpStub.kt`) does **not** implement a GET
> list endpoint. This endpoint is an engine-only extension. It is safe to call from test
> setup/teardown code but should not be depended on for Specmatic CLI interoperability.

#### `DELETE /_specmatic/expectations/:id`

Remove a single expectation by its UUID.

This endpoint is **tolerant**: it always returns `200` regardless of whether an expectation
with that id exists, matching Specmatic JVM `HttpStub` behaviour. This makes test-teardown
cleanup safe even when an expectation has already been removed or was never registered.

**Response:** `200 { "removed": boolean }` — `true` if an expectation was actually deleted,
`false` if no expectation with that id was found. Header `X-Specmatic-Result: success`.

#### `DELETE /_specmatic/expectations`

Remove all registered expectations (both dynamic and file-loaded).

**Response:** `200 { "cleared": <count> }`

#### `POST /_specmatic/expectations/clear`

Alias for `DELETE /_specmatic/expectations`. Some Specmatic client libraries POST to a
`/clear` path; both forms are supported.

**Response:** `200 { "cleared": <count> }`

#### `POST /_specmatic/expectations/sequenced`

Register a sequenced stub: one request matcher bound to an **ordered list** of responses.
Each successive match consumes the next response. After all responses are consumed the stub
is exhausted and no longer matches.

**Request body:**

```json
{
  "http-request": {
    "method": "GET",
    "path": "/customers/retry-target"
  },
  "http-responses": [
    { "status": 503, "body": { "error": "UPSTREAM_TIMEOUT" } },
    { "status": 503, "body": { "error": "UPSTREAM_TIMEOUT" } },
    { "status": 200, "body": { "id": "retry-target", "name": "OK", "riskBand": "LOW" } }
  ]
}
```

Note the key is `http-responses` (plural array), not `http-response`.

**Response:** `200` with the stored `Expectation` object (including `responses[]` and
`consumed: 0`).

**Error codes:** Same `STUB_BODY_INVALID` rules apply; additionally an empty `http-responses`
array returns `400`.

See [section 7](#7-sequenced-stubs) for full semantics.

---

### 3.2 Transient Stubs (`http-stub`)

#### `POST /_specmatic/http-stub`

Register a **transient** stub that is evicted from the store after the first matching request.

Request and response body shape is identical to `POST /_specmatic/expectations`.

**Response:** `200` with `Expectation` object where `transient: true`.

> ℹ️ The `transient` flag is set by the **endpoint used for registration**: posting to
> `/_specmatic/http-stub` always creates a transient stub. Posting to
> `/_specmatic/expectations` always creates a permanent stub.

#### `DELETE /_specmatic/http-stub/:id`

Remove a transient stub (or any stub) by its UUID before it is consumed.

This endpoint is **tolerant**: if the id is not found, it returns `200 { "id": "...", "removed": false }`
rather than `404`. This matches Specmatic's design for test-teardown cleanup where double-deletion
is not an error.

---

### 3.3 State Endpoint

#### `GET /_specmatic/state`

Returns a Gherkin-state-shaped object for Specmatic CLI compatibility. The engine does not
implement Gherkin scenario state; this returns an empty skeleton:

```json
{
  "scenarios": [],
  "expectations": 3,
  "stubs": 3,
  "state": {}
}
```

The `expectations` and `stubs` counts reflect the current expectation store size.

#### `POST /_specmatic/state`

**No-op.** The Specmatic CLI posts Gherkin scenario state here before running contract tests.
The engine accepts and discards the body, returning `200 { "status": "OK" }`.

The engine's actual state lives in the CQRS state graph. To manipulate state from tests,
drive real commands through the CQRS endpoints or use `POST /_admin/reset` to wipe and
re-seed. See [section 9](#9-cqrs-coexistence) for details.

---

### 3.4 Health Endpoints

#### `GET /_specmatic/health`

```json
{ "status": "UP" }
```

`200 OK`. The value `"UP"` (capitalised) matches the Specmatic health-check contract used by
the JVM stub server (`HealthCheckModule.kt`). The engine's own health endpoint at
`GET /_admin/health` returns `{ "status": "ok" }` — note the different casing.

#### `GET /actuator/health`

Identical response to `/_specmatic/health`. This is the Spring Boot actuator alias that the
Specmatic CLI uses as a liveness probe before running `specmatic test`. Both paths are
registered.

---

### 3.5 Response Headers Convention

Every Specmatic-route response (`/_specmatic/*` and `/actuator/health`) carries:

| Header | Values | Meaning |
|--------|--------|---------|
| `X-Specmatic-Result` | `success` \| `failure` | Present on every response |

Every **stub-matched** response on a business route (e.g. `GET /customers/:id`) carries:

| Header | Values | Meaning |
|--------|--------|---------|
| `X-Specmatic-Result` | `success` | Request matched a stub |
| `X-Specmatic-Expectation-Id` | UUID string | ID of the matched expectation |

`X-Specmatic-Warning` is reserved by the Specmatic protocol but is not currently set by the
engine.

---

## 4. Request Matcher Semantics

Source: `src/specmatic/matcher.ts`

### 4.1 Method Matcher

Case-insensitive exact comparison. `"get"`, `"GET"`, `"Get"` all match an incoming `GET`
request.

```typescript
// src/specmatic/matcher.ts:56
export function matchMethod(matcherMethod: string, requestMethod: string): boolean {
  return matcherMethod.toUpperCase() === requestMethod.toUpperCase();
}
```

### 4.2 Path Matcher

**Exact literal string equality.** There is no path-template expansion — `{id}` is not a
wildcard, it is the literal string `{id}`. To match `/customers/123` the matcher path must be
`/customers/123`.

Trailing slash is **significant**: `/customers/ts` does not match `/customers/ts/`. Register
two separate stubs if you need both.

Query strings are stripped from the incoming request path before matching. The path `/customers?riskBand=LOW`
is matched as `/customers`; query parameters are matched separately via the `query` matcher.

```typescript
// src/specmatic/matcher.ts:64
export function matchPath(matcherPath: string, requestPath: string): boolean {
  return matcherPath === requestPath;
}
```

### 4.3 Header Matcher

**Subset match.** All headers declared in the matcher must be present in the request with equal
values. Extra request headers that are not in the matcher are ignored.

Header name comparison is **case-insensitive** (per HTTP spec §3.2). The engine lowercases all
incoming header names before comparison.

**Wildcard values** — a matcher header value equal to any of these strings matches any present
value for that header key:

| Wildcard | Meaning |
|----------|---------|
| `"(anyvalue)"` | Any value; key must be present |
| `"(any)"` | Any value; key must be present |
| `"(string)"` | Any value; key must be present |
| `"*"` | Any value; key must be present |

> ⚠️ A wildcard value does **not** make the key optional. The header must still be present in
> the request. To make a header truly optional use the `?` prefix (below).

**Optional headers** — prefix the header name with `?` to mark it as optional:

```json
"headers": {
  "X-Tenant-Id": "tenant-1",
  "?X-Trace-Id": "(anyvalue)"
}
```

- `X-Tenant-Id` is required with the exact value `"tenant-1"`.
- `?X-Trace-Id` is optional: if absent the matcher still passes; if present the value is
  checked (including wildcard support).

Source: `src/specmatic/matcher.ts:91`

### 4.4 Query Parameter Matcher

Per-key exact equality. Every key declared in the matcher must appear in the request with
matching value(s). Extra request query keys beyond those in the matcher are ignored.

**Array values** are order-sensitive: a matcher declaring `tag: ["a", "b"]` matches
`?tag=a&tag=b` but not `?tag=b&tag=a`.

**Wildcard values** (`(anyvalue)`, `(any)`, `(string)`, `*`) work identically to header
wildcards: the key must be present, but any value is accepted.

```json
{
  "http-request": {
    "method": "GET",
    "path": "/customers",
    "query": { "riskBand": "(anyvalue)", "limit": "*" }
  }
}
```

Source: `src/specmatic/matcher.ts:134`

### 4.5 Body Matcher

**Deep structural equality** when `http-request.body` is present. Object key order is
insensitive; array element order is sensitive.

When `http-request.body` is absent (or `null`) the matcher skips the body check — **any
request body matches**.

```json
{
  "http-request": {
    "method": "POST",
    "path": "/customers",
    "body": { "name": "Alice", "riskBand": "LOW" }
  }
}
```

A request body of `{ "riskBand": "LOW", "name": "Alice" }` (different key order) matches.
A request body of `{ "name": "Bob", "riskBand": "LOW" }` does not match.

#### Type patterns in body leaves

A string value in the matcher body that matches `^\(.*\)$` (parenthesised) or is `*` is
treated as a **type pattern** — it matches the request leaf by type or format rather than
requiring exact string equality. This is opt-in: any string that does not match the pattern
syntax is still compared literally.

| Pattern | Matches request value of |
|---------|--------------------------|
| `(string)` | Any string |
| `(number)` | Any number (integer or float) |
| `(integer)` | Integer number only (no fractional part) |
| `(boolean)` | `true` or `false` |
| `(null)` | `null` |
| `(any)` | Any value, any type |
| `(anyvalue)` | Any value, any type (alias for `(any)`) |
| `*` | Any value, any type (bare wildcard alias) |
| `(uuid)` | String matching UUID format (8-4-4-4-12 hex) |
| `(datetime)` | ISO-8601 datetime string (`YYYY-MM-DDTHH:mm:ssZ`) |
| `(date-time)` | Alias for `(datetime)` |
| `(date)` | ISO date string (`YYYY-MM-DD`) |

Type patterns may appear at **any leaf** in the matcher body; they cannot replace a whole
object or array node. Nested structures are walked recursively: inner leaves may be patterns
while sibling leaves remain exact.

**Example 1 — mixed literal + type pattern:**

```json
{
  "http-request": {
    "method": "POST",
    "path": "/payments",
    "body": {
      "amount":    "(number)",
      "currency":  "AUD",
      "reference": "(string)"
    }
  }
}
```

Matches any body where `amount` is a number, `currency` is exactly `"AUD"`, and `reference`
is any string.

**Example 2 — nested object:**

```json
{
  "http-request": {
    "method": "POST",
    "path": "/transfers",
    "body": {
      "from": { "accountId": "(uuid)", "bsb": "(string)" },
      "amount": "(number)"
    }
  }
}
```

**Example 3 — (any) absorbs any leaf value:**

```json
{
  "http-request": {
    "method": "POST",
    "path": "/customers",
    "body": { "name": "(any)", "riskBand": "(any)" }
  }
}
```

This stub matches any POST /customers body regardless of what values `name` and `riskBand`
hold — equivalent to omitting the body matcher altogether but restricted to bodies that
have exactly those two keys.

Source: `src/specmatic/matcher.ts` — `isTypePattern`, `matchTypePattern`, `matchBody`

### 4.6 Match Precedence

The expectation store evaluates candidates in **LIFO order** (newest stub first). The first
stub that satisfies all five matchers (method, path, headers, query, body) wins. No further
evaluation occurs after a match.

Source: `src/specmatic/expectationStore.ts:103`

```
Store insertion order: [stubA, stubB, stubC]
Match evaluation order: [stubC, stubB, stubA]  ← newest first
```

Static (file-loaded) stubs and dynamic (API-registered) stubs live in the same flat store.
There is no tiered priority between them beyond insertion order.

**Sequenced stubs** that have consumed all their responses are skipped during evaluation and
record a diagnostic reason. Debug logs (set `LOG_LEVEL=debug`) show per-candidate rejection
reasons for every failed match.

---

## 5. Externalised Stub Data

You can pre-populate the expectation store at boot time by pointing the engine at directories
of JSON stub files. This is the Specmatic _externalised examples_ pattern.

### JSON file shape

Each file must contain exactly one request/response pair using the same hyphenated key names
as the `POST /_specmatic/expectations` wire format:

```json
{
  "http-request": {
    "method": "GET",
    "path": "/customers/seed-1"
  },
  "http-response": {
    "status": 200,
    "headers": {
      "Content-Type": "application/json"
    },
    "body": {
      "id": "seed-1",
      "name": "Seed Customer One",
      "riskBand": "LOW"
    }
  }
}
```

The `http-request` object requires `method` (string) and `path` (string). The `http-response`
object requires `status` (number). All other fields are optional.

In the file format, query parameters are declared under `http-request.query` (not
`queryParameters`):

```json
{
  "http-request": {
    "method": "GET",
    "path": "/loans",
    "query": { "status": "ACTIVE" }
  },
  "http-response": {
    "status": 200,
    "body": [{ "id": "loan-001", "status": "ACTIVE" }]
  }
}
```

Files that fail to parse, or that lack required fields, are **silently skipped** — boot still
succeeds. Source: `src/specmatic/loader.ts:59`.

### Directory layout convention

Specmatic's convention is `<contract-name>_examples/` adjacent to the OpenAPI spec:

```
banking.yaml
banking_examples/
    get-customer-low-risk.json
    get-customer-high-risk.json
    create-loan-error.json
```

The engine's loader (`loadExpectationsFromDirectory`) scans directories **recursively**, so
subdirectories are supported:

```
banking_examples/
    customers/
        low-risk.json
    loans/
        active.json
```

### Loading from code

```typescript
import { loadExpectationsFromDirectory } from './src/specmatic/loader.js';

const stubs = await loadExpectationsFromDirectory('./banking_examples');
for (const stub of stubs) {
  sys.expectations.add(stub.request, stub.response, {
    source: 'file',
    filePath: stub.filePath,
  });
}
```

### Loading via `bootSystem` options

```typescript
const sys = await bootSystem({
  ...fixture,
  // Single directory loaded directly:
  specmaticStubDir: './banking_examples',
  // Or via specmaticConfig (see section 6):
  specmaticConfig: {
    stubDirs: ['./banking_examples', './shared_stubs'],
  },
});
```

File-loaded stubs have `source: 'file'` and a `filePath` property. They participate in LIFO
matching alongside dynamic stubs.

---

## 6. `specmatic.yaml` Configuration

The engine reads a `specmatic.yaml` (or `specmatic.json`) file to discover stub directories.
Source: `src/specmatic/config.ts`.

### Supported keys

| Key | Type | Meaning |
|-----|------|---------|
| `stubs` | `string[]` | Stub directory paths (relative to the config file) |
| `mocks` | `string[]` | Alias for `stubs`; both are merged |
| `contracts` | `string[]` | OpenAPI spec paths (informational; engine uses its own DSL spec) |
| `sources[].specifications[]` | `string[]` | Specmatic v2 format; spec paths are extracted |

### Two supported formats

**Legacy flat format** (v1):

```yaml
contracts:
  - api/banking.yaml

stubs:
  - banking_examples
  - shared_stubs/errors

mocks:
  - shared_stubs/edge-cases
```

**New sources[] format** (v2):

```yaml
sources:
  - provider: filesystem
    repository: "."
    specifications:
      - api/banking.yaml
      - api/loans.yaml
```

In the v2 format the `stubs`/`mocks` keys are not read; stub directories must be passed via
`specmaticConfig.stubDirs` in code.

### Example file

See `docs/_examples/specmatic/specmatic.yaml` for a commented example file.

### Wiring from code

```typescript
const sys = await bootSystem({
  ...fixture,
  specmaticConfig: {
    // Path to the specmatic.yaml file
    configPath: './specmatic.yaml',
    // Additional stub dirs beyond those in the YAML (merged at boot)
    stubDirs: ['./extra_stubs'],
  },
});
```

The config file's `stubs[]` paths are resolved **relative to the config file's parent
directory**. If the config is at `/app/specmatic.yaml` and contains `stubs: [banking_examples]`,
the engine scans `/app/banking_examples/`.

Non-existent directories are silently skipped; boot does not fail.

---

## 7. Sequenced Stubs

### When to use

Use sequenced stubs to test multi-call flows such as:
- Retry logic: the first two calls return `503`, the third returns `200`.
- Pagination: each call returns the next page of results.
- Token refresh: first call returns `401`, second (after refresh) returns `200`.

### Endpoint and body shape

```typescript
await agent
  .post('/_specmatic/expectations/sequenced')
  .set('Content-Type', 'application/json')
  .send({
    'http-request': {
      method: 'GET',
      path: '/customers/retry-target',
    },
    'http-responses': [
      { status: 503, body: { error: 'UPSTREAM_TIMEOUT' } },
      { status: 503, body: { error: 'UPSTREAM_TIMEOUT' } },
      { status: 200, body: { id: 'retry-target', name: 'OK', riskBand: 'LOW' } },
    ],
  })
  .expect(200);
```

The key is `http-responses` (plural), not `http-response`. Each element has the same shape as
a single `http-response` object: `status` (required number), `headers` (optional), `body`
(optional).

### Exhaustion semantics

- Call 1 → response index 0 (503)
- Call 2 → response index 1 (503)
- Call 3 → response index 2 (200)
- Call 4 → stub exhausted; request falls through to the CQRS pipeline

Sequenced stubs **do not loop**. Once the response array is consumed the stub is permanently
exhausted and skipped by the matcher. To reset a sequence, delete the expectation and register
a new one.

### Mixing sequenced and regular stubs

Sequenced stubs share the same LIFO store as regular stubs. The newest stub is evaluated first.
A regular stub for the same path registered _after_ a sequenced stub shadows it for every call;
register in the correct order for your test scenario.

---

## 8. Generative Fallback

When no stub matches an incoming request, the request is forwarded to the engine's CQRS/ES
pipeline. This is the _generative fallback_.

### How the CQRS pipeline differs from Specmatic's generative mode

Specmatic's JVM `HttpStub` generates a random schema-valid response by walking the OpenAPI
`Feature` object. The engine's CQRS pipeline instead returns **deterministic, state-derived
responses**: a `GET /customers/:id` returns the actual aggregate state for that entity, or `404`
if the entity does not exist.

This is semantically richer: CQRS responses satisfy the OpenAPI schema AND reflect real
domain state. The trade-off is that a path with no matching stub AND no existing CQRS entity
returns `404` rather than a generated valid-but-random value.

### When to prefer explicit stubs vs CQRS

- Happy-path reads: let CQRS serve from state.
- Error paths (4xx/5xx): register a stub.
- Non-deterministic data: register a stub with a fixed response body.
- Paths outside the DSL: not supported (stubs for paths not in the OpenAPI contract are
  rejected by contract validation).

### No strict-mode rejection

The engine does not implement Specmatic's `--strict` mode. Unmatched requests always fall
through to the CQRS pipeline (or `404` for unknown routes), never to a strict-mode `400` rejection.

---

## 9. CQRS Coexistence

### Stubs intercept before CQRS

The gateway checks the expectation store before dispatching to the CQRS unit of work.
Source: `src/http/gateway.ts:209`.

A stub-matched request **never** reaches the CQRS pipeline. This means:
- No command is executed.
- No event is appended to the event log.
- The state graph is not mutated.

This is intentional: stubs are a test-harness overlay. They exist outside the domain model.

### Stub-matched requests do not modify state

You can register a stub for `POST /customers` and make multiple calls — the state graph will
not grow. Verify this pattern from the integration tests:

```typescript
// tests/integration/specmatic/dynamic-stubs.integration.test.ts:59
it('stub does not mutate the underlying state graph', async () => {
  const graphSizeBefore = sys.graph.size();
  const eventCountBefore = sys.events.size();

  await postExpectation(agent, expectation(
    { method: 'GET', path: '/customers/no-mutation' },
    { status: 200, body: { id: 'no-mutation', name: 'N', riskBand: 'LOW' } },
  )).expect(200);

  await agent.get('/customers/no-mutation').expect(200);

  expect(sys.graph.size()).toBe(graphSizeBefore);
  expect(sys.events.size()).toBe(eventCountBefore);
});
```

### Mixing stubs for failure-mode + CQRS for happy-path

A common test pattern:

1. Let CQRS create the real entity for the happy-path scenario.
2. Register a stub for the same entity's path but with a failure response to test error handling.
3. Clear the stub after the failure test — the CQRS entity remains and is served correctly.

```typescript
// Create a real entity via CQRS
const createRes = await agent
  .post('/loans')
  .send({ customerId: ACME_ID, principal: 5000 })
  .expect(201);
const loanId = createRes.body.id;

// Register a stub to simulate a downstream 503 for that loan
await agent
  .post('/_specmatic/expectations')
  .send({
    'http-request': { method: 'GET', path: `/loans/${loanId}` },
    'http-response': { status: 503, body: { error: 'DOWNSTREAM_UNAVAILABLE' } },
  })
  .expect(200);

// Test your error-handling code
await agent.get(`/loans/${loanId}`).expect(503);

// Clear stubs — CQRS entity is still there
await agent.delete('/_specmatic/expectations').expect(200);
await agent.get(`/loans/${loanId}`).expect(200);
```

### Resetting between scenarios

| Operation | Effect |
|-----------|--------|
| `DELETE /_specmatic/expectations` | Clears stubs; CQRS state untouched |
| `POST /_admin/reset` | Clears CQRS state (events + graph); stubs are NOT cleared |
| Both together | Full reset: clean state, no stubs |

> ⚠️ `POST /_admin/reset` does **not** clear the expectation store. Stubs are part of the
> test harness configuration, not domain state. Always clear stubs explicitly when you need a
> clean stub slate after a reset.

---

## 10. Authentication Context for Stubs

Stubs do **not** respect `Authorization` header actor/scope resolution. The engine's RBAC
machinery (`AuthenticationRequiredError`, `AuthorizationDeniedError`) is part of the CQRS
pipeline, which stub-matched requests never reach.

If a request matches a stub, the canned response is returned regardless of whether the
`Authorization` header is present or valid.

### Asserting Authorization via headers matcher

If you want a stub to only match requests that carry a specific `Authorization` value:

```json
{
  "http-request": {
    "method": "GET",
    "path": "/customers/secured",
    "headers": {
      "Authorization": "Bearer test-token-for-service-a"
    }
  },
  "http-response": {
    "status": 200,
    "body": { "id": "secured", "name": "Secured Customer", "riskBand": "LOW" }
  }
}
```

This matches only requests that carry that exact bearer token. Requests without the header,
or with a different token, fall through to the CQRS pipeline (where real RBAC applies).

### For RBAC behaviour, use DSL scopes

If you need the engine to enforce role-based access control semantics on specific paths, use
the DSL's `required_scopes` boundary configuration (see [docs/dsl.md](dsl.md)). That
configuration applies in the CQRS pipeline, not the stub layer.

---

## 11. Live Specmatic CLI Integration

The engine passes the Specmatic CLI `test` command for OpenAPI specs that cover endpoints
with stable, seeded CQRS data.

### Pinned version

```typescript
// tests/integration/specmatic-cli/_helpers/specmatic-binary.ts:28
export const SPECMATIC_VERSION = '2.46.1';
```

The jar is cached at `tests/integration/specmatic-cli/.cache/specmatic-<version>.jar`
(git-ignored). It is downloaded on first run.

### Running `specmatic test`

```bash
java -jar specmatic.jar test \
  --testBaseURL=http://127.0.0.1:4000 \
  --timeout=10 \
  path/to/banking.yaml
```

The CLI:
1. Probes `GET /actuator/health` — expects `{ "status": "UP" }`. ✅
2. Generates contract-test scenarios from the OpenAPI spec.
3. POSTs to `/_specmatic/expectations` for any externalised examples it finds.
4. Fires the generated requests and validates responses against the spec.

### CLI-compatible spec design

The engine runs Specmatic CLI contract tests reliably when:
- The spec covers endpoints where the engine has **seeded CQRS data** for the generated requests, or
- The spec only tests the list endpoint (which always returns an array, even if empty).

**Limitation: random path parameters.** The Specmatic CLI generates random string/integer
values for path parameters (`/customers/{id}`). These will not match any CQRS entity and
return `404`. The CLI then marks those scenarios as failed.

The fixture at `tests/integration/specmatic-cli/fixtures/banking.yaml` avoids this by only
including `GET /customers` (the collection endpoint) and omitting `GET /customers/{id}`:

```yaml
paths:
  /customers:
    get:
      parameters:
        - name: riskBand
          in: query
          required: false
          schema:
            type: string
      responses:
        "200":
          description: List of customers
```

### Recipe for `npm run test:contract`

Add to `package.json`:

```json
{
  "scripts": {
    "test:contract": "jest --config jest.contract.config.js --testPathPattern specmatic-cli"
  }
}
```

The contract test suite in `tests/integration/specmatic-cli/end-to-end.contract-test.ts`
auto-skips if `java` is not on `PATH`:

```typescript
hasJava = await javaAvailable();
if (!hasJava) {
  console.warn('[end-to-end] Java not found; Specmatic CLI step will be skipped');
}
```

---

## 12. Idempotency, Transient Stubs, and Reset

### Idempotency vs stub eviction ordering

The engine checks the expectation store **after** the fault-simulation header check but
**before** idempotency replay. A transient stub matched on a repeated request (same
`Idempotency-Key`) is evicted on the first match, regardless of whether the idempotency store
has a cached response.

In practice this means: if you register a transient stub and then replay the same request with
the same `Idempotency-Key`, the stub matches and is evicted. The second call (idempotency
replay, stub gone) falls through to the CQRS pipeline where the idempotency cache serves the
stored CQRS response.

For predictable behaviour in tests that use both transient stubs and idempotency keys, clear
the idempotency store between scenarios (via `POST /_admin/reset`) or use permanent stubs
instead.

### `/_admin/reset` does not clear stubs

`POST /_admin/reset` resets the CQRS state graph and event log. It does **not** touch the
expectation store.

```typescript
await agent.post('/_admin/reset').expect(200);
expect(sys.expectations.size()).toBeGreaterThan(0); // stubs survive reset
```

This separation is intentional: the CQRS state is _domain state_ subject to the reset
operation; the stub store is _test-harness configuration_ that persists until explicitly cleared.

---

## 13. Error Codes

### Specmatic-route error codes

All errors on `/_specmatic/*` endpoints return JSON with an `error` field and set
`X-Specmatic-Result: failure`.

| HTTP Status | `error` value | Cause |
|-------------|---------------|-------|
| `400` | `STUB_BODY_INVALID` | Missing or wrong-type fields in the stub registration body |
| `400` | `STUB_VALIDATION_FAILED` | Stub response body fails OpenAPI contract validation |

### Business-route error codes (CQRS pipeline)

These apply when no stub matches and the CQRS pipeline handles the request.

| HTTP Status | `error` value | Cause |
|-------------|---------------|-------|
| `400` | `CONTRACT_VIOLATION` | Request body or query params fail OpenAPI schema |
| `400` | `CONTRACT_VIOLATION / MALFORMED_JSON` | Request body is not valid JSON |
| `404` | `NOT_FOUND` | Aggregate entity does not exist |
| `405` | `METHOD_NOT_ALLOWED` | HTTP method not in OpenAPI spec for this path |
| `404` | `NO_ROUTE` | Path not covered by any OpenAPI contract route |
| `409` | `CONFLICT` | Entity already exists (creation conflict) |
| `412` | `PRECONDITION_FAILED` | `If-Match` ETag mismatch (optimistic concurrency) |
| `422` | `UNHANDLED_OPERATION` | DSL has no handler for this intent |
| `429` | `IDEMPOTENCY_CONFLICT` | Same `Idempotency-Key` used with different request body |
| `500` | `INTERNAL` | Unhandled exception in the pipeline |

---

## 14. Worked End-to-End Example

This walkthrough traces the _full coexistence scenario_ from
`tests/integration/specmatic/cqrs-coexistence.integration.test.ts`.

### Setup

```typescript
const fixture = await loadBankingFixture();
const sys = await bootSystem(fixture);
const app = createGateway(sys);
const agent = request(app); // supertest agent
const ACME_ID = '00000000-0000-7000-8000-000000000001';
```

### Step 1: Register a stub for a path that CQRS cannot serve

```typescript
const stubbedLoan = {
  id: 'loan-x',
  balance: 999999,
  customerId: ACME_ID,
  principal: 999999,
  status: 'STUB',
};

await agent
  .post('/_specmatic/expectations')
  .send({
    'http-request': { method: 'GET', path: '/loans/loan-x' },
    'http-response': { status: 200, body: stubbedLoan },
  })
  .expect(200);
// → 200, response body contains { id: '<uuid>', transient: false, ... }
```

No entity with id `"loan-x"` exists in CQRS — the stub creates an overlay.

### Step 2: Stub response is returned

```typescript
const stubRes = await agent.get('/loans/loan-x').expect(200);
expect(stubRes.body).toEqual(stubbedLoan);
expect(stubRes.headers['x-specmatic-result']).toBe('success');
// X-Specmatic-Expectation-Id is also set
```

The gateway matched the stub, returned the canned body, and did not touch the state graph.

### Step 3: CQRS mutation is unaffected

```typescript
const createRes = await agent
  .post('/loans')
  .send({ customerId: ACME_ID, principal: 5000 })
  .expect(201);
const newLoanId = createRes.body.id; // real CQRS-generated UUID
expect(sys.graph.size()).toBe(graphSizeBefore + 1);
```

The `POST /loans` request matched no stub (the stub is only for `GET /loans/loan-x`), so it
went through the CQRS pipeline and created a real entity.

### Step 4: Stub still shadows its path

```typescript
const stubRes2 = await agent.get('/loans/loan-x').expect(200);
expect(stubRes2.body.id).toBe('loan-x'); // stub still wins
expect(stubRes2.body.id).not.toBe(newLoanId); // not the newly created entity
```

### Step 5: Real CQRS entity is independently accessible

```typescript
const realLoan = await agent.get(`/loans/${newLoanId}`).expect(200);
expect(realLoan.body.principal).toBe(5000);
```

### Step 6: Clear stubs

```typescript
await agent.delete('/_specmatic/expectations').expect(200);
expect(sys.expectations.size()).toBe(0);
```

### Step 7: CQRS fallback resumes for the previously stubbed path

```typescript
await agent.get('/loans/loan-x').expect(404);
// No CQRS entity for "loan-x" → 404 NOT_FOUND
```

---

## 15. Compatibility Matrix

| Specmatic Feature | Support | Notes |
|-------------------|---------|-------|
| `POST /_specmatic/expectations` | ✅ | Wire-format compatible |
| `GET /_specmatic/expectations` | ✅ (extension) | Not in JVM `HttpStub`; engine-only |
| `DELETE /_specmatic/expectations/:id` | ✅ | Always 200; `{ "removed": boolean }` — tolerant like JVM HttpStub |
| `DELETE /_specmatic/expectations` | ✅ | |
| `POST /_specmatic/expectations/clear` | ✅ | Alias for DELETE |
| `POST /_specmatic/expectations/sequenced` | ✅ | Engine extension (T2) |
| `POST /_specmatic/http-stub` | ✅ | Transient stubs |
| `DELETE /_specmatic/http-stub/:id` | ✅ | Tolerant deletion |
| `GET /_specmatic/health` | ✅ | `{"status":"UP"}` |
| `GET /actuator/health` | ✅ | Spring Boot alias |
| `POST /_specmatic/state` | ✅ (no-op) | Accepted and discarded; Gherkin state not implemented |
| `GET /_specmatic/state` | ✅ (stub shape) | Returns empty counters; not real Gherkin state |
| Externalised stub JSON files | ✅ | Via `loadExpectationsFromDirectory` or `bootSystem` options |
| `specmatic.yaml` — `stubs[]` key | ✅ | Paths loaded at boot |
| `specmatic.yaml` — `sources[]` key | ✅ (read-only) | Spec paths extracted; stubs not applicable |
| Header subset match | ✅ | |
| Header wildcards `(anyvalue)` / `*` | ✅ | |
| Optional headers `?Name` | ✅ | Engine extension |
| Query parameter exact match | ✅ | |
| Query parameter wildcards | ✅ | Engine extension |
| Body deep-equality match | ✅ | |
| Body absent = any match | ✅ | |
| Method case-insensitive | ✅ | |
| LIFO match precedence | ✅ | |
| `delay-in-milliseconds` per stub | ❌ | Not implemented |
| Type-pattern matchers `(string)`, `(number)`, etc. | ✅ | Supported in headers, query, and body leaves (see section 4.5) |
| Named capture variables `(VAR:type)` / `$(VAR)` | ❌ | Not implemented |
| `bodyRegex` matcher | ❌ | Not implemented |
| Partial example `"partial": {}` | ❌ | Not implemented |
| `$match(pattern: ...)` syntax | ❌ | Not implemented |
| Strict mode (`--strict`) | ❌ | No equivalent; unmatched requests fall to CQRS |
| `GET /_specmatic/log` | ❌ | JVM-internal diagnostic; not needed |
| `GET /_specmatic/contracts` | ❌ | JVM-internal; not needed |
| `GET /_specmatic/messages` | ❌ | Plugin route in JVM; not implemented |
| Gherkin/Kotlin contract testing | ❌ | Out of scope; use OpenAPI specs |
| Contract diff / backward-compat checks | ❌ | Out of scope |
| WSDL, gRPC, AsyncAPI | ❌ | Out of scope |
| Report generation (`stub_usage_report.json`) | ❌ | Out of scope |
| SSE expectations (`/_specmatic/sse-expectations`) | ❌ | Out of scope |

---

## 16. Limits and Known Issues

**In-memory expectation store.** All registered stubs are held in memory and are lost on
process restart. There is no persistence layer. For long-lived stub fixtures, use file-loaded
stubs via `specmatic.yaml` or `bootSystem({ specmaticConfig: { stubDirs: [...] } })`.

**No watch-mode for `specmatic.yaml`.** The config file is read once at boot. Changes to the
file or to stub directories are not picked up at runtime. Restart the engine to reload.

**Transient stub eviction is per-request, not time-based.** A transient stub remains in the
store indefinitely until a matching request consumes it. There is no TTL mechanism.

**Sequenced stubs do not loop.** When all responses in a sequenced stub are consumed, the stub
is exhausted permanently. It does not wrap around to the first response. Delete and re-register
to reset a sequence.

**Off-contract stubs are strictly rejected.** The engine validates stub response bodies against
the OpenAPI contract. A stub whose response body does not conform to the schema is rejected
with `400 STUB_VALIDATION_FAILED`. This is intentional: the engine will never serve a
response that violates the OpenAPI contract, whether from CQRS or from a stub.

> ⚠️ This differs from the Specmatic JVM `HttpStub`, which allows stubs that go beyond the
> spec. If you are migrating from a Specmatic JVM stub server and your stubs contain
> non-schema-conformant responses, you must fix those stubs to use schema-valid response bodies.

**`DELETE /_specmatic/expectations/:id` returns `404` for unknown ids.** The equivalent
`DELETE /_specmatic/http-stub/:id` is tolerant and returns `200 { removed: false }` for
unknown ids. This asymmetry matches the different intended use cases: `http-stub` deletion is
cleanup code that should not fail teardown; `expectations/:id` deletion is an explicit remove
where a missing id is likely a test logic error.

**No path-template matching in stubs.** The stub path matcher uses exact string equality.
There is no `{id}` wildcard in stub paths. If you need to match all GET requests for any
customer id, you must register one stub per expected id, or use the CQRS pipeline.
