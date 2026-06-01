import type { Command, DomainEvent, JsonObject } from '../types.js';
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
