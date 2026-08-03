import type { JsonValue } from "../types.js";
import type { RuntimeHelperDefinition } from "../model/runtime.js";
import { helperError } from "./errors.js";

/** A callable TypeScript helper which can also be registered in the model. */
export interface TypeScriptHelper<
  Args extends readonly JsonValue[] = readonly JsonValue[],
  Output extends JsonValue = JsonValue,
> {
  (...args: Args): Output;
  readonly definition: RuntimeHelperDefinition;
}

/** Structural registration surface used by the simulation builder. */
export type TypeScriptHelperRegistration = Pick<TypeScriptHelper, "definition">;

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function validateHelperName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw helperError(`A TypeScript helper name must be a CEL identifier: "${name}"`);
  }
}

/**
 * Define one pure, typed helper. The returned function is usable directly by
 * TypeScript configuration code and can be registered on a simulation with
 * `.helper()`/`.helpers()` for YAML CEL use.
 */
export function defineHelper<Args extends readonly JsonValue[], Output extends JsonValue>(
  name: string,
  implementation: (...args: Args) => Output,
): TypeScriptHelper<Args, Output> {
  validateHelperName(name);
  if (typeof implementation !== "function") {
    throw helperError(`TypeScript helper "${name}" must be a function`);
  }

  const invoke = (args: readonly JsonValue[]): JsonValue => {
    const value = implementation(...(args as Args));
    if (!isJsonValue(value)) {
      throw helperError(`TypeScript helper "${name}" must return a JSON value`);
    }
    return value;
  };
  const definition: RuntimeHelperDefinition = Object.freeze({ name, invoke });
  const helper = ((...args: Args) => invoke(args) as Output) as TypeScriptHelper<Args, Output>;
  Object.defineProperty(helper, "definition", {
    configurable: false,
    enumerable: false,
    value: definition,
    writable: false,
  });
  return Object.freeze(helper);
}
