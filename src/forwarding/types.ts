/**
 * Payload shapes for the /_engine/forward endpoint (design §5).
 *
 * The Kotlin Specmatic plugin POSTs a ForwardedRequest to the Node engine and
 * receives a ForwardedResponse. The engine maps the forwarded request to the
 * existing CQRS/ES pipeline identically to how the HTTP gateway handles an
 * inbound HTTP request.
 */

import type { JsonValue } from '../types.js';

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
  /** Response body. */
  readonly body: JsonValue;
}
