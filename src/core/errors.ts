import type { JsonValue } from '../contracts/value.js';

/** A typed execution failure shared by the core and its transport/parser edges. */
export class RuntimeExecutionError extends Error {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: JsonValue;

  constructor(
    status: number,
    message: string,
    body: JsonValue = { message },
    headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'RuntimeExecutionError';
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}
