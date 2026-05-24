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
