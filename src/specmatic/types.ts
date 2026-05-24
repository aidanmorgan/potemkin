/**
 * Specmatic compatibility surface — shared type definitions.
 *
 * These types mirror the Specmatic wire protocol for externalised stubs:
 *  https://docs.specmatic.io/contract_driven_development/service_virtualization
 */

import type { JsonValue } from '../types.js';

export interface ExpectationRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly queryParameters?: Readonly<Record<string, string | string[]>>;
  readonly body?: JsonValue;
}

export interface ExpectationResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: JsonValue;
}

export interface Expectation {
  readonly id: string;                          // UUIDv7
  readonly request: ExpectationRequest;
  readonly response: ExpectationResponse;
  readonly createdAt: string;
  readonly source: 'dynamic' | 'file';
  readonly filePath?: string;                   // when source === 'file'
  readonly transient: boolean;                  // true if registered via /_specmatic/http-stub
  /**
   * Sequenced stub support (T2): when present, `responses` replaces the single `response`.
   * `consumed` tracks how many responses have been served. When consumed >= responses.length
   * the stub is exhausted and will no longer match.
   *
   * The `response` field holds the current (next-to-serve) response for backward compat.
   */
  readonly responses?: readonly ExpectationResponse[];
  consumed?: number;                            // mutable counter — intentionally not readonly
}

export interface MatchResult {
  readonly matched: boolean;
  readonly expectation?: Expectation;
  readonly reasons: readonly string[];          // diagnostic: why each candidate was rejected
}

/**
 * Public interface for the in-memory expectation store returned by createExpectationStore().
 */
export interface ExpectationStore {
  add(
    req: ExpectationRequest,
    res: ExpectationResponse,
    options?: { transient?: boolean; source?: 'dynamic' | 'file'; filePath?: string },
  ): Expectation;
  /**
   * Register a sequenced stub: the same request matcher is bound to an ordered list of responses.
   * The first match consumes resp[0], the second consumes resp[1], etc.
   * Once all responses are consumed the stub is exhausted and no longer matches.
   */
  addSequenced(
    req: ExpectationRequest,
    responses: ExpectationResponse[],
    options?: { source?: 'dynamic' | 'file'; filePath?: string },
  ): Expectation;
  remove(id: string): boolean;
  clear(): void;
  list(): readonly Expectation[];
  match(req: {
    method: string;
    path: string;
    headers: Record<string, string>;
    query: Record<string, string | string[]>;
    body: JsonValue;
  }): MatchResult;
  size(): number;
}
