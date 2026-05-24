import type { Command, DomainEvent, JsonObject } from '../types.js';
import type { Logger } from '../observability/logger.js';

// ---------------------------------------------------------------------------
// ScriptContext shape (REQ-72)
// ---------------------------------------------------------------------------

export interface ScriptHelpers {
  readonly uuid: () => string;       // nextUuidv7
  readonly now: () => string;        // ISO-8601
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
}

// ---------------------------------------------------------------------------
// ScriptHandle — compiled script ready to invoke
// ---------------------------------------------------------------------------

export interface ScriptHandle {
  readonly name: string;
  readonly boundary: string;
  readonly fn: (ctx: ScriptContext) => unknown;
  readonly source: string;
}

// ---------------------------------------------------------------------------
// ScriptRegistry — lookup interface
// ---------------------------------------------------------------------------

export interface ScriptRegistry {
  get(boundary: string, name: string): ScriptHandle | undefined;
  has(boundary: string, name: string): boolean;
  size(): number;
}
