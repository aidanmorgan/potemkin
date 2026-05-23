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
}

// Boot-time error — no HTTP status (thrown before server starts)
export class BootError extends SimError {
  readonly code: string;

  constructor(
    code:
      | 'BOOT_ERR_DSL_SYNTAX'
      | 'BOOT_ERR_CONTRACT_BIND'
      | 'BOOT_ERR_CONTRACT_LOAD'
      | 'BOOT_ERR_BASELINE_HYDRATION'
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
