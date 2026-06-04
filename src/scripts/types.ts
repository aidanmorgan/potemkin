import type { Command, DomainEvent, JsonObject, JsonValue } from '../types.js';
import type { Logger } from '../observability/logger.js';

export interface ScriptHelpers {
  readonly uuid: () => string;
  readonly now: () => string;
  readonly deepClone: <T>(v: T) => T;
  readonly deepMerge: (a: JsonObject, b: JsonObject) => JsonObject;
}

export interface ScriptContext {
  readonly command: Command;
  readonly state: JsonObject | null;
  readonly event?: DomainEvent;
  readonly payload: JsonObject;
  readonly helpers: ScriptHelpers;
  readonly logger: Logger;
  /**
   * Present only when the script is invoked as a `response: ts:<id>` transform.
   * The matched OpenAPI operationId and the response the engine computed, which
   * the script may reshape by returning a {@link ResponseScriptResult}.
   */
  readonly operationId?: string;
  readonly response?: { readonly status: number; readonly body: JsonValue | null };
}

/**
 * Return value of a `response: ts:<id>` transform. Any field omitted keeps the
 * engine-computed value, so a script can override just the status (e.g. Stripe's
 * 200-on-create), just the body (e.g. wrap a collection in a list envelope), or
 * both. Returning nothing / a non-object leaves the response untouched.
 */
export interface ResponseScriptResult {
  readonly status?: number;
  readonly body?: JsonValue | null;
}

export interface ScriptHandle {
  readonly name: string;
  readonly boundary: string;
  readonly fn: (ctx: ScriptContext) => unknown;
  readonly source: string;
}

export interface ScriptRegistry {
  get(boundary: string, name: string): ScriptHandle | undefined;
  has(boundary: string, name: string): boolean;
  size(): number;
}
