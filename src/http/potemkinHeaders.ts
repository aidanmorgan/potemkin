/**
 * X-Potemkin-* header constants — well-known simulation control headers.
 *
 * These headers let clients trigger specific simulator behavior from the request
 * itself, without DSL changes per scenario. All headers use the `x-potemkin-`
 * prefix (lowercased; HTTP headers are case-insensitive) so they are obvious
 * in traffic and never collide with real application headers.
 *
 * Two-tier usage in YAML `match:` blocks:
 *   1. Raw form (always available):
 *        headers:
 *          x-potemkin-signal: "rate_limit"
 *   2. Convenience form via `signal:` (preferred for known signals):
 *        signal: rate_limit
 *      which is parsed into `headers: { x-potemkin-signal: "rate_limit" }`.
 *
 * Use the convenience form for signals declared here. Use the raw `headers:`
 * form for ad-hoc or domain-specific headers.
 */

/** Generic catch-all signal header. Value is the signal name (e.g. "rate_limit"). */
export const POTEMKIN_SIGNAL = 'x-potemkin-signal';

/**
 * Outbound-webhook HMAC signature header. Value is `sha256=<hex>` — the hex
 * HMAC-SHA256 of the delivered request body under the webhook's configured
 * secret, so a recipient can recompute and verify it.
 */
export const POTEMKIN_WEBHOOK_SIGNATURE = 'x-potemkin-signature';

/** Force a specific named response variant (e.g. "maintenance", "degraded"). */
export const POTEMKIN_FORCE_RESPONSE = 'x-potemkin-force-response';

/** Force the simulator to behave as if the rate limit has been exceeded. */
export const POTEMKIN_RATE_LIMIT = 'x-potemkin-rate-limit';

/** Toggle a named feature flag for this request (value is the flag name). */
export const POTEMKIN_FEATURE_FLAG = 'x-potemkin-feature-flag';

/** Force a specific HTTP status (value is the desired status as a string). */
export const POTEMKIN_FORCE_STATUS = 'x-potemkin-force-status';

/** Simulate a specific scenario by name (e.g. "slow_db", "stale_cache"). */
export const POTEMKIN_SCENARIO = 'x-potemkin-scenario';

/**
 * Inject latency before the response (integer milliseconds, e.g. "500").
 * Applied in addition to any boundary-level `latency:` config.
 */
export const POTEMKIN_FORCE_LATENCY = 'x-potemkin-force-latency';

/**
 * Force a specific HTTP status (integer, e.g. "503"). Engine returns the
 * configured status with a generic body unless a YAML fault rule also matches
 * via `headers:` — in that case the YAML response takes precedence.
 */
export const POTEMKIN_FORCE_STATUS_CHAOS = 'x-potemkin-force-status';

/**
 * Invoke a named YAML fault rule by name (e.g. "rate-limit-via-header").
 * The engine looks up the rule and applies its response verbatim,
 * regardless of the rule's own match conditions. Useful when you want
 * the YAML to own the response shape but the client to opt in per request.
 */
export const POTEMKIN_USE_FAULT = 'x-potemkin-use-fault';

/**
 * Add uniform-random jitter to the response time. Value is `<min>:<max>` in
 * milliseconds (e.g. `100:500`) or a single int meaning `0:<max>`.
 * Default chaos behaviour: sleep for a uniform-random value in the range.
 */
export const POTEMKIN_JITTER = 'x-potemkin-jitter';

/**
 * Simulate a slow response — alias for fixed latency. Identical to
 * X-Potemkin-Force-Latency but named for chaos-engineering vocabulary.
 * Default chaos behaviour: sleep for the given milliseconds.
 */
export const POTEMKIN_SLOW_RESPONSE = 'x-potemkin-slow-response';

/**
 * Drop the request entirely (no response is sent; the client times out).
 * Default chaos behaviour: hang for the configured number of milliseconds
 * then close the connection without writing any body.
 */
export const POTEMKIN_DROP_CONNECTION = 'x-potemkin-drop-connection';

/**
 * Success rate (0..1 or 0..100 if > 1). When the random gate fires below the
 * threshold the request succeeds; otherwise the engine returns 503.
 * Default chaos behaviour: probabilistic 503.
 */
export const POTEMKIN_SUCCESS_RATE = 'x-potemkin-success-rate';

/**
 * Trigger a class of error response. Recognised values:
 *   "timeout"   → 504 Gateway Timeout
 *   "throttle"  → 429 Too Many Requests + Retry-After
 *   "outage"    → 503 Service Unavailable
 *   "bad_gateway" → 502 Bad Gateway
 *   "conflict"  → 409 Conflict
 *   "auth"      → 401 Unauthorized
 *   "forbidden" → 403 Forbidden
 * YAML rules can match this header to override the default body.
 */
export const POTEMKIN_ERROR_CLASS = 'x-potemkin-error-class';

/**
 * Set the Retry-After header on chaos responses (integer seconds).
 * Combined with X-Potemkin-Error-Class or X-Potemkin-Force-Status.
 */
export const POTEMKIN_RETRY_AFTER = 'x-potemkin-retry-after';

/**
 * Truncate the response body to a maximum number of bytes (network shaping).
 * Default chaos behaviour: serialise the normal body, then slice to N bytes.
 */
export const POTEMKIN_BODY_TRUNCATE = 'x-potemkin-body-truncate';

// ── Tier 1 — Test transparency & determinism ───────────────────────────────

/** Execute the full UoW but DO NOT commit events (state stays unchanged). */
export const POTEMKIN_DRY_RUN = 'x-potemkin-dry-run';
/** Append `_events: [...]` to the response showing events this command produced. */
export const POTEMKIN_INCLUDE_EVENTS = 'x-potemkin-include-events';
/** Append `_debug: {...}` with matched behavior, intent, dispatched secondaries. */
export const POTEMKIN_ECHO = 'x-potemkin-echo';
/** Deterministic seed for $fake()/$uuidv7() in this request. */
export const POTEMKIN_SEED = 'x-potemkin-seed';
/** Per-request `$now()` offset (ms, signed). Additive to admin clock. */
export const POTEMKIN_CLOCK_OFFSET = 'x-potemkin-clock-offset';

// ── Tier 2 — Side-effect control ───────────────────────────────────────────

/** Commit primary events but skip saga triggers. */
export const POTEMKIN_SKIP_SAGAS = 'x-potemkin-skip-sagas';
/** Commit primary events but skip outbound webhook dispatch. */
export const POTEMKIN_SKIP_WEBHOOKS = 'x-potemkin-skip-webhooks';
/** Commit events but skip derived projection application. */
export const POTEMKIN_SKIP_PROJECTIONS = 'x-potemkin-skip-projections';
/** Block secondary command cascading entirely (depth-0 only). */
export const POTEMKIN_SKIP_DISPATCH = 'x-potemkin-skip-dispatch';
/** Override the UoW max cascade depth for this request. */
export const POTEMKIN_MAX_CASCADE_DEPTH = 'x-potemkin-max-cascade-depth';
/** Make a bulk array-body request all-or-nothing (atomic). */
export const POTEMKIN_BULK_TRANSACTIONAL = 'x-potemkin-bulk-transactional';

// ── Tier 3 — Identity & audit override (admin-gated where noted) ───────────

/** Override actor identity for this request: `<id>:<scope1>,<scope2>`. Admin-gated. */
export const POTEMKIN_ACTOR_OVERRIDE = 'x-potemkin-actor';
/** Set the `causedBy` field on this command's emitted events to a specific event id. */
export const POTEMKIN_CAUSED_BY = 'x-potemkin-caused-by';
/** Run as another actor (admin-gated; logs both original + impersonated). */
export const POTEMKIN_IMPERSONATE = 'x-potemkin-impersonate';

// ── Tier 4 — Event sourcing time travel ────────────────────────────────────

/** Query against state as of a specific event sequence version. */
export const POTEMKIN_READ_AT_VERSION = 'x-potemkin-read-at-version';
/** Re-emit a historic event by id (idempotency testing). */
export const POTEMKIN_REPLAY_EVENT = 'x-potemkin-replay-event';

// ── Tier 5 — Response format control ───────────────────────────────────────

/** Choose hypermedia format: `hal` | `jsonapi` | `plain`. */
export const POTEMKIN_RESPONSE_FORMAT = 'x-potemkin-response-format';
/** Override pagination style: `envelope` | `raw` | `link-header`. */
export const POTEMKIN_PAGINATION_STYLE = 'x-potemkin-pagination-style';
/** Redact named fields in response: comma-separated list. */
export const POTEMKIN_MASK = 'x-potemkin-mask';

// ── Tier 6 — Observability injection ───────────────────────────────────────

/** Force the OTel trace ID for this request. */
export const POTEMKIN_TRACE_ID = 'x-potemkin-trace-id';
/** Name the http.request OTel span. */
export const POTEMKIN_SPAN_NAME = 'x-potemkin-span-name';
/** Per-request log level: `debug` | `info` | `warn` | `error`. */
export const POTEMKIN_LOG_LEVEL = 'x-potemkin-log-level';
/** Attach a custom tag to metrics emitted by this request: `key=value`. */
export const POTEMKIN_METRIC_TAG = 'x-potemkin-metric-tag';

// ── Tier 7 — Validation control (admin-gated) ──────────────────────────────

/** Skip OpenAPI request validation for this request. Admin-gated. */
export const POTEMKIN_SKIP_REQUEST_VALIDATION = 'x-potemkin-skip-request-validation';
/** Skip OpenAPI response validation for this request. Admin-gated. */
export const POTEMKIN_SKIP_RESPONSE_VALIDATION = 'x-potemkin-skip-response-validation';
/** Relax `additionalProperties: false` per request. Admin-gated. */
export const POTEMKIN_ALLOW_ADDITIONAL_PROPERTIES = 'x-potemkin-allow-additional-properties';

/**
 * Convenience field name → underlying header name.
 *
 * When YAML uses one of these short names under `match.signal:` or similar
 * shorthand, the parser expands it to the raw header form. Editing this map
 * (and adding a constant above) is the only place new signals need to be
 * registered.
 */
export const POTEMKIN_SIGNAL_ALIASES: Record<string, string> = {
  signal: POTEMKIN_SIGNAL,
  force_response: POTEMKIN_FORCE_RESPONSE,
  rate_limit: POTEMKIN_RATE_LIMIT,
  feature_flag: POTEMKIN_FEATURE_FLAG,
  force_status: POTEMKIN_FORCE_STATUS,
  scenario: POTEMKIN_SCENARIO,
  force_latency: POTEMKIN_FORCE_LATENCY,
  use_fault: POTEMKIN_USE_FAULT,
  jitter: POTEMKIN_JITTER,
  slow_response: POTEMKIN_SLOW_RESPONSE,
  drop_connection: POTEMKIN_DROP_CONNECTION,
  success_rate: POTEMKIN_SUCCESS_RATE,
  error_class: POTEMKIN_ERROR_CLASS,
  retry_after: POTEMKIN_RETRY_AFTER,
  body_truncate: POTEMKIN_BODY_TRUNCATE,
  // Tier 1
  dry_run: POTEMKIN_DRY_RUN,
  include_events: POTEMKIN_INCLUDE_EVENTS,
  echo: POTEMKIN_ECHO,
  seed: POTEMKIN_SEED,
  clock_offset: POTEMKIN_CLOCK_OFFSET,
  // Tier 2
  skip_sagas: POTEMKIN_SKIP_SAGAS,
  skip_webhooks: POTEMKIN_SKIP_WEBHOOKS,
  skip_projections: POTEMKIN_SKIP_PROJECTIONS,
  skip_dispatch: POTEMKIN_SKIP_DISPATCH,
  max_cascade_depth: POTEMKIN_MAX_CASCADE_DEPTH,
  bulk_transactional: POTEMKIN_BULK_TRANSACTIONAL,
  // Tier 3
  actor: POTEMKIN_ACTOR_OVERRIDE,
  caused_by: POTEMKIN_CAUSED_BY,
  impersonate: POTEMKIN_IMPERSONATE,
  // Tier 4
  read_at_version: POTEMKIN_READ_AT_VERSION,
  replay_event: POTEMKIN_REPLAY_EVENT,
  // Tier 5
  response_format: POTEMKIN_RESPONSE_FORMAT,
  pagination_style: POTEMKIN_PAGINATION_STYLE,
  mask: POTEMKIN_MASK,
  // Tier 6
  trace_id: POTEMKIN_TRACE_ID,
  span_name: POTEMKIN_SPAN_NAME,
  log_level: POTEMKIN_LOG_LEVEL,
  metric_tag: POTEMKIN_METRIC_TAG,
  // Tier 7
  skip_request_validation: POTEMKIN_SKIP_REQUEST_VALIDATION,
  skip_response_validation: POTEMKIN_SKIP_RESPONSE_VALIDATION,
  allow_additional_properties: POTEMKIN_ALLOW_ADDITIONAL_PROPERTIES,
};

/**
 * All X-Potemkin-* headers that a client (browser or test tool) may send on an
 * inbound request. This list is the canonical source used to populate the
 * Access-Control-Allow-Headers CORS response header so that browser preflight
 * checks admit every simulation-control header without a wildcard (which the
 * spec disallows).
 *
 * Intentionally excludes POTEMKIN_WEBHOOK_SIGNATURE — that header is emitted
 * by the engine on outbound webhook deliveries, never sent by a client.
 */
export const POTEMKIN_REQUEST_HEADERS: readonly string[] = [
  POTEMKIN_SIGNAL,
  POTEMKIN_FORCE_RESPONSE,
  POTEMKIN_RATE_LIMIT,
  POTEMKIN_FEATURE_FLAG,
  POTEMKIN_FORCE_STATUS,
  POTEMKIN_SCENARIO,
  POTEMKIN_FORCE_LATENCY,
  POTEMKIN_USE_FAULT,
  POTEMKIN_JITTER,
  POTEMKIN_SLOW_RESPONSE,
  POTEMKIN_DROP_CONNECTION,
  POTEMKIN_SUCCESS_RATE,
  POTEMKIN_ERROR_CLASS,
  POTEMKIN_RETRY_AFTER,
  POTEMKIN_BODY_TRUNCATE,
  // Tier 1
  POTEMKIN_DRY_RUN,
  POTEMKIN_INCLUDE_EVENTS,
  POTEMKIN_ECHO,
  POTEMKIN_SEED,
  POTEMKIN_CLOCK_OFFSET,
  // Tier 2
  POTEMKIN_SKIP_SAGAS,
  POTEMKIN_SKIP_WEBHOOKS,
  POTEMKIN_SKIP_PROJECTIONS,
  POTEMKIN_SKIP_DISPATCH,
  POTEMKIN_MAX_CASCADE_DEPTH,
  POTEMKIN_BULK_TRANSACTIONAL,
  // Tier 3
  POTEMKIN_ACTOR_OVERRIDE,
  POTEMKIN_CAUSED_BY,
  POTEMKIN_IMPERSONATE,
  // Tier 4
  POTEMKIN_READ_AT_VERSION,
  POTEMKIN_REPLAY_EVENT,
  // Tier 5
  POTEMKIN_RESPONSE_FORMAT,
  POTEMKIN_PAGINATION_STYLE,
  POTEMKIN_MASK,
  // Tier 6
  POTEMKIN_TRACE_ID,
  POTEMKIN_SPAN_NAME,
  POTEMKIN_LOG_LEVEL,
  POTEMKIN_METRIC_TAG,
  // Tier 7
  POTEMKIN_SKIP_REQUEST_VALIDATION,
  POTEMKIN_SKIP_RESPONSE_VALIDATION,
  POTEMKIN_ALLOW_ADDITIONAL_PROPERTIES,
];

/**
 * Expand a convenience `potemkin:` block in a DSL match into raw header entries.
 *
 * Example input:  `{ rate_limit: "*", scenario: "slow_db" }`
 * Example output: `{ "x-potemkin-rate-limit": "*", "x-potemkin-scenario": "slow_db" }`
 *
 * Unknown alias keys are rejected — return the offender so the caller can throw
 * a useful BootError with context (this module has no dependency on errors).
 */
export function expandPotemkinAliases(
  aliases: Record<string, string>,
): { headers: Record<string, string>; unknown: string[] } {
  const headers: Record<string, string> = {};
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(aliases)) {
    const headerName = POTEMKIN_SIGNAL_ALIASES[key];
    if (headerName === undefined) {
      unknown.push(key);
      continue;
    }
    headers[headerName] = value;
  }
  return { headers, unknown };
}
