import type { JsonValue } from '../contracts/value.js';

/** Neutral contract shared by fixture, transition, and error exporters. */
export interface ExportExample {
  readonly name: string;
  readonly httpRequest: {
    readonly method: string;
    readonly path: string;
    readonly headers?: Record<string, string>;
    readonly body?: JsonValue;
  };
  readonly httpResponse: {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: JsonValue;
  };
}
