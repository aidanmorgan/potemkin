import type { JsonValue } from './types.js';

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

  /**
   * Reconstruct the correct SimError subclass from a plain JSON object (e.g., after
   * JSON.parse). Discriminates on the `code` field. Returns null if the code is
   * unrecognised. instanceof is preserved for reconstructed instances.
   *
   * Note: FaultSimulatedError requires extra fields (status, simulatedBody) in the
   * JSON payload for meaningful reconstruction; without them defaults are used.
   */
  static fromJSON(json: Record<string, unknown>): SimError | null {
    const code = json['code'];
    const message = typeof json['message'] === 'string' ? json['message'] : String(code ?? 'unknown');
    const details = (json['details'] as JsonValue | undefined) ?? undefined;

    switch (code) {
      case 'CONTRACT_VIOLATION': return new ContractViolationError(message, details);
      case 'ENTITY_ABSENCE': return new EntityAbsenceError(message, details);
      case 'ENTITY_CONFLICT': return new EntityConflictError(message, details);
      case 'UNHANDLED_OPERATION': return new UnhandledOperationError(message, details);
      case 'CONCURRENCY_CONFLICT': return new ConcurrencyConflictError(message, details);
      case 'MISSING_PRECONDITION': return new MissingPreconditionError(message, details);
      case 'INTERNAL_EXECUTION_ERROR': return new InternalExecutionError(message, details);
      case 'INFINITE_LOOP': return new InfiniteLoopError(message, details);
      case 'FAULT_SIMULATED': {
        const status = typeof json['status'] === 'number' ? json['status'] : 500;
        const simulatedBody = (json['simulatedBody'] as JsonValue | undefined) ?? null;
        const simulatedHeaders = (json['simulatedHeaders'] as Record<string, string> | undefined);
        return new FaultSimulatedError(status, simulatedBody, simulatedHeaders, details);
      }
      case 'STUB_NOT_FOUND': return new StubNotFoundError(message, details);
      case 'STUB_VALIDATION_FAILED': return new StubValidationFailedError(message, details);
      case 'STUB_BODY_INVALID': return new StubBodyInvalidError(message, details);
      case 'AUTH_MISSING': return new AuthenticationRequiredError(message, details);
      case 'AUTH_INSUFFICIENT_SCOPES': return new AuthorizationDeniedError(message, details);
      case 'IDEMPOTENCY_KEY_CONFLICT': return new IdempotencyConflictError(message, details);
      default: return null;
    }
  }
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
      | 'BOOT_ERR_SCRIPT_SYNTAX'
      | 'BOOT_ERR_SCRIPT_IN_REDUCER'
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
 * Stub not found (HTTP 404).
 * Raised when /_specmatic/expectations/:id targets a non-existent id.
 * `details.code` = 'STUB_NOT_FOUND'.
 */
export class StubNotFoundError extends SimError {
  readonly status = 404 as const;
  readonly code = 'STUB_NOT_FOUND' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

/**
 * Stub response body fails OpenAPI contract validation (HTTP 400).
 * `details.code` = 'STUB_VALIDATION_FAILED'.
 */
export class StubValidationFailedError extends SimError {
  readonly status = 400 as const;
  readonly code = 'STUB_VALIDATION_FAILED' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

/**
 * Stub request body is malformed / cannot be parsed (HTTP 400).
 * `details.code` = 'STUB_BODY_INVALID'.
 */
export class StubBodyInvalidError extends SimError {
  readonly status = 400 as const;
  readonly code = 'STUB_BODY_INVALID' as const;

  constructor(message: string, details?: JsonValue) {
    super(message, details);
  }
}

// ── Tier-2 errors ─────────────────────────────────────────────────────────────

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

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      status: this.status,
      simulatedBody: this.simulatedBody,
      simulatedHeaders: this.simulatedHeaders,
    };
  }
}
