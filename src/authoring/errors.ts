import type { JsonValue } from "../types.js";

/** Stable source location attached to TypeScript authoring diagnostics. */
export interface TypeScriptSourceLocation {
  readonly source?: string;
  readonly line?: number;
  readonly column?: number;
}

/** Expected failures produced by the TypeScript SDK and its loader. */
export type TypeScriptDiagnosticCode =
  | "TS_FACTORY_CONFLICT"
  | "TS_FACTORY_INVALID"
  | "TS_DECORATOR_INVALID"
  | "TS_HELPER_INVALID"
  | "TS_REFERENCE_INVALID"
  | "TS_BUILDER_INVALID"
  | "TS_COMPOSITION_CONFLICT"
  | "TS_DEFINITION_INVALID"
  | "TS_SOURCE_READ"
  | "TS_TRANSPILE"
  | "TS_EXECUTION"
  | "TS_IMPORT_FORBIDDEN"
  | "TS_IMPORT_OUTSIDE_SCAN"
  | "TS_CONFIGURATION_INVALID";

export interface TypeScriptAuthoringErrorOptions {
  readonly details?: JsonValue;
  readonly source?: TypeScriptSourceLocation | string;
  readonly cause?: unknown;
}

/**
 * Typed diagnostic contract for TypeScript authoring and loading.
 *
 * The class intentionally extends Error so ordinary callers can still use
 * standard error handling, while `code`, `details`, and `location` provide a
 * stable machine-readable contract for expected failures.
 */
export class TypeScriptAuthoringError extends Error {
  readonly code: TypeScriptDiagnosticCode;
  readonly details?: JsonValue;
  readonly location?: TypeScriptSourceLocation;
  readonly cause?: unknown;

  constructor(
    code: TypeScriptDiagnosticCode,
    message: string,
    options: TypeScriptAuthoringErrorOptions = {},
  ) {
    super(message);
    this.name = "TypeScriptAuthoringError";
    this.code = code;
    this.details = options.details;
    this.location = normalizeLocation(options.source);
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.location === undefined ? {} : { location: this.location }),
    };
  }
}

export function isTypeScriptAuthoringError(error: unknown): error is TypeScriptAuthoringError {
  return error instanceof TypeScriptAuthoringError;
}

export function definitionError(
  message: string,
  options: TypeScriptAuthoringErrorOptions = {},
): TypeScriptAuthoringError {
  return new TypeScriptAuthoringError("TS_DEFINITION_INVALID", message, options);
}

export function helperError(
  message: string,
  options: TypeScriptAuthoringErrorOptions = {},
): TypeScriptAuthoringError {
  return new TypeScriptAuthoringError("TS_HELPER_INVALID", message, options);
}

export function compositionError(
  message: string,
  options: TypeScriptAuthoringErrorOptions = {},
): TypeScriptAuthoringError {
  return new TypeScriptAuthoringError("TS_COMPOSITION_CONFLICT", message, options);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeLocation(
  source: TypeScriptSourceLocation | string | undefined,
): TypeScriptSourceLocation | undefined {
  if (source === undefined) return undefined;
  return typeof source === "string" ? { source } : source;
}
