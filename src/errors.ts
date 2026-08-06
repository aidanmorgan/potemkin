import { isJsonObject, isJsonValue, type JsonValue } from './contracts/value.js';

export abstract class SimError extends Error {
  abstract readonly code: string;
  readonly details?: JsonValue;

  constructor(message: string, details?: JsonValue) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details ?? null,
    };
  }
}

/**
 * Shared mechanics for structured, non-HTTP diagnostics.
 *
 * This base intentionally has different JSON semantics from {@link SimError}:
 * diagnostic details are omitted when absent, rather than represented as
 * `null`. Keeping that distinction here lets authoring and model diagnostics
 * share their error mechanics without coupling their public code contracts to
 * runtime HTTP errors.
 */
export abstract class StructuredError<Code extends string> extends Error {
  abstract readonly code: Code;
  readonly details?: JsonValue;

  constructor(message: string, details?: JsonValue) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

/**
 * Reconstruct a typed SimError from an untrusted JSON value. This is a module
 * operation rather than a static service/factory on the error hierarchy, so
 * error construction has one explicit dependency-free boundary.
 */
export function deserializeSimError(value: unknown): SimError | null {
  if (!isJsonObject(value)) return null;
  const json = value;
  const code = json['code'];
  const message = typeof json['message'] === 'string' ? json['message'] : String(code ?? 'unknown');
  const details = isJsonValue(json['details']) ? json['details'] : undefined;

  switch (code) {
    case 'CONTRACT_VIOLATION':
      return new ContractViolationError(message, details);
    case 'ENTITY_ABSENCE':
      return new EntityAbsenceError(message, details);
    case 'ENTITY_CONFLICT':
      return new EntityConflictError(message, details);
    case 'UNHANDLED_OPERATION':
      return new UnhandledOperationError(message, details);
    case 'CONCURRENCY_CONFLICT':
      return new ConcurrencyConflictError(message, details);
    case 'MISSING_PRECONDITION':
      return new MissingPreconditionError(message, details);
    case 'INTERNAL_EXECUTION_ERROR':
      return new InternalExecutionError(message, details);
    case 'INFINITE_LOOP':
      return new InfiniteLoopError(message, details);
    case 'REACTION_BUDGET_EXCEEDED':
      return new ReactionBudgetExceededError(message, details);
    case 'FAULT_SIMULATED': {
      const status = typeof json['status'] === 'number' ? json['status'] : 500;
      const simulatedBody = isJsonValue(json['simulatedBody']) ? json['simulatedBody'] : null;
      const simulatedHeaders = stringMap(json['simulatedHeaders']);
      return new FaultSimulatedError(status, simulatedBody, simulatedHeaders, details);
    }
    case 'AUTH_MISSING':
      return new AuthenticationRequiredError(message, details);
    case 'AUTH_INSUFFICIENT_SCOPES':
      return new AuthorizationDeniedError(message, details);
    case 'IDEMPOTENCY_KEY_CONFLICT':
      return new IdempotencyConflictError(message, details);
    case 'CONFIG_INVALID':
      return new ConfigurationError(message, details);
    case 'EXPORT_INVALID':
      return new ExportError(message, details);
    case 'SESSION_LIMIT_EXCEEDED': {
      const maxSessions = isJsonObject(details) ? details['maxSessions'] : undefined;
      return new SessionLimitError(typeof maxSessions === 'number' ? maxSessions : 0, message);
    }
    default:
      return null;
  }
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isJsonObject(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return undefined;
    result[key] = entry;
  }
  return result;
}

// Boot-time error — no HTTP status (thrown before server starts)
export class BootError extends SimError {
  readonly code: string;

  constructor(
    code:
      | 'BOOT_ERR_DSL_SYNTAX'
      | 'BOOT_ERR_DSL_REFERENCE'
      | 'BOOT_ERR_DSL_DUPLICATE_BOUNDARY'
      | 'BOOT_ERR_CONTRACT_BIND'
      | 'BOOT_ERR_CONTRACT_LOAD'
      | 'BOOT_ERR_BASELINE_HYDRATION'
      | 'BOOT_ERR_SCHEMA_MISSING'
      | 'BOOT_ERR_SCHEMA_UNSUPPORTED'
      | 'BOOT_ERR_DSL_SCHEMA_VIOLATION'
      | 'BOOT_ERR_DSL_EMIT_REQUIRED'
      | string,
    message: string,
    details?: JsonValue,
  ) {
    super(message, details);
    this.code = code;
  }
}

export class ContractViolationError extends SimError {
  readonly status = 400 as const;
  readonly code = 'CONTRACT_VIOLATION' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

export class EntityAbsenceError extends SimError {
  readonly status = 404 as const;
  readonly code = 'ENTITY_ABSENCE' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

export class EntityConflictError extends SimError {
  readonly status = 409 as const;
  readonly code = 'ENTITY_CONFLICT' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

export class UnhandledOperationError extends SimError {
  readonly status = 422 as const;
  readonly code = 'UNHANDLED_OPERATION' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

export class ConcurrencyConflictError extends SimError {
  readonly status = 412 as const;
  readonly code = 'CONCURRENCY_CONFLICT' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

export class MissingPreconditionError extends SimError {
  readonly status = 428 as const;
  readonly code = 'MISSING_PRECONDITION' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

/**
 * Internal execution failure (HTTP 500).
 *
 * Sub-codes carried in `details.code`:
 *  - `SCHEMA_PATH_UNKNOWN`  — a runtime assign/append path does not exist in the entity schema.
 *  - `SCHEMA_TYPE_MISMATCH` — a runtime value is not assignable to the schema at the target path.
 */
export class InternalExecutionError extends SimError {
  readonly status = 500 as const;
  readonly code = 'INTERNAL_EXECUTION_ERROR' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

export class InfiniteLoopError extends SimError {
  readonly status = 508 as const;
  readonly code = 'INFINITE_LOOP' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

/**
 * Per-UoW reaction event budget exhausted (HTTP 508).
 *
 * Thrown when a genuinely unbounded distinct-aggregate fan-out exceeds the
 * configurable event budget (`max_uow_events`, default 1000). The fired-set
 * dedup handles cycles; this is the backstop for legitimate unbounded breadth.
 */
export class ReactionBudgetExceededError extends SimError {
  readonly status = 508 as const;
  readonly code = 'REACTION_BUDGET_EXCEEDED' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

/**
 * Actor is required for a scoped behavior but was not present in the request (HTTP 401).
 * code: 'AUTH_MISSING'
 */
export class AuthenticationRequiredError extends SimError {
  readonly status = 401 as const;
  readonly code = 'AUTH_MISSING' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

/**
 * Actor's scopes are insufficient for the matched behavior (HTTP 403).
 * code: 'AUTH_INSUFFICIENT_SCOPES'
 */
export class AuthorizationDeniedError extends SimError {
  readonly status = 403 as const;
  readonly code = 'AUTH_INSUFFICIENT_SCOPES' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

/**
 * Idempotency key reused with a different request body (HTTP 409).
 * code: 'IDEMPOTENCY_KEY_CONFLICT'
 */
export class IdempotencyConflictError extends SimError {
  readonly status = 409 as const;
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

/**
 * Invalid public Potemkin configuration supplied by a TypeScript caller.
 *
 * Configuration validation happens before a runtime exists, so this is a
 * structured authoring error rather than an HTTP error. `details.field`
 * identifies the invalid configuration member when one is available.
 */
export class ConfigurationError extends SimError {
  readonly code = 'CONFIG_INVALID' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

/** A deterministic export could not produce a contract-valid example. */
export class ExportError extends SimError {
  readonly code = 'EXPORT_INVALID' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

/** The configured in-memory session capacity has been reached. */
export class SessionLimitError extends SimError {
  readonly status = 429 as const;
  readonly code = 'SESSION_LIMIT_EXCEEDED' as const;
  readonly maxSessions: number;

  constructor(
    maxSessions: number,
    message = `Session limit of ${maxSessions} reached; cannot create a new session`,
  ) {
    super(message, { maxSessions });
    this.maxSessions = maxSessions;
  }
}

export function isConfigurationError(error: unknown): error is ConfigurationError {
  return error instanceof ConfigurationError;
}

export class FaultSimulatedError extends SimError {
  readonly code = 'FAULT_SIMULATED' as const;
  readonly status: number;
  readonly simulatedBody: JsonValue;
  readonly simulatedHeaders?: Record<string, string>;

  constructor(
    status: number,
    body: JsonValue,
    headers?: Record<string, string>,
    details?: JsonValue,
  ) {
    super(`Fault simulated: HTTP ${status}`, details);
    this.status = status;
    this.simulatedBody = body;
    this.simulatedHeaders = headers;
  }

  /**
   * Returns the simulated body directly — matching the shape the gateway emits.
   * The gateway calls `res.status(err.status).json(err.simulatedBody)`, so toJSON()
   * must return the same value (the simulated body only, no envelope wrapper).
   *
   * This intentionally diverges from the envelope shape `{ name, code, message, details }`
   * used by all other SimError subclasses; FaultSimulatedError's semantics are different —
   * it exists solely to pass through a canned response body on behalf of the caller.
   */
  override toJSON(): Record<string, unknown> {
    return this.simulatedBody !== null &&
      typeof this.simulatedBody === 'object' &&
      !Array.isArray(this.simulatedBody)
      ? isJsonObject(this.simulatedBody)
        ? this.simulatedBody
        : { body: this.simulatedBody }
      : { body: this.simulatedBody };
  }
}
