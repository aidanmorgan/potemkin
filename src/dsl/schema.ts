import { BootError } from '../errors.js';
import type { BoundaryConfig } from './types.js';

/**
 * Validate a raw (unknown) object against the BoundaryConfig schema.
 * @throws {BootError} with code `BOOT_ERR_DSL_SYNTAX` if the shape is invalid.
 */
export function validateBoundaryConfig(raw: unknown): BoundaryConfig {
  throw new Error('NotImplemented: dsl/schema.validateBoundaryConfig');
}
