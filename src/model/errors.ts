import type { JsonValue } from '../contracts/value.js';

/** Stable diagnostics emitted while validating the source-independent model. */
export type RuntimeModelDiagnosticCode =
  | 'RUNTIME_BOUNDARY_CONFLICT'
  | 'RUNTIME_EVENT_REFERENCE_INVALID'
  | 'RUNTIME_DISPATCH_REFERENCE_INVALID'
  | 'RUNTIME_REACTION_REFERENCE_INVALID'
  | 'RUNTIME_SAGA_REFERENCE_INVALID'
  | 'RUNTIME_HELPER_CONFLICT'
  | 'RUNTIME_LATENCY_INVALID'
  | 'RUNTIME_BUILDER_INVALID';

export class RuntimeModelError extends Error {
  readonly code: RuntimeModelDiagnosticCode;
  readonly details?: JsonValue;

  constructor(code: RuntimeModelDiagnosticCode, message: string, details?: JsonValue) {
    super(message);
    this.name = 'RuntimeModelError';
    this.code = code;
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
