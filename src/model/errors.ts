import { StructuredError } from '../errors.js';
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

export class RuntimeModelError extends StructuredError<RuntimeModelDiagnosticCode> {
  readonly code: RuntimeModelDiagnosticCode;

  constructor(code: RuntimeModelDiagnosticCode, message: string, details?: JsonValue) {
    super(message, details);
    this.code = code;
  }
}
