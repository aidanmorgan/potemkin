/**
 * Payload shapes for the /_engine/forward endpoint (design §5).
 *
 * The Kotlin Specmatic plugin POSTs a ForwardedRequest to the Node engine and
 * receives a ForwardedResponse. The engine maps the forwarded request to the
 * existing CQRS/ES pipeline identically to how the HTTP gateway handles an
 * inbound HTTP request.
 */

import type { JsonValue } from '../types.js';
import type { JournalEntry } from '../dsl/patches.js';

/**
 * Payload the Kotlin plugin sends to POST /_engine/forward.
 * All fields mirror the original HTTP request that the Kotlin plugin received.
 */
export interface ForwardedRequest {
  /** HTTP method of the original request: 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'. */
  readonly method: string;
  /** Path of the original request, e.g. '/loans/abc'. No query string. */
  readonly path: string;
  /** Request headers with lowercased keys. */
  readonly headers: Record<string, string>;
  /** Query parameters parsed from the original request URL. */
  readonly query: Record<string, string | string[]>;
  /** Parsed JSON body of the original request, or null if the request had no body. */
  readonly body: JsonValue;
}

/**
 * Response the Node engine returns from POST /_engine/forward.
 * The Kotlin plugin uses this to build the HTTP response it sends back to its caller.
 */
export interface ForwardedResponse {
  /** HTTP status code to return. */
  readonly status: number;
  /** Response headers to set. Keys are lowercase. */
  readonly headers: Record<string, string>;
  /** Response body (the BASE body; response-mutation patches are reported in `_patches`). */
  readonly body: JsonValue;
  /**
   * D4: response-mutation patches (HATEOAS / mask, tagged by source) that the
   * plugin re-applies to the body to produce the client-visible response.
   * Applying these to `body` reproduces the engine's mutated body. Empty when
   * no mutations applied. Deprecation/Sunset/Link are conveyed via `headers`.
   */
  readonly _patches?: readonly JournalEntry[];
}

/**
 * A single deterministic GET-by-id stub produced from a baseline-seeded entity.
 * Shaped so the Kotlin Specmatic plugin can push it directly into Specmatic's stub registry.
 */
export interface FixtureStub {
  readonly httpRequest: {
    /** Always 'GET' — fixtures are deterministic reads (REQ-10/11/39). */
    readonly method: 'GET';
    /** Bound path with the seeded id substituted, e.g. '/customers/00000000-0000-7000-8000-000000000001'. */
    readonly path: string;
    readonly headers?: Record<string, string>;
    readonly queryParameters?: Record<string, string | string[]>;
  };
  readonly httpResponse: {
    /** Typically 200. */
    readonly status: number;
    /** Response headers, always includes content-type. */
    readonly headers: Record<string, string>;
    /** The entity body as it would be returned by a live GET. */
    readonly body: JsonValue;
  };
  readonly source: {
    /** Which boundary this fixture belongs to. */
    readonly boundary: string;
    /** The seeded aggregate id. */
    readonly aggregateId: string;
    /** The OpenAPI path template, e.g. '/customers/{id}'. */
    readonly contractPath: string;
  };
}

/**
 * Response shape for GET /_engine/fixtures.
 * The Kotlin Specmatic plugin calls this endpoint at startup to seed its stub registry.
 */
export interface FixturesResponse {
  /** Engine identifier, always 'potemkin-stateful'. */
  readonly engine: string;
  /** Package version from package.json. */
  readonly version: string;
  /** ISO-8601 timestamp of when this response was generated. */
  readonly generatedAt: string;
  /** SHA-256 hex digest over the serialised stubs sorted by path. Used for ETag / change detection. */
  readonly checksum: string;
  /** The list of fixture stubs derived from baseline-seeded entities. */
  readonly fixtures: readonly FixtureStub[];
}

/**
 * Response shape for GET /_engine/routes.
 * The Kotlin Specmatic plugin calls this endpoint at startup (and periodically)
 * to discover which contract paths the engine owns, without requiring pre-configured
 * path patterns on the plugin side.
 */
export interface RoutesDiscoveryResponse {
  /** Contract paths the engine owns, sorted alphabetically. e.g. ['/customers', '/customers/{id}'] */
  readonly paths: readonly string[];
  /** Engine identifier, always 'potemkin-stateful'. */
  readonly engine: string;
  /** Package version from package.json. */
  readonly version: string;
  /** Suggested cache TTL in seconds for clients. Configurable via ENGINE_ROUTES_TTL_SECONDS env var. */
  readonly ttlSeconds: number;
  /** ISO-8601 timestamp of when this response was generated. */
  readonly generatedAt: string;
  /** SHA-256 hex digest of the sorted paths joined with newlines. Clients can detect path-set changes. */
  readonly checksum: string;
}
