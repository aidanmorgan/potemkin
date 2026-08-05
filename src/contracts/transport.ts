import type { JsonValue } from './value.js';

/** Request envelope crossing the Specmatic transport boundary. */
export interface ForwardedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly query: Record<string, string | string[]>;
  readonly body: JsonValue;
}
