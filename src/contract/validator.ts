import type { JsonObject, JsonValue } from '../types.js';
import type { OpenApiDoc } from './loader.js';
import type { BoundaryConfig } from '../dsl/types.js';

export interface ContractValidator {
  /**
   * Validate an inbound request payload and query/path params against the OpenAPI spec.
   * @throws {ContractViolationError} (400) on failure.
   */
  validateRequest(
    method: string,
    path: string,
    payload: JsonValue,
    queryParams: Record<string, string | string[]>,
    pathParams: Record<string, string>,
  ): void;

  /**
   * Validate an outbound response body against the OpenAPI spec.
   * @throws {InternalExecutionError} (500) on failure.
   */
  validateResponse(
    method: string,
    path: string,
    status: number,
    body: JsonValue,
  ): void;

  /**
   * Validate a state-graph entity against the schema for its boundary.
   * @throws {InternalExecutionError} (500) on failure.
   */
  validateEntity(boundary: string, entity: JsonObject): void;
}

/**
 * Create a ContractValidator backed by the given OpenAPI document and boundary configs.
 */
export function createContractValidator(
  doc: OpenApiDoc,
  boundaries: readonly BoundaryConfig[],
): ContractValidator {
  throw new Error('NotImplemented: contract/validator.createContractValidator');
}
