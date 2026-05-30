import type { OpenApiDoc } from '../contract/loader.js';
import type { CompiledDsl } from './types.js';
import { BootError } from '../errors.js';

/**
 * Collect the set of every operationId declared anywhere in the OpenAPI document.
 */
function collectOperationIds(openapi: OpenApiDoc): Set<string> {
  const ids = new Set<string>();
  for (const pathItem of Object.values(openapi.paths)) {
    for (const op of Object.values(pathItem)) {
      if (op?.operationId) ids.add(op.operationId);
    }
  }
  return ids;
}

/**
 * Boot-time validation: every behavior's match.operationId must reference an
 * operationId that actually exists in the OpenAPI contract.
 *
 * @throws {BootError} BOOT_ERR_UNKNOWN_OPERATION_ID — a behavior references an
 *   operationId absent from the OpenAPI spec.
 */
export function validateBehaviorOperationIds(dsl: CompiledDsl, openapi: OpenApiDoc): void {
  const known = collectOperationIds(openapi);
  for (const boundary of dsl.boundaries) {
    for (const behavior of boundary.behaviors) {
      const operationId = behavior.match.operationId;
      if (!known.has(operationId)) {
        throw new BootError(
          'BOOT_ERR_UNKNOWN_OPERATION_ID',
          `Boundary '${boundary.boundary}' behavior '${behavior.name}' references match.operationId '${operationId}' which is not declared in the OpenAPI spec`,
          { boundary: boundary.boundary, behavior: behavior.name, operationId },
        );
      }
      // Cascade (dispatch_commands) target operationIds must also be real operations.
      for (const spec of behavior.dispatchCommands ?? []) {
        if (!known.has(spec.operationId)) {
          throw new BootError(
            'BOOT_ERR_UNKNOWN_OPERATION_ID',
            `Boundary '${boundary.boundary}' behavior '${behavior.name}' dispatches to operationId '${spec.operationId}' which is not declared in the OpenAPI spec`,
            { boundary: boundary.boundary, behavior: behavior.name, operationId: spec.operationId },
          );
        }
      }
    }
  }
}
